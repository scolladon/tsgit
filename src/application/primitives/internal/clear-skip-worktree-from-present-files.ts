/**
 * Clear the skip-worktree bit of an entry whose path exists in the working tree, as git does on
 * every index read unless `sparse.expectFilesOutsideOfPatterns` is set. The clear is in memory
 * only; it never writes the index.
 */
import type { GitIndex, IndexEntry } from '../../../domain/git-index/index.js';
import { isLossy } from '../../../domain/git-index/index-path-key.js';
import { presentPaths, presentPathsSync } from '../../../domain/sparse/missing-directory.js';
import type { Context } from '../../../ports/context.js';
import type { FileSystem } from '../../../ports/file-system.js';
import { readSparseConfig } from '../read-sparse-config.js';
import { boundedMapFor } from './concurrency.js';
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
    if (fs.lstatIfReachable !== undefined) return (await fs.lstatIfReachable(path)) !== undefined;
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
};

/** Index-ordered runs probed independently: each keeps its own missing-directory cache, so runs share no state. */
const RUN_LENGTH = 64;

const runsOf = (paths: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> => {
  const runs: string[][] = [];
  for (let from = 0; from < paths.length; from += RUN_LENGTH) {
    runs.push(paths.slice(from, from + RUN_LENGTH));
  }
  return runs;
};

/** A throw reads absent, like every other refusal; `undefined` is "cannot answer synchronously". */
const syncPresence = (probe: (path: string) => boolean | undefined, path: string) => {
  try {
    return probe(path);
  } catch {
    return false;
  }
};

/** The whole walk in one synchronous pass, or `undefined` when the file system cannot answer one probe. */
const presentBySyncProbe = (
  fs: FileSystem,
  workDir: string,
  paths: ReadonlyArray<string>,
): ReadonlySet<string> | undefined => {
  const probe = fs.lstatReachableSync?.bind(fs);
  if (probe === undefined) return undefined;
  let answerable = true;
  const present = presentPathsSync(paths, (path) => {
    const answer = syncPresence(probe, joinPath(workDir, path));
    answerable &&= answer !== undefined;
    return answer === true;
  });
  return answerable ? present : undefined;
};

const presentByAsyncProbe = async (
  ctx: Context,
  workDir: string,
  paths: ReadonlyArray<string>,
): Promise<ReadonlySet<string>> => {
  const probe = (path: string): Promise<boolean> => lstatSucceeds(ctx.fs, joinPath(workDir, path));
  const found = await boundedMapFor(ctx, 'ioBound', runsOf(paths), (run) =>
    presentPaths(run, probe),
  );
  return new Set(found.flatMap((present) => [...present]));
};

const probedPresent = async (
  ctx: Context,
  workDir: string,
  paths: ReadonlyArray<string>,
): Promise<ReadonlySet<string>> =>
  presentBySyncProbe(ctx.fs, workDir, paths) ?? presentByAsyncProbe(ctx, workDir, paths);

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
  const present = await probedPresent(
    ctx,
    workDir,
    candidates.map((entry) => entry.path),
  );
  if (present.size === 0) return index;
  const entries = index.entries.map((entry) =>
    isCandidate(entry) && present.has(entry.path) ? withBitCleared(entry) : entry,
  );
  return { ...index, entries };
};
