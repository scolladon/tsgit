/**
 * Clear the skip-worktree bit of an entry whose path exists in the working tree, as git does on
 * every index read unless `sparse.expectFilesOutsideOfPatterns` is set. The clear is in memory
 * only; it never writes the index.
 */
import type { GitIndex, IndexEntry } from '../../../domain/git-index/index.js';
import { isLossy } from '../../../domain/git-index/index-path-key.js';
import { presentPaths } from '../../../domain/sparse/missing-directory.js';
import type { Context } from '../../../ports/context.js';
import type { FileSystem } from '../../../ports/file-system.js';
import { readSparseConfig } from '../read-sparse-config.js';
import { joinPath } from './join-working-tree-path.js';

/** Per index object, so a cached parse pays the scan once. */
const candidatesOf = new WeakMap<GitIndex, ReadonlyArray<IndexEntry>>();

const isCandidate = (entry: IndexEntry): boolean => entry.flags.skipWorktree && !isLossy(entry);

const skipWorktreeCandidates = (index: GitIndex): ReadonlyArray<IndexEntry> => {
  const known = candidatesOf.get(index);
  if (known !== undefined) return known;
  const scanned = index.entries.filter(isCandidate);
  candidatesOf.set(index, scanned);
  return scanned;
};

/**
 * The one place a refusal reads as absence: git's `path_found` treats every errno from `lstat`
 * (ENOENT, ENOTDIR, EACCES, ...) as "not present", so the bit stays.
 */
const lstatSucceeds = async (fs: FileSystem, path: string): Promise<boolean> => {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
};

const withBitCleared = (entry: IndexEntry): IndexEntry => ({
  ...entry,
  flags: { ...entry.flags, skipWorktree: false },
});

export const clearSkipWorktreeFromPresentFiles = async (
  ctx: Context,
  index: GitIndex,
): Promise<GitIndex> => {
  const { workDir } = ctx.layout;
  if (workDir === undefined) return index;
  const candidates = skipWorktreeCandidates(index);
  if (candidates.length === 0) return index;
  const { enabled, expectFilesOutsideOfPatterns } = await readSparseConfig(ctx);
  if (!enabled || expectFilesOutsideOfPatterns) return index;
  const present = await presentPaths(
    candidates.map((entry) => entry.path),
    (path) => lstatSucceeds(ctx.fs, joinPath(workDir, path)),
  );
  if (present.size === 0) return index;
  const entries = index.entries.map((entry) =>
    isCandidate(entry) && present.has(entry.path) ? withBitCleared(entry) : entry,
  );
  return { ...index, entries };
};
