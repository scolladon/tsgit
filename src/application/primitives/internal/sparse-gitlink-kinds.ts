import type { IndexEntry } from '../../../domain/git-index/index.js';
import { isLossy } from '../../../domain/git-index/index-path-key.js';
import type { MergeOutcome } from '../../../domain/merge/index.js';
import { FILE_MODE, type FilePath } from '../../../domain/objects/index.js';
import type { SparseMatcher } from '../../../domain/sparse/index.js';
import type { Context } from '../../../ports/context.js';
import { lstatIfReachable } from './fs-probes.js';
import { joinPath } from './join-working-tree-path.js';
import { requireWorkTree } from './repo-state.js';

/** The part of an index entry or tree leaf that tells a gitlink and where it lies. */
export interface KindCandidate {
  readonly path: FilePath;
  readonly mode: string;
  readonly pathBytes?: Uint8Array;
}

/** What git decided before it looked at the work tree: a refreshed index marks each skip-worktree entry up to date. */
export interface AssumedKinds {
  /** Up-to-date gitlinks: directories whatever stands at their path. */
  readonly directories?: ReadonlyArray<FilePath>;
  /** Up-to-date files: never probed, a directory at their path does not make them directories. */
  readonly files?: ReadonlyArray<FilePath>;
}

/** The skip-worktree entries among `entries`, which a refresh marks up to date: gitlinks are directories, anything else a file. */
export const upToDateKinds = (
  entries: ReadonlyArray<KindCandidate & { readonly flags: { readonly skipWorktree: boolean } }>,
): AssumedKinds => {
  const skipped = entries.filter((e) => e.flags.skipWorktree && !isLossy(e));
  const isGitlink = (e: KindCandidate): boolean => e.mode === FILE_MODE.GITLINK;
  return {
    directories: skipped.filter(isGitlink).map((e) => e.path),
    files: skipped.filter((e) => !isGitlink(e)).map((e) => e.path),
  };
};

/** Whether a directory-only rule could tell the path's two kinds apart: only then does what stands there matter. */
const kindMatters = (sparse: SparseMatcher, path: FilePath): boolean =>
  sparse(path, 'directory') !== sparse(path, 'file');

/**
 * git cannot read the kind of an index entry from its mode, so it asks the index (an up-to-date
 * entry keeps its mode's kind) and then the work tree: a directory standing at the path of an
 * entry makes it a directory, which is what a directory-only pattern judges. A lossy path is
 * never probed — its decoded name is another file.
 */
const presentDirectories = async (
  ctx: Context,
  workdir: string,
  sparse: SparseMatcher,
  candidates: ReadonlyArray<Iterable<KindCandidate>>,
  upToDateFiles: ReadonlySet<FilePath>,
): Promise<ReadonlySet<FilePath>> => {
  const directories = new Set<FilePath>();
  for (const group of candidates) {
    for (const candidate of group) {
      if (isLossy(candidate) || upToDateFiles.has(candidate.path)) continue;
      if (!kindMatters(sparse, candidate.path)) continue;
      const stat = await lstatIfReachable(ctx.fs, joinPath(workdir, candidate.path));
      if (stat?.isDirectory === true) directories.add(candidate.path);
    }
  }
  return directories;
};

/**
 * `sparse` judging each of `candidates` by what stands at its path, and each assumed directory as
 * a directory whatever stands there. The matcher is
 * returned as given when sparse checkout is off or no gitlink has a directory, so the common case
 * costs no wrapper.
 */
export async function withGitlinkKinds(
  ctx: Context,
  operation: string,
  sparse: SparseMatcher,
  candidates: ReadonlyArray<Iterable<KindCandidate>>,
  assumed?: AssumedKinds,
): Promise<SparseMatcher>;
export async function withGitlinkKinds(
  ctx: Context,
  operation: string,
  sparse: SparseMatcher | undefined,
  candidates: ReadonlyArray<Iterable<KindCandidate>>,
  assumed?: AssumedKinds,
): Promise<SparseMatcher | undefined>;
export async function withGitlinkKinds(
  ctx: Context,
  operation: string,
  sparse: SparseMatcher | undefined,
  candidates: ReadonlyArray<Iterable<KindCandidate>>,
  assumed: AssumedKinds = {},
): Promise<SparseMatcher | undefined> {
  if (sparse === undefined) return undefined;
  const directories = new Set(assumed.directories);
  const present = await presentDirectories(
    ctx,
    requireWorkTree(ctx, operation),
    sparse,
    candidates,
    new Set(assumed.files),
  );
  for (const path of present) directories.add(path);
  if (directories.size === 0) return sparse;
  return (path, kind) => sparse(path, kind ?? (directories.has(path) ? 'directory' : 'file'));
}

/** How a merge judges its entries: `judging` the matcher to write by, `assumed` what a retirement must judge the same way. */
export interface MergeGitlinkKinds {
  readonly judging: SparseMatcher | undefined;
  readonly assumed: AssumedKinds;
}

const moddedOutcomes = (outcomes: ReadonlyArray<MergeOutcome>): ReadonlyArray<KindCandidate> =>
  outcomes.flatMap((outcome) => ('mode' in outcome ? [outcome] : []));

/**
 * The kinds of the entries a merge meets, in the index and in its result. An operation that
 * refreshes the index first (git's `merge`) also takes each skip-worktree entry as up to date.
 */
export const mergeGitlinkKinds = async (
  ctx: Context,
  sparse: SparseMatcher | undefined,
  entries: ReadonlyArray<IndexEntry>,
  outcomes: ReadonlyArray<MergeOutcome>,
  refreshedIndex: boolean,
): Promise<MergeGitlinkKinds> => {
  const assumed = refreshedIndex ? upToDateKinds(entries) : {};
  const judging = await withGitlinkKinds(
    ctx,
    'merge',
    sparse,
    [entries, moddedOutcomes(outcomes)],
    assumed,
  );
  return { judging, assumed };
};
