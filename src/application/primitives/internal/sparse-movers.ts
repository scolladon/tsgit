import { recordedPaths } from '../../../domain/diff/index.js';
import {
  type GitIndex,
  type IndexEntry,
  skipWorktreeEntry,
} from '../../../domain/git-index/index.js';
import {
  escapedPathOf,
  type IndexPathKey,
  indexPathKey,
  isLossy,
} from '../../../domain/git-index/index-path-key.js';
import type { MergeConflict } from '../../../domain/merge/index.js';
import { FILE_MODE, type FilePath } from '../../../domain/objects/index.js';
import type { SparseMatcher } from '../../../domain/sparse/index.js';
import type { Context } from '../../../ports/context.js';
import { pruneEmptiedDirectories, survivingDirectoriesOf } from './prune-emptied-directories.js';
import { requireWorkTree } from './repo-state.js';
import { notUpToDate, warnLeftDespiteSparse } from './sparse-left-dirty.js';
import { createLeadingPathScanner } from './symlinked-leading-path.js';
import { removeWorkingTreeFile } from './write-working-tree-file.js';

/** What a conflict stop did to the out-of-pattern files the index still shows. */
export interface SparseRetirement {
  /** Removed from the work tree: their stage-0 entries take the skip-worktree bit. */
  readonly retired: ReadonlySet<IndexPathKey>;
  /** Kept because not up to date: their entries stay as they are. */
  readonly leftDirty: ReadonlySet<IndexPathKey>;
}

export const NOTHING_RETIRED: SparseRetirement = { retired: new Set(), leftDirty: new Set() };

interface RetirementScope {
  readonly currentIndex: GitIndex;
  readonly conflicts: ReadonlyArray<MergeConflict>;
}

/** A conflicted path is always written, so it never retires. */
const conflictedPaths = (conflicts: ReadonlyArray<MergeConflict>): ReadonlySet<FilePath> =>
  new Set(conflicts.flatMap((conflict) => [conflict.path, ...recordedPaths(conflict)]));

const moverCandidates = (
  scope: RetirementScope,
  sparse: SparseMatcher,
): ReadonlyArray<IndexEntry> => {
  const conflicted = conflictedPaths(scope.conflicts);
  return scope.currentIndex.entries.filter(
    (entry) =>
      entry.flags.stage === 0 &&
      !entry.flags.skipWorktree &&
      !isLossy(entry) &&
      entry.mode !== FILE_MODE.GITLINK &&
      !sparse(escapedPathOf(entry)) &&
      !conflicted.has(escapedPathOf(entry)),
  );
};

/** The pre-merge index may still list a path the merge replaced by a symlinked directory; git never reaches through the link, so neither does this. */
const reachableCandidates = async (
  ctx: Context,
  candidates: ReadonlyArray<IndexEntry>,
): Promise<ReadonlyArray<IndexEntry>> => {
  const scanner = createLeadingPathScanner(ctx);
  const throughLink = await Promise.all(
    candidates.map((entry) => scanner.hasSymlinkedLeadingPath(escapedPathOf(entry))),
  );
  return candidates.filter((_, position) => !throughLink[position]);
};

const removeRetired = async (
  ctx: Context,
  workdir: string,
  retired: ReadonlyArray<IndexEntry>,
): Promise<void> => {
  const paths = retired.map(escapedPathOf);
  for (const path of paths) await removeWorkingTreeFile(ctx, path);
  await pruneEmptiedDirectories(ctx, workdir, paths, survivingDirectoriesOf([]));
};

/** git's sparse loop on a conflict stop: an out-of-pattern file the patterns now hide leaves the work tree unless it holds local changes. */
export const retireSparseMovers = async (
  ctx: Context,
  scope: RetirementScope,
  sparse: SparseMatcher | undefined,
): Promise<SparseRetirement> => {
  if (sparse === undefined) return NOTHING_RETIRED;
  const workdir = requireWorkTree(ctx, 'merge');
  const candidates = await reachableCandidates(ctx, moverCandidates(scope, sparse));
  const leftDirty = await notUpToDate(ctx, workdir, candidates);
  const isClean = (entry: IndexEntry): boolean => !leftDirty.has(indexPathKey(entry));
  const clean = candidates.filter(isClean);
  await removeRetired(ctx, workdir, clean);
  warnLeftDespiteSparse(ctx, candidates.filter((entry) => !isClean(entry)).map(escapedPathOf));
  return { retired: new Set(clean.map(indexPathKey)), leftDirty };
};

/** The stop's index with every retired path skip-worktree. */
export const withRetiredSkipped = (
  entries: ReadonlyArray<IndexEntry>,
  retirement: SparseRetirement,
): ReadonlyArray<IndexEntry> =>
  entries.map((entry) =>
    entry.flags.stage === 0 && retirement.retired.has(indexPathKey(entry))
      ? skipWorktreeEntry(entry)
      : entry,
  );
