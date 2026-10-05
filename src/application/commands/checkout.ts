import {
  branchExists,
  branchNotFound,
  invalidOption,
  revparseUnresolved,
} from '../../domain/commands/error.js';
import { errorDataCode } from '../../domain/error-data-code.js';
import {
  FILE_MODE,
  type FilePath,
  type GitObject,
  type ObjectId,
  type RefName,
} from '../../domain/objects/index.js';
import { matchesPathspec } from '../../domain/pathspec/index.js';
import { validateRefName } from '../../domain/refs/index.js';
import { HEADS_PREFIX } from '../../domain/refs/ref-prefixes.js';
import type { Context } from '../../ports/context.js';
import type { CheckoutMetadata } from '../primitives/internal/apply-smudge-filter.js';
import { withFilterProcessPool } from '../primitives/internal/filter-process-pool.js';
import { peelChain } from '../primitives/internal/peel-chain.js';
import type { HeadState } from '../primitives/internal/repo-state.js';
import { materializeTree } from '../primitives/materialize-tree.js';
import { assertEverySourceLoadable } from '../primitives/object-store.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { loadSparseMatcher } from '../primitives/read-sparse-checkout.js';
import { readTree } from '../primitives/read-tree.js';
import { getRefStore } from '../primitives/ref-store.js';
import {
  refResolvesForReading,
  resolveRef,
  resolveRefForReading,
} from '../primitives/resolve-ref.js';
import { runInformationalHook } from '../primitives/run-hook.js';
import { synthesizeTreeFromIndex } from '../primitives/synthesize-tree-from-index.js';
import { walkTree } from '../primitives/walk-tree.js';
import { type BranchTrack, branchCreate } from './branch.js';
import { removeBranchState } from './internal/branch-state.js';
import { checkoutMetadataFor } from './internal/checkout-metadata.js';
import { acquireIndexLock } from './internal/index-update.js';
import { interpretBranchName, previousCheckoutArg } from './internal/prior-checkout.js';
import {
  assertOperationalRepository,
  readHeadRaw,
  requireWorkTree,
} from './internal/repo-state.js';
import { enforceLiteralMustMatch, resolvePathspec } from './internal/resolve-pathspec.js';
import { resolveRevisionExpression } from './internal/revision-expression.js';
import { resolveRevisionName } from './internal/revision-name.js';
import { rejectUnmergedIndex } from './internal/unmerged-index.js';

/** git's `checkout -b <name> [--track|--no-track] <rev>`: create `name` at `rev`, then switch to it. */
export interface CheckoutCreateBranch {
  readonly name: string;
  readonly track?: BranchTrack;
  readonly noTrack?: boolean;
}

export interface CheckoutSwitchOptions {
  readonly rev: string;
  readonly detach?: boolean;
  readonly force?: boolean;
  readonly createBranch?: CheckoutCreateBranch;
}

export interface CheckoutPathsOptions {
  readonly paths: ReadonlyArray<string>;
  /**
   * Where the paths are restored from: `'index'` (the default), or a revision
   * naming a commit or a tree — a branch or tag name, `HEAD`, an object id, a
   * revision expression such as `HEAD~1`.
   */
  readonly source?: 'index' | string;
}

export type CheckoutOptions = CheckoutSwitchOptions | CheckoutPathsOptions;

export interface CheckoutResult {
  readonly branch: RefName | undefined;
  readonly id: ObjectId;
  readonly detached: boolean;
  readonly changedPaths: number;
}

const CHECKOUT_MATERIALIZE_OP = 'checkout:materialize';
const INDEX_SOURCE = 'index';
/** post-checkout's 3rd argument: `1` for a branch checkout, `0` for a file checkout. */
const BRANCH_FLAG = '1';
const FILE_FLAG = '0';

const isSwitch = (opts: CheckoutOptions): opts is CheckoutSwitchOptions =>
  'rev' in opts && opts.rev !== undefined;
const isPaths = (opts: CheckoutOptions): opts is CheckoutPathsOptions =>
  'paths' in opts && opts.paths !== undefined;

/**
 * git's own branch-argument parse reads `refs/heads/<arg>` before anything else:
 * a name a branch carries keeps the switch on that branch, and only that.
 * `undefined` for a name that does not format as a refname either — git's own
 * `check_refname_format` gate before the same read.
 */
const branchRefFor = async (ctx: Context, rev: string): Promise<RefName | undefined> => {
  const name = formattedBranchRef(rev);
  if (name === undefined) return undefined;
  // git's `refs_read_ref`: a dangling or broken branch is no branch to attach to.
  return (await resolveRefForReading(ctx, name)) === undefined ? undefined : name;
};

const INVALID_REF_CODE = 'INVALID_REF';

/** `refs/heads/<rev>` when it formats as a refname, else `undefined`; any other failure propagates. */
const formattedBranchRef = (rev: string): RefName | undefined => {
  try {
    return validateRefName(`${HEADS_PREFIX}${rev}`);
  } catch (error) {
    if (errorDataCode(error) === INVALID_REF_CODE) return undefined;
    throw error;
  }
};

/** The object a switch detaches onto once no branch carries the name: git's
 *  `get_oid_mb` answer over the revision ladder. */
const requireSwitchOid = (id: ObjectId | undefined, rev: string): ObjectId => {
  if (id === undefined) throw branchNotFound(validateRefName(`${HEADS_PREFIX}${rev}`));
  return id;
};

/** git's `old_desc`: the branch HEAD was on, else the full object id it named. */
const headCheckoutLabel = (head: HeadState, oldOid: ObjectId): string =>
  head.kind === 'symbolic' && head.target.startsWith(HEADS_PREFIX)
    ? head.target.slice(HEADS_PREFIX.length)
    : oldOid;

/** git refuses `-b` with `--detach`, and an existing branch name, before the work tree moves. */
const assertBranchCreatable = async (ctx: Context, opts: CheckoutSwitchOptions): Promise<void> => {
  if (opts.createBranch === undefined) return;
  if (opts.detach === true) throw invalidOption('createBranch', 'cannot be combined with detach');
  const name = validateRefName(`${HEADS_PREFIX}${opts.createBranch.name}`);
  if (await refResolvesForReading(ctx, name)) throw branchExists(name);
};

const createRequestedBranch = async (
  ctx: Context,
  opts: CheckoutSwitchOptions,
  startPoint: string,
): Promise<RefName | undefined> => {
  const request = opts.createBranch;
  if (request === undefined) return undefined;
  const created = await branchCreate(ctx, { ...request, startPoint });
  return created.name;
};

interface HeadMove {
  readonly attached: RefName | undefined;
  readonly oid: ObjectId;
  readonly oldOid: ObjectId;
  readonly message: string;
}

const moveHead = (ctx: Context, move: HeadMove): Promise<void> => {
  const reflog = { oldId: move.oldOid, newId: move.oid, message: move.message };
  const update =
    move.attached === undefined
      ? { kind: 'set' as const, name: 'HEAD' as RefName, id: move.oid, reflog }
      : { kind: 'setSymbolic' as const, name: 'HEAD' as RefName, target: move.attached, reflog };
  return getRefStore(ctx).applyRefUpdates([update]);
};

const switchBranch = async (ctx: Context, opts: CheckoutSwitchOptions): Promise<CheckoutResult> => {
  await assertBranchCreatable(ctx, opts);
  const priorHead = await readHeadRaw(ctx);
  if (priorHead.kind !== 'symbolic') await assertEverySourceLoadable(ctx);
  const oldOid = await resolveRef(ctx, 'HEAD' as RefName);
  // The branch lookup runs whatever `detach` says — git reads
  // `refs/heads/<arg>` before its revision ladder either way, and only the
  // ATTACH decision consults the flag. A name no branch carries detaches, as
  // git's own fallback does: a tag, a remote-tracking path or an object id.
  // git names the argument through `get_oid_mb` first, branch or not — its
  // warnings and its read of core.warnAmbiguousRefs happen either way.
  const arg = previousCheckoutArg(opts.rev);
  const named = await resolveRevisionName(ctx, arg);
  const branchName = await interpretBranchName(ctx, arg);
  const onBranch = await branchRefFor(ctx, branchName);
  const detached = opts.detach === true || onBranch === undefined;
  const branchRef = detached ? undefined : onBranch;
  const oid =
    onBranch === undefined ? requireSwitchOid(named, branchName) : await resolveRef(ctx, onBranch);

  // Read target tree — git objects are content-addressed and immutable, so
  // this can happen outside the index lock without risk.
  const target = await readTree(ctx, oid);

  // A defined matcher (`core.sparseCheckout` on) restricts the branch switch
  // to in-pattern files; out-of-pattern entries get the skip-worktree bit.
  // `undefined` ⇒ sparse inactive — the materialize call stays as-is.
  const matcher = await loadSparseMatcher(ctx);

  // Acquire the index lock BEFORE reading the index. Wrapping the entire
  // read-materialise-commit sequence in the lock closes the TOCTOU window
  // where a concurrent index writer could otherwise stale the donor map
  // between readIndex and lock.commit. Matches the prior / 13.3 pattern.
  const lock = await acquireIndexLock(ctx);
  let materializeResult: Awaited<ReturnType<typeof materializeTree>>;
  try {
    const currentIndex = await readIndex(ctx);
    // git's `merge_working_tree`: only a forced switch may discard a conflict.
    if (opts.force !== true) rejectUnmergedIndex(currentIndex.entries);
    materializeResult = await materializeTree(ctx, {
      targetTree: target.id,
      currentIndex,
      force: opts.force ?? false,
      checkoutMetadata: await checkoutMetadataFor(ctx, branchName, oid),
      // `exactOptionalPropertyTypes`: add `sparse` only when a matcher exists.
      ...(matcher !== undefined ? { sparse: matcher } : {}),
    });
    // Commit the index unconditionally. A no-op switch re-writes byte-identical
    // bytes (harmless). Critically, a *sparse* switch can change excluded
    // entries' ids — a skip-worktree file that differs between branches —
    // while `written`/`deleted` are both 0; guarding the commit on those
    // counts would leave a stale index that the next commit serialises wrong.
    await lock.commit(materializeResult.newIndexEntries);
  } finally {
    await lock.release();
  }

  // git creates a `-b` branch only once the work tree has moved, then attaches HEAD to it.
  const created = await createRequestedBranch(ctx, opts, arg);
  const attached = created ?? branchRef;
  // Move HEAD — outside the index lock (HEAD writes are atomic on their own).
  // git echoes the argument it was handed, abbreviated or not.
  const label = opts.createBranch?.name ?? branchName;
  const message = `checkout: moving from ${headCheckoutLabel(priorHead, oldOid)} to ${label}`;
  await moveHead(ctx, { attached, oid, oldOid, message });
  await removeBranchState(ctx, 'announce');
  // post-checkout (informational) fires after the worktree + HEAD are updated;
  // a branch checkout (changing branches / detaching) flags `1`.
  await runInformationalHook(ctx, 'post-checkout', { args: [oldOid, oid, BRANCH_FLAG] });
  return {
    branch: attached,
    id: oid,
    detached: attached === undefined,
    changedPaths: materializeResult.written + materializeResult.deleted,
  };
};

interface PathSource {
  readonly tree: ObjectId;
  readonly metadata: CheckoutMetadata;
}

const peelTag = (object: GitObject): ObjectId | undefined =>
  object.type === 'tag' ? object.data.object : undefined;

/** git dies `invalid reference` naming the revision as given, whatever step of it failed. */
const resolveSourceRevision = async (ctx: Context, rev: string): Promise<ObjectId> => {
  const id = await resolveRevisionExpression(ctx, rev);
  if (id === undefined) throw revparseUnresolved(rev);
  return id;
};

/**
 * git's `<tree-ish> -- <paths>` source: the tree to restore from, and the smudge
 * metadata naming the commit the revision peels to — the named object itself
 * when it is no commit — and the ref it resolves to.
 */
const resolvePathSource = async (ctx: Context, rev: string): Promise<PathSource> => {
  const named = await resolveSourceRevision(ctx, rev);
  const { id, result } = await peelChain(ctx, named, readObject, peelTag);
  const tree = await readTree(ctx, id);
  const treeish = result.type === 'commit' ? id : named;
  return { tree: tree.id, metadata: await checkoutMetadataFor(ctx, rev, treeish) };
};

/** The revision a path restore reads from, or `undefined` for the index. */
const pathSourceFor = (ctx: Context, source: string): Promise<PathSource | undefined> =>
  source === INDEX_SOURCE ? Promise.resolve(undefined) : resolvePathSource(ctx, source);

const pathRestore = async (ctx: Context, opts: CheckoutPathsOptions): Promise<CheckoutResult> => {
  if (opts.paths.length === 0) {
    throw invalidOption('paths', 'must not be empty');
  }
  const source = await pathSourceFor(ctx, opts.source ?? INDEX_SOURCE);
  const { matcher, literalMustMatch, literalSpellings } = resolvePathspec(opts.paths);

  // Enumerate the source's flat path universe so globs (`*.ts`,
  // `src/**`) can be expanded into a concrete `pathSet` for the
  // existing materialise primitives. For `source: 'index'` this reads
  // the index once here; the materialise call below reads it again
  // (snapshot diff is benign — no commit happens on the lockless
  // path). For `source: 'HEAD'` or an ObjectId, walk the tree once.
  const universe: ReadonlyArray<FilePath> = await enumerateSourcePaths(ctx, source);
  const matched = universe.filter((p) => matchesPathspec(matcher, p));
  enforceLiteralMustMatch(literalMustMatch, matched, literalSpellings);
  const pathSet = new Set<FilePath>(matched);

  // Glob with zero matches → no-op (literals already threw above).
  if (pathSet.size === 0) {
    const head = await resolveRef(ctx, 'HEAD' as RefName);
    return { branch: undefined, id: head, detached: false, changedPaths: 0 };
  }

  // Two branches by source:
  // - 'index' (default): no index commit, no lock needed. Read the index
  //  ONCE and share the snapshot between the tree synthesis and the
  //  subsequent diff — otherwise a concurrent writer between the two
  //  reads could leave the target tree and the current-index base
  //  pointing at different snapshots.
  // - 'HEAD' | ObjectId: commits the index. Lock-first ordering applies,
  //  same as.2/13.3 reset paths.
  const materializeResult =
    source === undefined
      ? await materializePathRestoreLockless(ctx, pathSet)
      : await materializePathRestoreLocked(ctx, source, pathSet);

  // HEAD unchanged. Resolve current HEAD for the result.
  const head = await resolveRef(ctx, 'HEAD' as RefName);
  // post-checkout (informational) fires after a file checkout with prev == new
  // HEAD (the restore does not move HEAD) and the file flag.
  await runInformationalHook(ctx, 'post-checkout', { args: [head, head, FILE_FLAG] });
  return {
    branch: undefined,
    id: head,
    detached: false,
    // Stryker disable next-line ArithmeticOperator: equivalent — path-restore always passes `paths: pathSet` to materializeTree, and every `pathSet` member is drawn from the source's own path universe, so the index→target diff can only classify entries as add/update/noop — never delete. `materializeResult.deleted` is therefore always 0, making `written + deleted` and `written - deleted` indistinguishable.
    changedPaths: materializeResult.written + materializeResult.deleted,
  };
};

const materializePathRestoreLockless = async (
  ctx: Context,
  pathSet: ReadonlySet<FilePath>,
): Promise<Awaited<ReturnType<typeof materializeTree>>> => {
  // Read the index ONCE and pass the same snapshot to both synthesis
  // and the diff. A concurrent `git add` between two reads would
  // otherwise produce a mismatch between target-tree and current-index.
  const currentIndex = await readIndex(ctx);
  const targetTree = await synthesizeTreeFromIndex(ctx, currentIndex.entries);
  return materializeTree(ctx, {
    targetTree,
    currentIndex,
    force: true,
    // Path-restore is the explicit "give me this version" operation —
    // canonical git always writes the source content even when the index
    // already matches it. For `source: 'index'` the target tree is
    // synthesised FROM the index, so without this flag every entry would
    // be classified `noop` and nothing would be written.
    forceRewriteAll: true,
    paths: pathSet,
  });
};

const materializePathRestoreLocked = async (
  ctx: Context,
  source: PathSource,
  pathSet: ReadonlySet<FilePath>,
): Promise<Awaited<ReturnType<typeof materializeTree>>> => {
  const lock = await acquireIndexLock(ctx);
  try {
    const currentIndex = await readIndex(ctx);
    const result = await materializeTree(ctx, {
      targetTree: source.tree,
      currentIndex,
      force: true,
      checkoutMetadata: source.metadata,
      // Path-restore from `HEAD` / ObjectId is the explicit
      // "give me this version" operation — canonical git always writes
      // the source content even when the index already records it (so
      // a locally-modified file gets reverted reliably).
      forceRewriteAll: true,
      paths: pathSet,
    });
    // The commit is unconditional here: the L145 guard guarantees a
    // non-empty `pathSet`, the pathspec universe is the source tree itself,
    // and `forceRewriteAll` upgrades every matched entry to a write — so
    // `result.written` is always `pathSet.size` (>= 1) and `result.deleted`
    // is always 0. A `written > 0 || deleted > 0` guard would therefore be
    // dead code (always true), so it is omitted.
    await lock.commit(result.newIndexEntries);
    return result;
  } finally {
    await lock.release();
  }
};

// Enumerate the flat path universe of the path-restore source so the
// pathspec matcher can be expanded into a concrete `Set<FilePath>`.
// For `'index'`, returns every index entry's path. For `'HEAD'` or an
// ObjectId, walks the tree and returns every non-directory entry's
// path.
//
// Bounds: the `'index'` branch inherits `MAX_INDEX_BYTES` (256 MiB)
// from `readIndex`. The tree branch inherits `MAX_FLAT_TREE_ENTRIES`
// (1M) from `walkTree` — exceeding that throws
// `TREE_ENTRY_LIMIT_EXCEEDED` before this function materialises the
// full list.
const enumerateSourcePaths = async (
  ctx: Context,
  source: PathSource | undefined,
): Promise<ReadonlyArray<FilePath>> => {
  if (source === undefined) {
    const index = await readIndex(ctx);
    return index.entries.map((e) => e.path);
  }
  const paths: FilePath[] = [];
  for await (const entry of walkTree(ctx, source.tree)) {
    // Stryker disable next-line ConditionalExpression: equivalent — directory entries in the universe are unobservable: materializeTree filters DIRECTORY modes itself and matches by exact path, and any pathspec matching a directory also matches its (non-empty) descendant files.
    if (entry.mode !== FILE_MODE.DIRECTORY) paths.push(entry.path);
  }
  return paths;
};

export const checkout = (ctx: Context, opts: CheckoutOptions): Promise<CheckoutResult> =>
  withFilterProcessPool(ctx, () => checkoutInScope(ctx, opts));

const checkoutInScope = async (ctx: Context, opts: CheckoutOptions): Promise<CheckoutResult> => {
  await assertOperationalRepository(ctx);
  requireWorkTree(ctx, 'checkout');

  const switchMode = isSwitch(opts);
  const pathsMode = isPaths(opts);
  if (switchMode && pathsMode) {
    throw invalidOption('paths', 'cannot be combined with rev');
  }
  if (!switchMode && !pathsMode) {
    throw invalidOption('rev', 'either rev or paths must be provided');
  }

  ctx.progress.start(CHECKOUT_MATERIALIZE_OP);
  try {
    return pathsMode
      ? await pathRestore(ctx, opts)
      : await switchBranch(ctx, opts as CheckoutSwitchOptions);
  } finally {
    ctx.progress.end(CHECKOUT_MATERIALIZE_OP);
  }
};
