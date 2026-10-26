import {
  branchExists,
  checkoutNonCommit,
  checkoutStartPointNotCommit,
  invalidOption,
  pathspecNoMatch,
  revparseUnresolved,
} from '../../domain/commands/error.js';
import { errorDataCode } from '../../domain/error-data-code.js';
import type { GitIndex, IndexEntry } from '../../domain/git-index/index.js';
import {
  escapedPathOf,
  type IndexPath,
  type IndexPathKey,
  indexPathKey,
} from '../../domain/git-index/index-path-key.js';
import {
  FILE_MODE,
  type FileMode,
  type FilePath,
  type ObjectId,
  type RefName,
  zeroOid,
} from '../../domain/objects/index.js';
import { validateRefName } from '../../domain/refs/index.js';
import { HEADS_PREFIX } from '../../domain/refs/ref-prefixes.js';
import type { Context } from '../../ports/context.js';
import type { CheckoutMetadata } from '../primitives/internal/apply-smudge-filter.js';
import { withFilterProcessPool } from '../primitives/internal/filter-process-pool.js';
import type { IndexLock } from '../primitives/internal/index-lock.js';
import { peelChain, tagHop } from '../primitives/internal/peel-chain.js';
import type { HeadState } from '../primitives/internal/repo-state.js';
import type { IsVerified } from '../primitives/internal/smudge-racily-clean.js';
import { materializeTree } from '../primitives/materialize-tree.js';
import { assertEverySourceLoadable } from '../primitives/object-store.js';
import { indexPath } from '../primitives/path-layout.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { loadSparseMatcher } from '../primitives/read-sparse-checkout.js';
import { readTree } from '../primitives/read-tree.js';
import { getRefStore } from '../primitives/ref-store.js';
import {
  refResolvesForReading,
  resolveRef,
  resolveRefForReading,
  resolveRefOrMissing,
} from '../primitives/resolve-ref.js';
import { runInformationalHook } from '../primitives/run-hook.js';
import { synthesizeTreeFromIndex } from '../primitives/synthesize-tree-from-index.js';
import { walkTreeWithLossyBytes } from '../primitives/walk-tree.js';
import { type BranchTrack, branchCreate } from './branch.js';
import { removeBranchState } from './internal/branch-state.js';
import { checkoutMetadataFor } from './internal/checkout-metadata.js';
import { acquireIndexLock } from './internal/index-update.js';
import {
  type CommandPathspec,
  type PositivePathspec,
  resolveCommandPathspec,
  trackPositives,
  unmatchedPositives,
} from './internal/pathspec-intake.js';
import { BRANCH_FLAG, FILE_FLAG } from './internal/post-checkout.js';
import { interpretBranchName, previousCheckoutArg } from './internal/prior-checkout.js';
import { refreshedIndex } from './internal/refresh-index.js';
import {
  assertOperationalRepository,
  readHeadRaw,
  requireWorkTree,
} from './internal/repo-state.js';
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

const isSwitch = (opts: CheckoutOptions): opts is CheckoutSwitchOptions =>
  'rev' in opts && opts.rev !== undefined;
const isPaths = (opts: CheckoutOptions): opts is CheckoutPathsOptions =>
  'paths' in opts && opts.paths !== undefined;

/** A branch a switch attaches to, and the object that one read found it naming. */
interface HeldBranch {
  readonly ref: RefName;
  readonly id: ObjectId;
}

/**
 * git's own branch-argument parse reads `refs/heads/<arg>` before anything else:
 * a name a branch carries keeps the switch on that branch, and only that.
 * `undefined` for a name that does not format as a refname either — git's own
 * `check_refname_format` gate before the same read.
 */
const branchFor = async (ctx: Context, rev: string): Promise<HeldBranch | undefined> => {
  const ref = formattedBranchRef(rev);
  if (ref === undefined) return undefined;
  // git's `refs_read_ref`: a dangling or broken branch is no branch to attach to.
  const id = await resolveRefForReading(ctx, ref);
  return id === undefined ? undefined : { ref, id };
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

/** git's `get_oid_mb`: the name through the ref ladder, else the whole revision grammar. */
const resolveSwitchTarget = async (ctx: Context, arg: string): Promise<ObjectId | undefined> =>
  (await resolveRevisionName(ctx, arg)) ?? resolveRevisionExpression(ctx, arg);

/**
 * A switch argument no revision answers: git hands it on as a pathspec, which
 * matches nothing — or, under `-b`, names a start point no branch can come from.
 */
const unresolvedSwitch = (opts: CheckoutSwitchOptions) =>
  opts.createBranch === undefined
    ? pathspecNoMatch(opts.rev)
    : checkoutStartPointNotCommit(opts.rev, opts.createBranch.name);

/** What a switch argument names: its spelling, the branch it attaches to, and the object. */
interface SwitchTarget {
  readonly arg: string;
  readonly branchName: string;
  readonly onBranch: RefName | undefined;
  readonly object: ObjectId;
}

/** git's `parse_branchname_arg`: the branch `refs/heads/<arg>` names, else the revision ladder. */
const resolveSwitch = async (ctx: Context, opts: CheckoutSwitchOptions): Promise<SwitchTarget> => {
  const arg = previousCheckoutArg(opts.rev);
  const named = await resolveSwitchTarget(ctx, arg);
  const branchName = await interpretBranchName(ctx, arg);
  const branch = await branchFor(ctx, branchName);
  if (branch !== undefined) return { arg, branchName, onBranch: branch.ref, object: branch.id };
  if (named === undefined) throw unresolvedSwitch(opts);
  return { arg, branchName, onBranch: undefined, object: named };
};

/**
 * git's `lookup_commit_reference_gently`: the commit the object peels to, or
 * `undefined` for a tree — a blob or other non-tree-ish refuses here, as git's
 * `unable to read tree` does before any branch is validated.
 */
const switchCommit = async (ctx: Context, object: ObjectId): Promise<ObjectId | undefined> => {
  const { id, result } = await peelChain(ctx, object, readObject, tagHop);
  if (result.type === 'commit') return id;
  await readTree(ctx, object);
  return undefined;
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

/**
 * git's two-way merge compares against HEAD's tree. A forced switch resets instead, and an index
 * that was never written is an initial checkout: its absent paths are not staged deletions.
 */
const headTreeOption = async (
  ctx: Context,
  opts: CheckoutSwitchOptions,
  currentIndex: GitIndex,
  oldOid: ObjectId,
): Promise<{ readonly headTree?: ObjectId }> => {
  if (opts.force === true) return {};
  const unborn =
    currentIndex.entries.length === 0 && !(await ctx.fs.exists(indexPath(ctx.layout.gitDir)));
  return unborn ? {} : { headTree: (await readTree(ctx, oldOid)).id };
};

/** git's `reset_tree`: a forced switch rewrites every stale entry and drops a conflict the target lacks. */
const FORCED_RESET = { forceRewriteAll: true, unmergedPaths: 'reset' } as const;

interface SwitchRequest {
  readonly opts: CheckoutSwitchOptions;
  readonly targetTree: ObjectId;
  readonly branchName: string;
  readonly oid: ObjectId;
  readonly oldOid: ObjectId;
  readonly matcher: Awaited<ReturnType<typeof loadSparseMatcher>>;
}

interface SwitchIndex {
  readonly currentIndex: GitIndex;
  readonly verified?: IsVerified;
}

/** An unforced switch starts from git's refreshed index; a forced one rewrites stale entries itself. */
const indexForSwitch = async (
  ctx: Context,
  opts: CheckoutSwitchOptions,
  read: GitIndex,
): Promise<SwitchIndex> => {
  if (opts.force === true) return { currentIndex: read };
  const { currentIndex, verified } = await refreshedIndex(ctx, read);
  return { currentIndex, verified };
};

/**
 * Acquire the index lock BEFORE reading the index. Wrapping the entire
 * read-materialise-commit sequence in the lock closes the TOCTOU window
 * where a concurrent index writer could otherwise stale the donor map
 * between readIndex and lock.commit.
 */
const materializeSwitch = async (
  ctx: Context,
  request: SwitchRequest,
): Promise<Awaited<ReturnType<typeof materializeTree>>> => {
  const { opts, matcher } = request;
  const lock = await acquireIndexLock(ctx);
  try {
    const read = await readIndex(ctx);
    // git's `merge_working_tree`: only a forced switch may discard a conflict.
    if (opts.force !== true) rejectUnmergedIndex(read.entries);
    const { currentIndex, verified } = await indexForSwitch(ctx, opts, read);
    const result = await materializeTree(ctx, {
      targetTree: request.targetTree,
      currentIndex,
      force: opts.force ?? false,
      ...(opts.force === true ? FORCED_RESET : {}),
      checkoutMetadata: await checkoutMetadataFor(ctx, request.branchName, request.oid),
      ...(await headTreeOption(ctx, opts, currentIndex, request.oldOid)),
      // `exactOptionalPropertyTypes`: add `sparse` only when a matcher exists.
      ...(matcher !== undefined ? { sparse: matcher } : {}),
    });
    // Commit the index unconditionally. A no-op switch re-writes byte-identical
    // bytes (harmless). Critically, a *sparse* switch can change excluded
    // entries' ids — a skip-worktree file that differs between branches —
    // while `written`/`deleted` are both 0; guarding the commit on those
    // counts would leave a stale index that the next commit serialises wrong.
    await lock.commit(
      result.newIndexEntries,
      'replace',
      verified === undefined ? {} : { verified },
    );
    return result;
  } finally {
    await lock.release();
  }
};

/** git's update_refs_for_switch: a bare HEAD name moves nothing. */
const HEAD_SPELLINGS: ReadonlySet<string> = new Set(['HEAD', '@']);
const staysOnHead = (opts: CheckoutSwitchOptions): boolean =>
  HEAD_SPELLINGS.has(opts.rev) && opts.detach !== true && opts.createBranch === undefined;

interface SwitchFinish {
  readonly opts: CheckoutSwitchOptions;
  readonly priorHead: HeadState;
  readonly branchName: string;
  readonly arg: string;
  readonly branchRef: RefName | undefined;
  readonly oid: ObjectId;
  readonly oldOid: ObjectId;
  readonly changedPaths: number;
}

/** The branch HEAD already names: where a bare `HEAD` stays. */
const attachedBranch = (head: HeadState): RefName | undefined =>
  head.kind === 'symbolic' && head.target.startsWith(HEADS_PREFIX) ? head.target : undefined;

/** Moves HEAD, clears branch state and announces the switch; a bare `HEAD` moves nothing. */
const finishSwitch = async (ctx: Context, finish: SwitchFinish): Promise<CheckoutResult> => {
  const { opts, priorHead, branchName, oid, oldOid } = finish;
  // git creates a `-b` branch only once the work tree has moved, then attaches HEAD to it.
  const created = await createRequestedBranch(ctx, opts, finish.arg);
  const stays = staysOnHead(opts);
  const attached = stays ? attachedBranch(priorHead) : (created ?? finish.branchRef);
  if (!stays) {
    // git echoes the argument it was handed, abbreviated or not.
    const label = opts.createBranch?.name ?? branchName;
    const message = `checkout: moving from ${headCheckoutLabel(priorHead, oldOid)} to ${label}`;
    await moveHead(ctx, { attached, oid, oldOid, message });
  }
  await removeBranchState(ctx, 'announce');
  // post-checkout (informational) fires after the worktree + HEAD are updated;
  // a branch checkout (changing branches / detaching) flags `1`.
  await runInformationalHook(ctx, 'post-checkout', { args: [oldOid, oid, BRANCH_FLAG] });
  return {
    branch: attached,
    id: oid,
    detached: attached === undefined,
    changedPaths: finish.changedPaths,
  };
};

const switchBranch = async (ctx: Context, opts: CheckoutSwitchOptions): Promise<CheckoutResult> => {
  const priorHead = await readHeadRaw(ctx);
  if (priorHead.kind !== 'symbolic') await assertEverySourceLoadable(ctx);
  const oldOid = await resolveRef(ctx, 'HEAD' as RefName);
  // The branch lookup runs whatever `detach` says — git reads
  // `refs/heads/<arg>` before its revision ladder either way, and only the
  // ATTACH decision consults the flag. A name no branch carries detaches, as
  // git's own fallback does: a tag, a remote-tracking path or an object id.
  // git names the argument through `get_oid_mb` first, branch or not — its
  // warnings and its read of core.warnAmbiguousRefs happen either way.
  const { arg, branchName, onBranch, object } = await resolveSwitch(ctx, opts);
  const commitId = await switchCommit(ctx, object);
  await assertBranchCreatable(ctx, opts);
  if (commitId === undefined) throw checkoutNonCommit(arg);
  const oid = commitId;
  const detached = opts.detach === true || onBranch === undefined;
  const branchRef = detached ? undefined : onBranch;

  // Read target tree — git objects are content-addressed and immutable, so
  // this can happen outside the index lock without risk.
  const target = await readTree(ctx, oid);

  // A defined matcher (`core.sparseCheckout` on) restricts the branch switch
  // to in-pattern files; out-of-pattern entries get the skip-worktree bit.
  // `undefined` ⇒ sparse inactive — the materialize call stays as-is.
  const matcher = await loadSparseMatcher(ctx);

  const materializeResult = await materializeSwitch(ctx, {
    opts,
    targetTree: target.id,
    branchName,
    oid,
    oldOid,
    matcher,
  });

  return finishSwitch(ctx, {
    opts,
    priorHead,
    branchName,
    arg,
    branchRef,
    oid,
    oldOid,
    changedPaths: materializeResult.written + materializeResult.deleted,
  });
};

/** A path of the restore universe with the content the restore would write. */
type SourceEntry = IndexPath & { readonly mode: FileMode; readonly id: ObjectId };

interface PathSource {
  readonly tree: ObjectId;
  readonly metadata: CheckoutMetadata;
}

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
  const { id, result } = await peelChain(ctx, named, readObject, tagHop);
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
  const pathspec = resolveCommandPathspec(ctx, opts.paths);

  const materializeResult = await restoreUnderIndexLock(ctx, source, pathspec);

  // HEAD unchanged. An unborn HEAD reports the null oid, as git hands its hook.
  const head = (await resolveRefOrMissing(ctx, 'HEAD')) ?? zeroOid(ctx.hashConfig);
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

type MaterializeResult = Awaited<ReturnType<typeof materializeTree>>;

// Takes the index lock and reads the index before the pathspec is judged, as
// git's `checkout_paths` does: a held lock or a corrupt index refuses first.
const restoreUnderIndexLock = async (
  ctx: Context,
  source: PathSource | undefined,
  pathspec: CommandPathspec,
): Promise<MaterializeResult> => {
  const lock = await acquireIndexLock(ctx);
  try {
    const currentIndex = await readIndex(ctx);
    const universe = await restorableUniverse(ctx, source, currentIndex);
    const { matched, unmatched } = selectFromUniverse(pathspec, universe);
    refuseUnmatched(unmatched);
    const pathSet = new Set<FilePath>(matched.map(escapedPathOf));
    if (source === undefined) refuseMatchedUnmerged(currentIndex, pathSet);
    return source === undefined
      ? await materializePathRestoreFromIndex(ctx, lock, currentIndex, pathSet)
      : await materializePathRestoreLocked(ctx, lock, currentIndex, source, pathSet);
  } finally {
    await lock.release();
  }
};

// git's checkout_paths: a matched unmerged entry refuses the whole restore
// before anything is written; a tree source replaces the stages instead.
const refuseMatchedUnmerged = (currentIndex: GitIndex, pathSet: ReadonlySet<FilePath>): void =>
  rejectUnmergedIndex(currentIndex.entries.filter((entry) => pathSet.has(escapedPathOf(entry))));

// Git's checkout_paths skips a skip-worktree entry before it matches the
// pathspec, so a path only they name is refused like any unknown one. A tree
// source keeps the entry whose (mode, id) differs from the index's: update_some
// replaces it with a fresh entry that has no bit, and the restore writes it.
const restorableUniverse = async (
  ctx: Context,
  source: PathSource | undefined,
  currentIndex: GitIndex,
): Promise<ReadonlyArray<SourceEntry>> => {
  const skipped = new Map<IndexPathKey, IndexEntry>(
    currentIndex.entries
      .filter((entry) => entry.flags.skipWorktree)
      .map((entry) => [indexPathKey(entry), entry]),
  );
  const universe = await enumerateSourcePaths(ctx, source, currentIndex);
  return universe.filter(
    (entry) => !isUnchangedSkipWorktree(skipped.get(indexPathKey(entry)), entry),
  );
};

const isUnchangedSkipWorktree = (
  indexed: IndexEntry | undefined,
  candidate: SourceEntry,
): boolean =>
  indexed !== undefined && indexed.mode === candidate.mode && indexed.id === candidate.id;

// One matcher pass over the universe: what the spec selects, and which
// positives nothing reached, so the refusal needs no second scan.
const selectFromUniverse = (
  { matcher, positives }: CommandPathspec,
  universe: ReadonlyArray<IndexPath>,
): { readonly matched: IndexPath[]; readonly unmatched: ReadonlyArray<PositivePathspec> } => {
  const tracker = trackPositives(matcher, positives);
  const matched = universe.filter((entry) => tracker.observe(escapedPathOf(entry)).matched);
  return {
    matched,
    unmatched: unmatchedPositives(positives, (positive) => tracker.seen(positive)),
  };
};

// Every positive pathspec must name something in the source universe; git
// reports each unmatched one, and so does the error.
const refuseUnmatched = (unmatched: ReadonlyArray<PositivePathspec>): void => {
  const [first, ...rest] = unmatched;
  if (first === undefined) return;
  throw pathspecNoMatch(first.spelling, ...rest.map((positive) => positive.spelling));
};

// Both restores commit the index under the lock the caller holds (stat
// refreshed for restored entries) and rewrite only the matched entries that
// are stale or differ from the source. They differ in the target tree:
// - 'index' (default): the tree is synthesised from the index snapshot the
//  caller read, so the target tree and the current-index base agree.
// - 'HEAD' | ObjectId: the source's own tree.
const materializePathRestoreFromIndex = async (
  ctx: Context,
  lock: IndexLock,
  currentIndex: GitIndex,
  pathSet: ReadonlySet<FilePath>,
): Promise<MaterializeResult> => {
  const targetTree = await synthesizeTreeFromIndex(ctx, currentIndex.entries);
  const result = await materializeTree(ctx, {
    targetTree,
    currentIndex,
    force: true,
    // The target tree is synthesised FROM the index, so every entry would
    // classify `noop`; the flag lets the stale pass rewrite the matched
    // entries whose work file no longer agrees with the index.
    forceRewriteAll: true,
    paths: pathSet,
  });
  await lock.commit(result.newIndexEntries, 'update');
  return result;
};

const materializePathRestoreLocked = async (
  ctx: Context,
  lock: IndexLock,
  currentIndex: GitIndex,
  source: PathSource,
  pathSet: ReadonlySet<FilePath>,
): Promise<MaterializeResult> => {
  const result = await materializeTree(ctx, {
    targetTree: source.tree,
    currentIndex,
    force: true,
    checkoutMetadata: source.metadata,
    // A matched entry whose work file is stale or differs from the source
    // is rewritten even when the index already records the source content.
    forceRewriteAll: true,
    paths: pathSet,
  });
  // The commit stays unconditional: git writes the index after a restore
  // whether or not an entry was rewritten, and `result.deleted` is always 0.
  await lock.commit(result.newIndexEntries, 'update');
  return result;
};

// Enumerate the flat path universe of the path-restore source so the
// pathspec matcher can be expanded into a concrete `Set<FilePath>`.
// For `'index'`, returns every entry of the index the caller already read. For `'HEAD'` or an
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
  currentIndex: GitIndex,
): Promise<ReadonlyArray<SourceEntry>> => {
  if (source === undefined) return currentIndex.entries;
  const paths: SourceEntry[] = [];
  for await (const entry of walkTreeWithLossyBytes(ctx, source.tree)) {
    // Stryker disable next-line ConditionalExpression: equivalent — directory entries in the universe are unobservable: materializeTree filters DIRECTORY modes itself and matches by exact path, and any pathspec matching a directory also matches its (non-empty) descendant files.
    if (entry.mode !== FILE_MODE.DIRECTORY) paths.push(entry);
  }
  return paths;
};

export const checkout = (ctx: Context, opts: CheckoutOptions): Promise<CheckoutResult> =>
  withFilterProcessPool(ctx, () => checkoutInScope(ctx, opts));

const checkoutInScope = async (ctx: Context, opts: CheckoutOptions): Promise<CheckoutResult> => {
  await assertOperationalRepository(ctx);
  requireWorkTree(ctx, 'checkout');
  assertSingleCheckoutMode(opts);

  ctx.progress.start(CHECKOUT_MATERIALIZE_OP);
  try {
    return isPaths(opts) ? await pathRestore(ctx, opts) : await switchBranch(ctx, opts);
  } finally {
    ctx.progress.end(CHECKOUT_MATERIALIZE_OP);
  }
};

/** Refuses `rev` with `paths`, or neither. */
const assertSingleCheckoutMode = (opts: CheckoutOptions): void => {
  const switchMode = isSwitch(opts);
  const pathsMode = isPaths(opts);
  if (switchMode && pathsMode) {
    throw invalidOption('paths', 'cannot be combined with rev');
  }
  if (!switchMode && !pathsMode) {
    throw invalidOption('rev', 'either rev or paths must be provided');
  }
};
