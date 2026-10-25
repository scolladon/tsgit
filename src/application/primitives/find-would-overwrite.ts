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
 * is **untracked**, judged by the shared occupant classifier (a dangling symlink
 * still squats, an ignored file or a directory of ignored files does not).
 * Each class is returned sorted ascending; a path that is both classes is
 * reported as a local change only.
 */
import { comparePaths, recordedPaths } from '../../domain/diff/index.js';
import type { GitIndex, IndexEntry } from '../../domain/git-index/index.js';
import { escapedPathOf, viewOfEscaped } from '../../domain/git-index/index-path-key.js';
import type { MergeConflict, MergeOutcome } from '../../domain/merge/index.js';
import { hasEscapedBytes } from '../../domain/objects/encoding.js';
import { FILE_MODE } from '../../domain/objects/file-mode.js';
import type { FileMode, FilePath, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import {
  type ComparisonScope,
  compareAndRefresh,
  isWorkingTreeModified,
  scopeOf,
} from './compare-working-tree-entry.js';
import { joinPath } from './internal/join-working-tree-path.js';
import {
  type ClashScope,
  classifyOccupant,
  createIgnoredProbe,
} from './internal/occupant-clash.js';
import { buildCheckinAttributeProvider } from './internal/read-gitattributes.js';
import { requireWorkTree } from './internal/repo-state.js';
import {
  createLeadingPathScanner,
  type LeadingPathScanner,
} from './internal/symlinked-leading-path.js';

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
  // An unchanged outcome ours lacks is a rename both sides kept: it still moves into place.
  if (outcome.status === 'unchanged' || outcome.status === 'resolved-known') {
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

/** Whether ours' file is recorded at a path of its own: the work-tree file at `conflict.path` is then lost. Re-adding an already recorded path is harmless. */
const displacesOurFile = (conflict: MergeConflict): boolean => conflict.ourPath !== undefined;

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
    if (displacesOurFile(conflict)) paths.add(conflict.path);
  }
  return paths;
};

/** Index entries keyed by path, stage-0 only. */
const stage0ByPath = (currentIndex: GitIndex): Map<FilePath, IndexEntry> => {
  const byPath = new Map<FilePath, IndexEntry>();
  for (const entry of currentIndex.entries) {
    // Stryker disable next-line ConditionalExpression: equivalent — the apply caller's `currentIndex` is a stage-0 index (synthesised from the real index), so every entry already has stage 0; the filter never excludes anything.
    if (entry.flags.stage === 0) byPath.set(escapedPathOf(entry), entry);
  }
  return byPath;
};

const NOTHING_REMOVED: ReadonlySet<FilePath> = new Set();

const clashScopeOf = (
  ctx: Context,
  removed: ReadonlySet<FilePath>,
  scanner: LeadingPathScanner,
): ClashScope => {
  const workdir = requireWorkTree(ctx, 'findWouldOverwrite');
  return {
    workdir,
    removed: new Set([...removed].map((path) => joinPath(workdir, path))),
    isIgnoredPath: createIgnoredProbe(ctx),
    scanner,
  };
};

const isBeneathFile = async (scanner: LeadingPathScanner, path: FilePath): Promise<boolean> =>
  !hasEscapedBytes(path) && (await scanner.obstructingLeadingComponent(path))?.kind === 'file';

/** The held spot an index-absent path would clobber, or `undefined` when it is clear. */
const untrackedSquat = async (
  ctx: Context,
  path: FilePath,
  byPath: ReadonlyMap<FilePath, IndexEntry>,
  clashScope: ClashScope,
): Promise<FilePath | undefined> => {
  // An escaped name is never on disk: git's lstat of it fails, so it reads as absent.
  if (hasEscapedBytes(path)) return undefined;
  const verdict = await classifyOccupant(ctx, { kind: 'add', path }, clashScope);
  if (verdict.kind !== 'clash') return undefined;
  // A tracked component in the way is judged as its own entry, never as an untracked squat.
  return byPath.has(verdict.clash.path) ? undefined : verdict.clash.path;
};

/** A directory still holding what git does not track where the merge deletes a tracked path: untracked data in the way, not a local change. */
const holdsUntrackedAtDeletion = async (
  ctx: Context,
  path: FilePath,
  clashScope: ClashScope,
): Promise<boolean> => {
  const verdict = await classifyOccupant(ctx, { kind: 'delete', path }, clashScope);
  return verdict.kind === 'clash' && verdict.clash.class === 'untracked';
};

const isLocalChange = async (
  ctx: Context,
  tracked: { readonly path: FilePath; readonly entry: IndexEntry },
  scanner: LeadingPathScanner,
  scope: ComparisonScope,
): Promise<boolean> => {
  const { path, entry } = tracked;
  // git's `verify_uptodate_1` returns early for a gitlink: a moved checkout is not local work.
  if (entry.mode === FILE_MODE.GITLINK) return false;
  if (await isBeneathFile(scanner, path)) return true;
  const { delta } = await compareAndRefresh(ctx, entry, scope);
  return isWorkingTreeModified(delta.status);
};

/**
 * Classify the changed paths that would lose working-tree content. Tracked
 * paths modified vs the stage-0 index, or standing beneath a regular file, go to
 * `localChanges`; index-absent paths whose spot is held (the path itself or a
 * leading component, named in place) go to `untracked`. `removed` lists the
 * paths the merge deletes, which never clash; a tracked one that a directory
 * holding untracked files now occupies is `untracked`, as git's `lose-untracked`.
 * Any other tracked path is reported as a local change only.
 * Each class is returned sorted ascending.
 */
export const findWouldOverwrite = async (
  ctx: Context,
  paths: ReadonlySet<FilePath>,
  currentIndex: GitIndex,
  removed: ReadonlySet<FilePath> = NOTHING_REMOVED,
): Promise<WouldOverwrite> => {
  const byPath = stage0ByPath(currentIndex);
  const provider = await buildCheckinAttributeProvider(ctx);
  // One leading-path memo for the whole scan: a shared directory is lstat-ed once.
  const scanner = createLeadingPathScanner(ctx);
  const scope = scopeOf(provider, currentIndex.indexMtime, scanner);
  const clashScope = clashScopeOf(ctx, removed, scanner);
  const localChanges: FilePath[] = [];
  const untracked: FilePath[] = [];
  for (const path of paths) {
    const entry = byPath.get(path);
    if (entry === undefined) {
      const squat = await untrackedSquat(ctx, path, byPath, clashScope);
      if (squat !== undefined) untracked.push(squat);
    } else if (await isLocalChange(ctx, { path, entry }, scanner, scope)) {
      const held = removed.has(path) && (await holdsUntrackedAtDeletion(ctx, path, clashScope));
      (held ? untracked : localChanges).push(path);
    }
  }
  return {
    localChanges: [...localChanges].sort(comparePaths).map(viewOfEscaped),
    untracked: [...untracked].sort(comparePaths).map(viewOfEscaped),
  };
};

/**
 * The tracked changed paths whose leading directory is now a symlink. git sees
 * each as deleted from the work tree, cannot save that state and refuses the
 * merge outright, so the caller refuses them as local changes before any write.
 * Sorted ascending.
 */
export const findTrackedBeyondSymlink = async (
  ctx: Context,
  paths: ReadonlySet<FilePath>,
  currentIndex: GitIndex,
): Promise<ReadonlyArray<FilePath>> => {
  const byPath = stage0ByPath(currentIndex);
  const scanner = createLeadingPathScanner(ctx);
  const beyond: FilePath[] = [];
  for (const path of paths) {
    if (!byPath.has(path) || hasEscapedBytes(path)) continue;
    if (await scanner.hasSymlinkedLeadingPath(path)) beyond.push(path);
  }
  return beyond.sort(comparePaths).map(viewOfEscaped);
};
