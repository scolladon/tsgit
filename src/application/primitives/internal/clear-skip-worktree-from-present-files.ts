/**
 * Clear the skip-worktree bit of an entry whose path exists in the working tree, as git does on
 * every index read unless `sparse.expectFilesOutsideOfPatterns` is set. The clear is in memory
 * only; it never writes the index.
 */
import type { GitIndex, IndexEntry } from '../../../domain/git-index/index.js';
import { isLossy } from '../../../domain/git-index/index-path-key.js';
import {
  presentPaths,
  presentPathsSync,
  type SyncPass,
} from '../../../domain/sparse/missing-directory.js';
import type { Context } from '../../../ports/context.js';
import type { FileSystem } from '../../../ports/file-system.js';
import { readSparseConfig } from '../read-sparse-config.js';
import { boundedMapFor } from './concurrency.js';
import { joinPath } from './join-working-tree-path.js';

/** Per index object, so a cached parse pays the scan once. */
const candidatePathsOf = new WeakMap<GitIndex, ReadonlyArray<string>>();

const isCandidate = (entry: IndexEntry): boolean => entry.flags.skipWorktree && !isLossy(entry);

const skipWorktreeCandidatePaths = (index: GitIndex): ReadonlyArray<string> => {
  const known = candidatePathsOf.get(index);
  if (known !== undefined) return known;
  const scanned = index.entries.filter(isCandidate).map((entry) => entry.path);
  candidatePathsOf.set(index, scanned);
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

/** Index-ordered runs: async runs are probed independently, each with its own missing-directory cache; sync runs carry the last missing directory forward. */
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

interface RunOutcome extends SyncPass {
  /** Every probe of the run was answered, so `present` is complete. */
  readonly answerable: boolean;
}

/** One run in a synchronous pass; stops asking once a probe cannot answer (the turn's budget is spent, or the roots are not resolved yet). */
const presentByRunSync = (
  probe: (path: string) => boolean | undefined,
  workDir: string,
  run: ReadonlyArray<string>,
  missing: string,
): RunOutcome => {
  let answerable = true;
  const pass = presentPathsSync(
    run,
    (path) => {
      if (!answerable) return false;
      const answer = syncPresence(probe, joinPath(workDir, path));
      answerable = answer !== undefined;
      return answer === true;
    },
    missing,
  );
  return { ...pass, answerable };
};

/**
 * Synchronous while the adapter answers, run by run, a missing directory carried from one run to
 * the next. A run the adapter cannot finish is redone through the async probe, which waits for the
 * next turn, then the sync walk resumes: the event loop is never held past the adapter's budget,
 * and a turn already spent when the walk starts costs one run, not the whole walk. An adapter
 * offering no synchronous probe (the `threadpool` opt-out) takes the concurrent async walk
 * throughout.
 */
const presentBySyncProbe = async (
  ctx: Context,
  workDir: string,
  paths: ReadonlyArray<string>,
): Promise<ReadonlySet<string>> => {
  const probe = ctx.fs.lstatReachableSync?.bind(ctx.fs);
  if (probe === undefined) return presentByAsyncProbe(ctx, workDir, paths);
  const found: ReadonlySet<string>[] = [];
  let missing = '';
  for (const run of runsOf(paths)) {
    const outcome = presentByRunSync(probe, workDir, run, missing);
    found.push(outcome.answerable ? outcome.present : await presentByAsyncProbe(ctx, workDir, run));
    missing = outcome.answerable ? outcome.missing : '';
  }
  return new Set(found.flatMap((present) => [...present]));
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
  const candidates = skipWorktreeCandidatePaths(index);
  if (candidates.length === 0) return index;
  const { enabled, expectFilesOutsideOfPatterns } = await readSparseConfig(ctx);
  if (!enabled || expectFilesOutsideOfPatterns) return index;
  const present = await presentBySyncProbe(ctx, workDir, candidates);
  if (present.size === 0) return index;
  const entries = index.entries.map((entry) =>
    isCandidate(entry) && present.has(entry.path) ? withBitCleared(entry) : entry,
  );
  return { ...index, entries };
};
