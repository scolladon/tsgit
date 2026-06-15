import { nonFastForward, workingTreeDirty } from '../../domain/commands/error.js';
import { conflictsToIndexEntries } from '../../domain/diff/index.js';
import { TsgitError } from '../../domain/error.js';
import {
  type IndexEntry,
  STAGE0_FLAGS,
  type StatData,
  skipWorktreeEntry,
} from '../../domain/git-index/index.js';
import { unsupportedOperation } from '../../domain/index.js';
import {
  type ConflictType,
  MAX_CONFLICT_OUTPUT_BYTES,
  type MergeConflict,
  type MergeLabels,
  type MergeOutcome,
  mergeLabels,
  mergeTrees,
} from '../../domain/merge/index.js';
import type { CommitData } from '../../domain/objects/commit.js';
import { treeDepthExceeded, unexpectedObjectType } from '../../domain/objects/error.js';
import {
  type AuthorIdentity,
  FILE_MODE,
  type FileMode,
  type FilePath,
  type ObjectId,
  type RefName,
} from '../../domain/objects/index.js';
import type { SparseMatcher } from '../../domain/sparse/index.js';
import type { Context } from '../../ports/context.js';
import { buildContentMerger } from '../primitives/build-content-merger.js';
import { readConfig } from '../primitives/config-read.js';
import { createCommit } from '../primitives/create-commit.js';
import { flattenTree } from '../primitives/flatten-tree.js';
import { writeDistinctTypesSides } from '../primitives/internal/write-distinct-types-sides.js';
import {
  rmIfExists,
  writeWorkingTreeEntry,
  writeWorkingTreeFile,
} from '../primitives/internal/write-working-tree-file.js';
import { materializeTree } from '../primitives/materialize-tree.js';
import { mergeBase } from '../primitives/merge-base.js';
import { readBlob } from '../primitives/read-blob.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { loadSparseMatcher } from '../primitives/read-sparse-checkout.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { runInformationalHook } from '../primitives/run-hook.js';
import { updateRef } from '../primitives/update-ref.js';
import { writeObject } from '../primitives/write-object.js';
import { writeTree } from '../primitives/write-tree.js';
import { resolveCommitIsh } from './internal/commit-ish.js';
import { resolveAuthor, resolveCommitter, sanitizeMessage } from './internal/commit-message.js';
import { acquireIndexLock } from './internal/index-update.js';
import { writeMergeHead, writeMergeMsg, writeOrigHead } from './internal/merge-state.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertRepository,
  readHeadRaw,
} from './internal/repo-state.js';

export interface MergeRunInput {
  readonly rev: string;
  readonly message?: string;
  /**
   * Fast-forward policy (git `--ff` / `--ff-only` / `--no-ff`):
   * - `'allow'` (default) — fast-forward when possible, else a true merge.
   * - `'only'` — refuse with `NON_FAST_FORWARD` when a true merge is required.
   * - `'never'` — always create a merge commit, even when a fast-forward is possible.
   */
  readonly fastForward?: 'only' | 'never' | 'allow';
  readonly author?: AuthorIdentity;
  readonly committer?: AuthorIdentity;
}

/**
 * Internal-only knobs for `merge`, set by composing porcelain (e.g. `pull`),
 * never by end users. Deliberately **not** re-exported from the commands barrel,
 * so it stays off the public API surface.
 */
export interface MergeInternalOptions {
  /**
   * Reflog action prefix, mirroring git's GIT_REFLOG_ACTION. Replaces the
   * default `merge <rev>` prefix in the fast-forward and merge-commit reflog
   * messages (e.g. `pull` → `pull: Fast-forward`). Defaults to `merge <rev>`.
   */
  readonly reflogAction?: string;
}

export interface MergeConflictDescriptor {
  readonly path: FilePath;
  readonly type: ConflictType;
}

export type MergeResult =
  | { readonly kind: 'up-to-date'; readonly id: ObjectId }
  | { readonly kind: 'fast-forward'; readonly id: ObjectId; readonly branch: RefName }
  | {
      readonly kind: 'merge';
      readonly id: ObjectId;
      readonly branch: RefName;
      readonly parents: ReadonlyArray<ObjectId>;
    }
  | {
      readonly kind: 'conflict';
      readonly conflicts: ReadonlyArray<MergeConflictDescriptor>;
      readonly mergeHead: ObjectId;
      readonly origHead: ObjectId;
    };

/**
 * Merge `rev` into the current HEAD branch.
 *
 * - Up-to-date: rev is ancestor of HEAD → no-op.
 * - Fast-forward: HEAD is ancestor of rev → branch advances.
 * - True merge for diverged histories:.4a wired the three-way
 *  tree merge (`mergeTrees` + `mergeContent`) so a CLEAN merge commits
 *  the merged tree directly.4b persists conflict state on
 *  disk (marker files, stage-1/2/3 index entries, MERGE_HEAD /
 *  MERGE_MSG / ORIG_HEAD) and returns `{ kind: 'conflict',... }`.
 *  Resolution path: edit the marker files, `repo.add(paths)`,
 *  `repo.commit({ message })` — the resulting commit has two parents.
 */
/** `post-merge`'s squash-flag argument. tsgit has no `--squash`, so always off. */
const SQUASH_FLAG_OFF = '0';

export const mergeRun = async (
  ctx: Context,
  opts: MergeRunInput,
  internal: MergeInternalOptions = {},
): Promise<MergeResult> => {
  const result = await computeMerge(ctx, opts, internal);
  // post-merge is informational — git fires it after a merge that updates the
  // working tree (fast-forward or clean true-merge), never on up-to-date or a
  // conflict. It cannot abort the completed merge (its exit code is ignored).
  if (result.kind === 'fast-forward' || result.kind === 'merge') {
    await runInformationalHook(ctx, 'post-merge', { args: [SQUASH_FLAG_OFF] });
  }
  return result;
};

const computeMerge = async (
  ctx: Context,
  opts: MergeRunInput,
  internal: MergeInternalOptions,
): Promise<MergeResult> => {
  await assertRepository(ctx);
  await assertNotBare(ctx, 'merge');
  await assertNoPendingOperation(ctx);
  const head = await readHeadRaw(ctx);
  if (head.kind !== 'symbolic') {
    throw unsupportedOperation('merge', 'cannot merge with detached HEAD');
  }
  const ourId = await resolveRef(ctx, head.target);
  const theirId = await resolveCommitIsh(ctx, opts.rev);
  // Stryker disable next-line ConditionalExpression: equivalent — when ourId===theirId, mergeBase returns that same commit, so the `base === theirId` check below yields the identical up-to-date result.
  if (ourId === theirId) return { kind: 'up-to-date', id: ourId };
  const [base] = await mergeBase(ctx, [ourId, theirId]);
  if (base === theirId) return { kind: 'up-to-date', id: ourId };
  if (base === ourId) {
    if (opts.fastForward !== 'never') {
      return materialiseAndApply(ctx, await getTree(ctx, theirId), async () => {
        await updateRef(ctx, head.target, theirId, {
          expected: ourId,
          reflogMessage: `${internal.reflogAction ?? `merge ${opts.rev}`}: Fast-forward`,
        });
        return { kind: 'fast-forward', id: theirId, branch: head.target };
      });
    }
  }
  if (opts.fastForward === 'only') {
    throw nonFastForward(head.target, ourId, theirId);
  }
  return mergeCommit(ctx, opts, internal, head.target, ourId, theirId, base);
};

const MERGE_WRITE_FILES_OP = 'merge:write-files';

export const UNSUPPORTED_CONFLICT_TYPES: ReadonlySet<ConflictType> = new Set([
  'rename-rename',
  'gitlink',
]);

const mergeCommit = async (
  ctx: Context,
  opts: MergeRunInput,
  internal: MergeInternalOptions,
  branchName: RefName,
  ourId: ObjectId,
  theirId: ObjectId,
  baseId: ObjectId | undefined,
): Promise<MergeResult> => {
  ctx.progress.start(MERGE_WRITE_FILES_OP);
  try {
    const treeResult = await computeMergeTreeResult(ctx, ourId, theirId, baseId, opts.rev);
    if (treeResult.kind === 'conflict') {
      return persistConflictState(ctx, opts, treeResult, ourId, theirId);
    }
    return commitCleanMerge(ctx, opts, internal, branchName, ourId, theirId, treeResult.tree);
  } finally {
    ctx.progress.end(MERGE_WRITE_FILES_OP);
  }
};

/**
 * Map `materializeTree`'s checkout-flavoured dirty refusal to the merge-family
 * `WORKING_TREE_DIRTY` code, so the whole 3-way merge family speaks one
 * would-overwrite error; any other error passes through untouched. Exported for
 * direct unit testing.
 */
export const asMergeDirtyError = (err: unknown): unknown =>
  err instanceof TsgitError && err.data.code === 'CHECKOUT_OVERWRITE_DIRTY'
    ? workingTreeDirty(err.data.paths)
    : err;

/**
 * Materialise a non-conflict merge result (clean true-merge or fast-forward) to
 * the working tree + index: write the target tree's delta against the current
 * index and return the post-write stage-0 entries for the caller to commit under
 * its index lock. Mirrors the clean branch of `applyMergeToWorktree`; the
 * conflict path keeps its own sparse-aware writers.
 */
const materialiseNonConflictTree = async (
  ctx: Context,
  targetTree: ObjectId,
): Promise<ReadonlyArray<IndexEntry>> => {
  const currentIndex = await readIndex(ctx);
  try {
    const result = await materializeTree(ctx, { targetTree, currentIndex, force: false });
    return result.newIndexEntries;
  } catch (err) {
    throw asMergeDirtyError(err);
  }
};

/**
 * Materialise a non-conflict merge result (`targetTree`) to the working tree +
 * index under the index lock, then run `apply` (the ref/commit step) and return
 * its result — releasing the lock either way. Shared by the clean true-merge and
 * fast-forward branches so the lock ceremony lives in one place.
 */
const materialiseAndApply = async (
  ctx: Context,
  targetTree: ObjectId,
  apply: () => Promise<MergeResult>,
): Promise<MergeResult> => {
  const lock = await acquireIndexLock(ctx);
  try {
    const entries = await materialiseNonConflictTree(ctx, targetTree);
    await lock.commit(entries);
    return await apply();
  } finally {
    await lock.release();
  }
};

const commitCleanMerge = async (
  ctx: Context,
  opts: MergeRunInput,
  internal: MergeInternalOptions,
  branchName: RefName,
  ourId: ObjectId,
  theirId: ObjectId,
  mergedTree: ObjectId,
): Promise<MergeResult> => {
  const author = await resolveMergeAuthor(ctx, opts);
  const committer = resolveMergeCommitter(opts, author);
  const message = sanitizeMessage(opts.message ?? `Merge ${opts.rev}`, { allowEmpty: false });
  const commitData: CommitData = {
    tree: mergedTree,
    parents: [ourId, theirId],
    author,
    committer,
    message,
    extraHeaders: [],
  };
  return materialiseAndApply(ctx, mergedTree, async () => {
    const id = await createCommit(ctx, commitData);
    await updateRef(ctx, branchName, id, {
      expected: ourId,
      reflogMessage: `${internal.reflogAction ?? `merge ${opts.rev}`}: Merge made by the 'tsgit' strategy.`,
    });
    return { kind: 'merge', id, branch: branchName, parents: [ourId, theirId] };
  });
};

type MergeTreeResult =
  | { readonly kind: 'clean'; readonly tree: ObjectId }
  | {
      readonly kind: 'conflict';
      readonly outcomes: ReadonlyArray<MergeOutcome>;
      readonly conflicts: ReadonlyArray<MergeConflict>;
    };

const computeMergeTreeResult = async (
  ctx: Context,
  ourId: ObjectId,
  theirId: ObjectId,
  baseId: ObjectId | undefined,
  revName: string,
): Promise<MergeTreeResult> => {
  const ourTreeId = await getTree(ctx, ourId);
  const theirTreeId = await getTree(ctx, theirId);
  const baseTreeId = baseId !== undefined ? await getTree(ctx, baseId) : undefined;

  const [ourFlat, theirFlat, baseFlat] = await Promise.all([
    flattenTree(ctx, ourTreeId),
    flattenTree(ctx, theirTreeId),
    baseTreeId !== undefined ? flattenTree(ctx, baseTreeId) : Promise.resolve(undefined),
  ]);

  const labels: MergeLabels = mergeLabels(revName, baseId);
  const contentMerger = buildContentMerger(ctx, labels);
  const result = await mergeTrees(baseFlat, ourFlat, theirFlat, contentMerger, labels);

  if (result.cleanMerge) {
    const tree = await synthesiseMergedTree(ctx, result.outcomes);
    return { kind: 'clean', tree };
  }
  return { kind: 'conflict', outcomes: result.outcomes, conflicts: result.conflicts };
};

interface LeafRecord {
  readonly path: FilePath;
  readonly id: ObjectId;
  readonly mode: FileMode;
}

const collectLeaves = async (
  ctx: Context,
  outcomes: ReadonlyArray<MergeOutcome>,
): Promise<LeafRecord[]> => {
  const leaves: LeafRecord[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'resolved-deleted' || outcome.status === 'conflict') continue;
    if (outcome.status === 'resolved-merged') {
      // The empty-string `id` is a sentinel — `writeObject` computes the
      // real ObjectId from the content and returns it. The cast lets us
      // construct the typed input without circular dependence on the hash.
      const id = await writeObject(ctx, {
        type: 'blob',
        content: outcome.bytes,
        id: '' as ObjectId,
      });
      leaves.push({ path: outcome.path, id, mode: outcome.mode });
      continue;
    }
    // unchanged | resolved-known
    leaves.push({ path: outcome.path, id: outcome.id, mode: outcome.mode });
  }
  return leaves;
};

const synthesiseMergedTree = async (
  ctx: Context,
  outcomes: ReadonlyArray<MergeOutcome>,
): Promise<ObjectId> => {
  const leaves = await collectLeaves(ctx, outcomes);
  return writeNestedTree(ctx, leaves);
};

interface PartitionedLeaves {
  readonly files: ReadonlyArray<LeafRecord>;
  readonly subdirs: ReadonlyMap<string, ReadonlyArray<LeafRecord>>;
}

const partitionByPrefix = (leaves: ReadonlyArray<LeafRecord>): PartitionedLeaves => {
  const files: LeafRecord[] = [];
  const subdirs = new Map<string, LeafRecord[]>();
  for (const leaf of leaves) {
    const slashIndex = leaf.path.indexOf('/');
    if (slashIndex === -1) {
      files.push(leaf);
      continue;
    }
    const prefix = leaf.path.slice(0, slashIndex);
    const rest = leaf.path.slice(slashIndex + 1) as FilePath;
    const sub: LeafRecord = { path: rest, id: leaf.id, mode: leaf.mode };
    const bucket = subdirs.get(prefix);
    if (bucket === undefined) subdirs.set(prefix, [sub]);
    else bucket.push(sub);
  }
  return { files, subdirs };
};

export const MAX_MERGE_TREE_DEPTH = 4096;

/** Build a nested tree from flat leaf records. Exported for direct unit testing. */
export const writeNestedTree = async (
  ctx: Context,
  leaves: ReadonlyArray<LeafRecord>,
  depth = 0,
): Promise<ObjectId> => {
  // Depth cap matches `synthesizeTreeFromIndex`'s contract — an adversarial
  // commit with pathologically deep paths would otherwise exhaust the JS
  // call stack before any async tick yielded. The cap fires upstream too:
  // walkTree (via flattenTree) caps at MAX_FLAT_TREE_ENTRIES depth, but
  // re-asserting here keeps the primitive safe under future composers.
  if (depth > MAX_MERGE_TREE_DEPTH) throw treeDepthExceeded(depth);
  const { files, subdirs } = partitionByPrefix(leaves);
  // Resolve sub-trees in parallel — each branch is independent of the
  // others, so awaiting them serially would needlessly stretch the
  // merge wall time when a target tree has many top-level dirs.
  // equivalent-mutant: swapping Promise.all for a serial for-await loop
  // produces the same output (the merge is deterministic and order-
  // independent at the tree-content level). The parallelisation is a
  // performance optimisation; a unit-level mutation test cannot
  // distinguish parallel from serial without timing or call-order
  // instrumentation, so we accept the mutant as documented.
  const subdirEntries = await Promise.all(
    Array.from(subdirs, async ([prefix, subLeaves]) => ({
      name: prefix as FilePath,
      id: await writeNestedTree(ctx, subLeaves, depth + 1),
      mode: FILE_MODE.DIRECTORY,
    })),
  );
  const fileEntries = files.map((f) => ({ name: f.path, id: f.id, mode: f.mode }));
  return writeTree(ctx, [...fileEntries, ...subdirEntries]);
};

/**
 * Persist the conflicting-merge state on disk's write order:
 * working-tree files → ORIG_HEAD → MERGE_HEAD → MERGE_MSG → index.
 *
 * Unsupported conflict types are rejected upfront BEFORE any disk write
 * so the operation fails atomically (HEAD/index/working-tree untouched).
 */
const persistConflictState = async (
  ctx: Context,
  opts: MergeRunInput,
  result: Extract<MergeTreeResult, { readonly kind: 'conflict' }>,
  ourId: ObjectId,
  theirId: ObjectId,
): Promise<MergeResult> => {
  rejectUnsupportedConflicts(result.conflicts);

  // loadSparseMatcher is a pure config/pattern-file read — no lock needed. A
  // defined matcher keeps excluded blob-backed paths out of the working tree
  // and marks their stage-0 conflict-state entries skip-worktree.
  const matcher = await loadSparseMatcher(ctx);
  const lock = await acquireIndexLock(ctx);
  try {
    await writeConflictingWorkingTree(ctx, result.outcomes, result.conflicts, matcher);
    await writeOrigHead(ctx, ourId);
    await writeMergeHead(ctx, theirId);
    const message = sanitizeMessage(opts.message ?? `Merge ${opts.rev}`, { allowEmpty: false });
    await writeMergeMsg(ctx, message);
    const indexEntries = buildConflictIndexEntries(result.outcomes, result.conflicts, matcher);
    await lock.commit(indexEntries);
  } finally {
    // Always release the lock — `commit` flips the lock to a no-op state
    // on success, so this is safe regardless of which path completed.
    // Matches the `try/finally` pattern in `add.ts` and `checkout.ts`.
    await lock.release();
  }

  return {
    kind: 'conflict',
    conflicts: result.conflicts.map((c) => ({ path: c.path, type: c.type })),
    mergeHead: theirId,
    origHead: ourId,
  };
};

/**
 * Reject conflict types that v1 cannot persist as resolvable merge state
 * (`rename-rename`, `gitlink`). Fires BEFORE `acquireIndexLock` in the
 * caller so an unsupported conflict surfaces atomically — no stale
 * `index.lock`, no working-tree pollution, no MERGE_HEAD on disk.
 * Exported for direct unit testing.
 */
export const rejectUnsupportedConflicts = (conflicts: ReadonlyArray<MergeConflict>): void => {
  for (const conflict of conflicts) {
    if (UNSUPPORTED_CONFLICT_TYPES.has(conflict.type)) {
      throw unsupportedOperation(
        'merge',
        `conflict type '${conflict.type}' not supported in v1 (path=${conflict.path})`,
      );
    }
  }
};

// Hard cap on concurrent path writes during a conflicting merge. Without it
// large merges (thousands of paths) blow past the default `ulimit -n`
// (256 on macOS, 1024 on most Linux) and surface as EMFILE.
const MAX_CONCURRENT_PATH_WRITES = 32;

/** True iff a sparse matcher is active AND rejects the path. */
const isExcluded = (matcher: SparseMatcher | undefined, path: FilePath): boolean =>
  matcher !== undefined && !matcher(path);

/** Whether a distinct-types rename target already exists on disk (lstat — no follow). */
const isUntrackedBlocker = async (ctx: Context, renamedPath: FilePath): Promise<boolean> => {
  const abs = `${ctx.layout.workDir}/${renamedPath}`;
  try {
    await ctx.fs.lstat(abs);
    return true;
  } catch {
    return false;
  }
};

/**
 * Collect the distinct-types rename targets that exist on disk. Only the side
 * whose recorded path differs from the original (`conflict.path`) was renamed;
 * its target is probed unique against every tracked path of the three input
 * trees, so anything found there is necessarily untracked. The non-renamed
 * side's path legitimately exists on disk (ours is checked out) and is skipped.
 * Mirrors git's "untracked working tree file would be overwritten by merge" refusal.
 */
const collectUntrackedRenameBlockers = async (
  ctx: Context,
  conflicts: ReadonlyArray<MergeConflict>,
): Promise<ReadonlyArray<FilePath>> => {
  const blockers: FilePath[] = [];
  for (const conflict of conflicts) {
    if (conflict.type !== 'distinct-types') continue;
    for (const recordedPath of [conflict.ourPath, conflict.theirPath]) {
      if (recordedPath === undefined || recordedPath === conflict.path) continue;
      if (await isUntrackedBlocker(ctx, recordedPath)) blockers.push(recordedPath);
    }
  }
  return blockers;
};

const writeConflictingWorkingTree = async (
  ctx: Context,
  outcomes: ReadonlyArray<MergeOutcome>,
  conflicts: ReadonlyArray<MergeConflict>,
  matcher: SparseMatcher | undefined,
): Promise<void> => {
  // Pre-flight: refuse when an untracked file would be overwritten by a
  // distinct-types rename. Mirrors git's "untracked working tree file would
  // be overwritten by merge" refusal (checked before any working-tree write).
  const blockers = await collectUntrackedRenameBlockers(ctx, conflicts);
  if (blockers.length > 0) throw workingTreeDirty(blockers);

  // Bounded parallelism — independent path writes overlap, but the pool
  // caps in-flight at MAX_CONCURRENT_PATH_WRITES so a 10k-path merge
  // doesn't exhaust file descriptors.
  await runBounded(outcomes, MAX_CONCURRENT_PATH_WRITES, (outcome) =>
    writeOutcomeToTree(ctx, outcome, matcher),
  );
  // Conflicted paths are materialised even when sparse-excluded — a conflict
  // the user cannot see is unresolvable, so `writeConflictToTree` takes no
  // matcher.
  await runBounded(conflicts, MAX_CONCURRENT_PATH_WRITES, (conflict) =>
    writeConflictToTree(ctx, conflict),
  );
};

/**
 * Run `fn` over `items` with at most `limit` in-flight at once. Promise
 * rejection propagates upward (matches `Promise.all` semantics); in-flight
 * tasks are not cancelled. Exported for direct unit testing.
 */
export const runBounded = async <T>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> => {
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const worker = async (): Promise<void> => {
    // Stryker disable next-line EqualityOperator: equivalent — `cursor <= items.length` reads `items[items.length]` (undefined) once, and the `next === undefined` break below terminates identically.
    while (cursor < items.length) {
      const next = items[cursor++];
      if (next === undefined) break;
      await fn(next);
    }
  };
  const concurrency = Math.min(limit, items.length);
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
};

/**
 * Write a single merge outcome to the working tree. Exported for direct unit
 * testing.
 *
 * Sparse handling splits on where the content lives:
 * - `unchanged` / `resolved-known` are backed by a committed blob, so an
 *   excluded path is skipped — the working tree keeps only in-pattern files.
 * - `resolved-merged` carries its merged bytes in memory only; this write is
 *   their sole persistence, so the path is always materialised.
 * - `resolved-deleted` needs no guard — an excluded file is already absent and
 *   `removeWorkingTreeFile` is a no-op for it.
 */
export const writeOutcomeToTree = async (
  ctx: Context,
  outcome: MergeOutcome,
  matcher: SparseMatcher | undefined,
): Promise<void> => {
  if (outcome.status === 'unchanged' || outcome.status === 'resolved-known') {
    if (isExcluded(matcher, outcome.path)) return;
    // Cap with MAX_CONFLICT_OUTPUT_BYTES so a hostile clean-tree blob
    // cannot OOM the merge consumer during a conflicting merge.
    // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
    const blob = await readBlob(ctx, outcome.id, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES });
    await writeWorkingTreeFile(ctx, outcome.path, blob.content);
    return;
  }
  if (outcome.status === 'resolved-merged') {
    // The merged bytes exist only in memory — this write is their sole
    // persistence, so the path is materialised regardless of the matcher.
    await writeWorkingTreeFile(ctx, outcome.path, outcome.bytes);
    return;
  }
  if (outcome.status === 'resolved-deleted') {
    await removeWorkingTreeFile(ctx, outcome.path);
  }
  // 'conflict' outcomes are handled by the parallel conflicts batch.
};

export const writeConflictToTree = async (ctx: Context, conflict: MergeConflict): Promise<void> => {
  if (conflict.type === 'distinct-types') {
    await writeDistinctTypesSides(ctx, conflict);
    return;
  }
  // Materialise with the merged mode when the merge resolved one, else the
  // surviving side's (ours, or theirs for modify-delete with ours deleted) so
  // the kind (symlink / exec bit) is preserved. Every conflict constructor
  // pairs ids with modes, so bytes being derivable implies a mode exists; the
  // guard checks anyway and skips the blob read when no mode is present.
  const mode = conflict.mergedMode ?? conflict.ourMode ?? conflict.theirMode;
  if (mode === undefined) return;
  const bytes = await materialiseConflictBytes(ctx, conflict);
  if (bytes === undefined) return;
  await writeWorkingTreeEntry(ctx, conflict.path, bytes, mode);
};

// Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
const READ_BLOB_OPTS = { maxBytes: MAX_CONFLICT_OUTPUT_BYTES } as const;

const readOursBlob = (ctx: Context, conflict: MergeConflict): Promise<Uint8Array> | undefined => {
  if (conflict.ourId === undefined) return undefined;
  return readBlob(ctx, conflict.ourId, READ_BLOB_OPTS).then((b) => b.content);
};

const materialiseMarkedOrOurs = async (
  ctx: Context,
  conflict: MergeConflict,
): Promise<Uint8Array | undefined> => {
  if (conflict.conflictContent !== undefined) return conflict.conflictContent;
  return readOursBlob(ctx, conflict);
};

/** Derive the working-tree bytes for a conflicting path. Exported for direct unit testing. */
export const materialiseConflictBytes = async (
  ctx: Context,
  conflict: MergeConflict,
): Promise<Uint8Array | undefined> => {
  if (conflict.type === 'content') return materialiseMarkedOrOurs(ctx, conflict);
  if (conflict.type === 'add-add') return materialiseMarkedOrOurs(ctx, conflict);
  if (conflict.type === 'binary') return readOursBlob(ctx, conflict);
  if (conflict.type === 'type-change') return readOursBlob(ctx, conflict);
  if (conflict.type === 'modify-delete') {
    // Preserve the surviving side's bytes (whichever has an id).
    const survivorId = conflict.ourId ?? conflict.theirId;
    if (survivorId === undefined) return undefined;
    return (await readBlob(ctx, survivorId, READ_BLOB_OPTS)).content;
  }
  return undefined;
};

/** Remove a working-tree file if it exists. Exported for direct unit testing. */
export const removeWorkingTreeFile = async (ctx: Context, path: FilePath): Promise<void> => {
  const fullPath = `${ctx.layout.workDir}/${path}`;
  await rmIfExists(ctx, fullPath);
};

const zeroStat = (mode: FileMode): StatData => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode,
  uid: 0,
  gid: 0,
  fileSize: 0,
});

/** Build the conflict-state index entries. Exported for direct unit testing. */
export const buildConflictIndexEntries = (
  outcomes: ReadonlyArray<MergeOutcome>,
  conflicts: ReadonlyArray<MergeConflict>,
  matcher: SparseMatcher | undefined,
): ReadonlyArray<IndexEntry> => {
  // Stage-0 entries from clean outcomes (resolved-deleted contributes
  // nothing). resolved-merged needs its bytes hashed but we already wrote
  // them — we'll re-derive the id by computing it lazily. For simplicity,
  // resolved-merged outcomes are EXCLUDED from the conflict-state index:
  // the path is left unmerged (user must add it manually) when it sits
  // alongside conflicts. This avoids needing writeObject under the index
  // lock with attendant complexity. Pure clean outcomes (unchanged /
  // resolved-known) keep their stage-0 entries.
  const stage0: IndexEntry[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'unchanged' || outcome.status === 'resolved-known') {
      // An excluded clean path is recorded skip-worktree so `status` does not
      // report the (deliberately un-written) file as deleted.
      stage0.push(
        isExcluded(matcher, outcome.path)
          ? skipWorktreeEntry({ path: outcome.path, id: outcome.id, mode: outcome.mode })
          : {
              ...zeroStat(outcome.mode),
              id: outcome.id,
              flags: STAGE0_FLAGS,
              path: outcome.path,
            },
      );
    }
  }

  const stageConflicts = conflictsToIndexEntries(conflicts, zeroStat);
  // serializeIndex sorts by path only (V8's sort is stable so the
  // upstream stage ordering survives) but the canonical git index
  // requires (path, stage) order. Sort explicitly here to make the
  // invariant load-bearing on our own code rather than V8's
  // stable-sort guarantee.
  const combined = [...stage0, ...stageConflicts];
  combined.sort((a, b) => {
    // Stryker disable next-line EqualityOperator: equivalent — for equal paths `<=`/`>=` both return -1; same-path entries always arrive stage-ascending (conflictsToIndexEntries sorts, stage-0 precedes them), so -1 already matches the correct order.
    if (a.path < b.path) return -1;
    // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — for any distinct-path pair V8's sort derives the order from the `a.path < b.path → -1` rule above (evaluated in whichever argument order yields `<`), so this `>` branch never changes the observable sort result.
    if (a.path > b.path) return 1;
    // Stryker disable next-line ArithmeticOperator: equivalent — the stage branch only compares equal-path entries, which always arrive stage-ascending (conflictsToIndexEntries sorts conflict stages and rejects duplicate paths; stage-0 entries all share stage 0), so the comparator is a no-op on an already-ordered run regardless of sign.
    return a.flags.stage - b.flags.stage;
  });
  return combined;
};

/** Resolve the merge-commit author. Exported for direct unit testing. */
export const resolveMergeAuthor = async (
  ctx: Context,
  opts: MergeRunInput,
): Promise<AuthorIdentity> => {
  const config = await readConfig(ctx);
  const cfgUser = config.user
    ? {
        name: config.user.name,
        email: config.user.email,
        timestamp: Math.floor(Date.now() / 1000),
        timezoneOffset: '+0000',
      }
    : undefined;
  const authorInput: { explicit?: AuthorIdentity; configUser?: AuthorIdentity } = {};
  if (opts.author !== undefined) authorInput.explicit = opts.author;
  if (cfgUser !== undefined) authorInput.configUser = cfgUser;
  return resolveAuthor(authorInput);
};

/** Resolve the merge-commit committer. Exported for direct unit testing. */
export const resolveMergeCommitter = (
  opts: MergeRunInput,
  author: AuthorIdentity,
): AuthorIdentity => {
  const committerInput: {
    explicit?: AuthorIdentity;
    author?: AuthorIdentity;
    configUser?: AuthorIdentity;
  } = { author };
  if (opts.committer !== undefined) committerInput.explicit = opts.committer;
  return resolveCommitter(committerInput);
};

const getTree = async (ctx: Context, commitId: ObjectId): Promise<ObjectId> => {
  const obj = await readObject(ctx, commitId);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, commitId);
  return obj.data.tree;
};
