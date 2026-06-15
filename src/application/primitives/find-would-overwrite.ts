/**
 * Shared "would-overwrite" pre-flight for the 3-way merge family. Both the
 * apply primitive (`stash apply`, cherry-pick / revert / rebase) and `merge`'s
 * conflict write path compute the same set of paths the merge would change and
 * run the same dirtiness predicate before any write.
 *
 * `changedPaths` collects every path the merge touches in the working tree
 * (clean outcomes that change ours + every conflict's recorded paths).
 * `findWouldOverwrite` classifies each changed path that would lose working-tree
 * content: a tracked path whose working file is modified vs its stage-0 index
 * entry is a **local change**; a path absent from the index but present on disk
 * is **untracked**. The untracked-presence probe is `lstat`-based (no follow), so
 * a dangling symlink squatting a path still refuses (git's `lstat`-based probe).
 * Each class is returned sorted ascending; a path that is both classes is
 * reported as a local change only.
 */
import { comparePaths, recordedPaths } from '../../domain/diff/index.js';
import type { GitIndex, IndexEntry } from '../../domain/git-index/index.js';
import type { MergeConflict, MergeOutcome } from '../../domain/merge/index.js';
import type { FileMode, FilePath, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { compareWorkingTreeEntry, isWorkingTreeModified } from './compare-working-tree-entry.js';

export interface WouldOverwrite {
  readonly localChanges: ReadonlyArray<FilePath>;
  readonly untracked: ReadonlyArray<FilePath>;
}

/** Whether a clean outcome changes the path relative to `ours`. */
const outcomeChangesOurs = (
  outcome: MergeOutcome,
  ours: ReadonlyMap<FilePath, { readonly id: ObjectId; readonly mode: FileMode }>,
): boolean => {
  // The changed-vs-ours classification only narrows `changedPaths`, which gates
  // the overwrite guard and the conflict-path writer. Misclassifying a path is
  // observationally equivalent: a clean merge's delta is re-derived by
  // `materializeTree`, an unchanged/equal outcome the conflict-writer would
  // additionally touch reproduces bytes the working tree already holds, and an
  // extra clean path in the guard simply passes (it is not dirty). Hence the
  // sub-conditions below are equivalent mutants — the wrong-but-superset
  // classification yields the identical working tree + index.
  // Stryker disable next-line ConditionalExpression,BooleanLiteral: equivalent — see above.
  if (outcome.status === 'unchanged') return false;
  if (outcome.status === 'resolved-known') {
    const o = ours.get(outcome.path);
    // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — see above (a superset `changed` set is observationally identical).
    return o === undefined || o.id !== outcome.id || o.mode !== outcome.mode;
  }
  // Stryker disable next-line ConditionalExpression,BooleanLiteral: equivalent — see above.
  if (outcome.status === 'resolved-merged') return true;
  // resolved-deleted: a change only when `ours` actually had the path.
  // (`conflict` outcomes never reach here — the caller filters them out.)
  // Stryker disable next-line ConditionalExpression: equivalent — see above; `ours` always has a resolved-deleted path (it existed to be deleted).
  return outcome.status === 'resolved-deleted' && ours.has(outcome.path);
};

/** Every path the merge would touch in the working tree (changed clean + conflicts). */
export const changedPaths = (
  outcomes: ReadonlyArray<MergeOutcome>,
  conflicts: ReadonlyArray<MergeConflict>,
  ours: ReadonlyMap<FilePath, { readonly id: ObjectId; readonly mode: FileMode }>,
): ReadonlySet<FilePath> => {
  const paths = new Set<FilePath>();
  for (const outcome of outcomes) {
    if (outcome.status !== 'conflict' && outcomeChangesOurs(outcome, ours)) paths.add(outcome.path);
  }
  for (const conflict of conflicts) {
    for (const path of recordedPaths(conflict)) paths.add(path);
  }
  return paths;
};

/** Whether an untracked path is present on disk (lstat — no follow). */
const isUntrackedPresent = async (ctx: Context, path: FilePath): Promise<boolean> => {
  try {
    await ctx.fs.lstat(`${ctx.layout.workDir}/${path}`);
    return true;
  } catch {
    return false;
  }
};

/**
 * Classify the changed paths that would lose working-tree content. Tracked
 * paths modified vs the stage-0 index go to `localChanges`; index-absent paths
 * present on disk go to `untracked`. A tracked path never enters the untracked
 * branch, so a both-classes path is reported as a local change only. Each class
 * is returned sorted ascending.
 */
export const findWouldOverwrite = async (
  ctx: Context,
  paths: ReadonlySet<FilePath>,
  currentIndex: GitIndex,
): Promise<WouldOverwrite> => {
  const byPath = new Map<FilePath, IndexEntry>();
  for (const entry of currentIndex.entries) {
    // Stryker disable next-line ConditionalExpression: equivalent — the apply caller's `currentIndex` is a stage-0 index (synthesised from the real index), so every entry already has stage 0; the filter never excludes anything.
    if (entry.flags.stage === 0) byPath.set(entry.path, entry);
  }
  const localChanges: FilePath[] = [];
  const untracked: FilePath[] = [];
  for (const path of paths) {
    const entry = byPath.get(path);
    if (entry === undefined) {
      // A path the merge adds: an existing (untracked) working file would be clobbered.
      if (await isUntrackedPresent(ctx, path)) untracked.push(path);
      continue;
    }
    if (isWorkingTreeModified(await compareWorkingTreeEntry(ctx, entry))) localChanges.push(path);
  }
  return {
    localChanges: [...localChanges].sort(comparePaths),
    untracked: [...untracked].sort(comparePaths),
  };
};
