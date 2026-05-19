import { branchNotFound, invalidOption } from '../../domain/commands/error.js';
import {
  FILE_MODE,
  type FilePath,
  type ObjectId,
  type RefName,
} from '../../domain/objects/index.js';
import { matchesPathspec } from '../../domain/pathspec/index.js';
import { validateRefName } from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { materializeTree } from '../primitives/materialize-tree.js';
import { readIndex } from '../primitives/read-index.js';
import { readTree } from '../primitives/read-tree.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { synthesizeTreeFromIndex } from '../primitives/synthesize-tree-from-index.js';
import { walkTree } from '../primitives/walk-tree.js';
import { writeSymbolicRef } from '../primitives/write-symbolic-ref.js';
import { acquireIndexLock } from './internal/index-update.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertRepository,
} from './internal/repo-state.js';
import { enforceLiteralMustMatch, resolvePathspec } from './internal/resolve-pathspec.js';

export interface CheckoutSwitchOptions {
  readonly target: string;
  readonly detach?: boolean;
  readonly force?: boolean;
}

export interface CheckoutPathsOptions {
  readonly paths: ReadonlyArray<string>;
  readonly source?: 'index' | 'HEAD' | ObjectId;
}

export type CheckoutOptions = CheckoutSwitchOptions | CheckoutPathsOptions;

export interface CheckoutResult {
  readonly branch: RefName | undefined;
  readonly id: ObjectId;
  readonly detached: boolean;
  readonly changedPaths: number;
}

const HEADS_PREFIX = 'refs/heads/';
const CHECKOUT_MATERIALIZE_OP = 'checkout:materialize';

const isSwitch = (opts: CheckoutOptions): opts is CheckoutSwitchOptions =>
  'target' in opts && opts.target !== undefined;
const isPaths = (opts: CheckoutOptions): opts is CheckoutPathsOptions =>
  'paths' in opts && opts.paths !== undefined;

const resolveSwitchOid = async (ctx: Context, target: string): Promise<ObjectId> => {
  if (/^[0-9a-f]{40}$/.test(target)) return target as ObjectId;
  return resolveRef(ctx, target as RefName);
};

const switchBranch = async (ctx: Context, opts: CheckoutSwitchOptions): Promise<CheckoutResult> => {
  const detached = opts.detach === true || /^[0-9a-f]{40}$/.test(opts.target);
  let branchRef: RefName | undefined;
  let oid: ObjectId;
  if (detached) {
    oid = await resolveSwitchOid(ctx, opts.target);
  } else {
    branchRef = validateRefName(`${HEADS_PREFIX}${opts.target}`);
    if (!(await ctx.fs.exists(`${ctx.layout.gitDir}/${branchRef}`))) {
      throw branchNotFound(branchRef);
    }
    oid = await resolveRef(ctx, branchRef);
  }

  // Read target tree — git objects are content-addressed and immutable, so
  // this can happen outside the index lock without risk.
  const target = await readTree(ctx, oid);

  // Acquire the index lock BEFORE reading the index. Wrapping the entire
  // read-materialise-commit sequence in the lock closes the TOCTOU window
  // where a concurrent index writer could otherwise stale the donor map
  // between readIndex and lock.commit. Matches the Phase 13.2 / 13.3 pattern.
  const lock = await acquireIndexLock(ctx);
  let materializeResult: Awaited<ReturnType<typeof materializeTree>>;
  try {
    const currentIndex = await readIndex(ctx);
    materializeResult = await materializeTree(ctx, {
      targetTree: target.id,
      currentIndex,
      force: opts.force ?? false,
    });
    if (materializeResult.written > 0 || materializeResult.deleted > 0) {
      await lock.commit(materializeResult.newIndexEntries);
    }
  } finally {
    await lock.release();
  }

  // Move HEAD — outside the index lock (HEAD writes are atomic on their own).
  if (detached) {
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${oid}\n`);
    return {
      branch: undefined,
      id: oid,
      detached: true,
      changedPaths: materializeResult.written + materializeResult.deleted,
    };
  }
  await writeSymbolicRef(ctx, 'HEAD' as RefName, branchRef as RefName);
  return {
    branch: branchRef,
    id: oid,
    detached: false,
    changedPaths: materializeResult.written + materializeResult.deleted,
  };
};

const resolvePathSource = async (ctx: Context, source: 'HEAD' | ObjectId): Promise<ObjectId> => {
  if (source === 'HEAD') {
    const head = await resolveRef(ctx, 'HEAD' as RefName);
    const headTree = await readTree(ctx, head);
    return headTree.id;
  }
  const tree = await readTree(ctx, source);
  return tree.id;
};

const pathRestore = async (ctx: Context, opts: CheckoutPathsOptions): Promise<CheckoutResult> => {
  if (opts.paths.length === 0) {
    throw invalidOption('paths', 'must not be empty');
  }
  const source = opts.source ?? 'index';
  const { matcher, literalMustMatch } = resolvePathspec(opts.paths);

  // Enumerate the source's flat path universe so globs (`*.ts`,
  // `src/**`) can be expanded into a concrete `pathSet` for the
  // existing materialise primitives. For `source: 'index'` this reads
  // the index once here; the materialise call below reads it again
  // (snapshot diff is benign — no commit happens on the lockless
  // path). For `source: 'HEAD'` or an ObjectId, walk the tree once.
  const universe: ReadonlyArray<FilePath> = await enumerateSourcePaths(ctx, source);
  const matched = universe.filter((p) => matchesPathspec(matcher, p));
  enforceLiteralMustMatch(literalMustMatch, matched);
  const pathSet = new Set<FilePath>(matched);

  // Glob with zero matches → no-op (literals already threw above).
  if (pathSet.size === 0) {
    const head = await resolveRef(ctx, 'HEAD' as RefName);
    return { branch: undefined, id: head, detached: false, changedPaths: 0 };
  }

  // Two branches by source:
  // - 'index' (default): no index commit, no lock needed. Read the index
  //   ONCE and share the snapshot between the tree synthesis and the
  //   subsequent diff — otherwise a concurrent writer between the two
  //   reads could leave the target tree and the current-index base
  //   pointing at different snapshots.
  // - 'HEAD' | ObjectId: commits the index. Lock-first ordering applies,
  //   same as Phase 13.2/13.3 reset paths.
  const materializeResult =
    source === 'index'
      ? await materializePathRestoreLockless(ctx, pathSet)
      : await materializePathRestoreLocked(ctx, await resolvePathSource(ctx, source), pathSet);

  // HEAD unchanged. Resolve current HEAD for the result.
  const head = await resolveRef(ctx, 'HEAD' as RefName);
  return {
    branch: undefined,
    id: head,
    detached: false,
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
  targetTree: ObjectId,
  pathSet: ReadonlySet<FilePath>,
): Promise<Awaited<ReturnType<typeof materializeTree>>> => {
  const lock = await acquireIndexLock(ctx);
  try {
    const currentIndex = await readIndex(ctx);
    const result = await materializeTree(ctx, {
      targetTree,
      currentIndex,
      force: true,
      // Path-restore from `HEAD` / ObjectId is the explicit
      // "give me this version" operation — canonical git always writes
      // the source content even when the index already records it (so
      // a locally-modified file gets reverted reliably).
      forceRewriteAll: true,
      paths: pathSet,
    });
    if (result.written > 0 || result.deleted > 0) {
      await lock.commit(result.newIndexEntries);
    }
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
  source: 'index' | 'HEAD' | ObjectId,
): Promise<ReadonlyArray<FilePath>> => {
  if (source === 'index') {
    const index = await readIndex(ctx);
    return index.entries.map((e) => e.path);
  }
  const treeId = await resolvePathSource(ctx, source);
  const paths: FilePath[] = [];
  for await (const entry of walkTree(ctx, treeId)) {
    if (entry.mode !== FILE_MODE.DIRECTORY) paths.push(entry.path);
  }
  return paths;
};

export const checkout = async (ctx: Context, opts: CheckoutOptions): Promise<CheckoutResult> => {
  await assertRepository(ctx);
  await assertNotBare(ctx, 'checkout');
  await assertNoPendingOperation(ctx);

  const switchMode = isSwitch(opts);
  const pathsMode = isPaths(opts);
  if (switchMode && pathsMode) {
    throw invalidOption('paths', 'cannot be combined with target');
  }
  if (!switchMode && !pathsMode) {
    throw invalidOption('target', 'either target or paths must be provided');
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
