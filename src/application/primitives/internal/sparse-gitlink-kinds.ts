import { isLossy } from '../../../domain/git-index/index-path-key.js';
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

/** The skip-worktree gitlinks among `entries`: a switch refreshes the index first, which marks them up to date, and an up-to-date gitlink is a directory. */
export const skippedGitlinkPaths = (
  entries: ReadonlyArray<KindCandidate & { readonly flags: { readonly skipWorktree: boolean } }>,
): ReadonlyArray<FilePath> =>
  entries
    .filter((e) => e.mode === FILE_MODE.GITLINK && e.flags.skipWorktree && !isLossy(e))
    .map((e) => e.path);

/**
 * git cannot read the kind of an index entry from its mode, so it asks the index (an up-to-date
 * gitlink is a directory) and then the work tree: a directory standing at its path makes the
 * gitlink a directory, which is what a directory-only pattern judges. A lossy path is never
 * probed — its decoded name is another file.
 */
const presentGitlinkDirectories = async (
  ctx: Context,
  workdir: string,
  candidates: ReadonlyArray<Iterable<KindCandidate>>,
): Promise<ReadonlySet<FilePath>> => {
  const directories = new Set<FilePath>();
  for (const group of candidates) {
    for (const candidate of group) {
      if (candidate.mode !== FILE_MODE.GITLINK || isLossy(candidate)) continue;
      const stat = await lstatIfReachable(ctx.fs, joinPath(workdir, candidate.path));
      if (stat?.isDirectory === true) directories.add(candidate.path);
    }
  }
  return directories;
};

/**
 * `sparse` judging each gitlink among `candidates` by what stands at its path, and each of
 * `assumedDirectories` as a directory whatever stands there. The matcher is
 * returned as given when sparse checkout is off or no gitlink has a directory, so the common case
 * costs no wrapper.
 */
export async function withGitlinkKinds(
  ctx: Context,
  operation: string,
  sparse: SparseMatcher,
  candidates: ReadonlyArray<Iterable<KindCandidate>>,
  assumedDirectories?: ReadonlyArray<FilePath>,
): Promise<SparseMatcher>;
export async function withGitlinkKinds(
  ctx: Context,
  operation: string,
  sparse: SparseMatcher | undefined,
  candidates: ReadonlyArray<Iterable<KindCandidate>>,
  assumedDirectories?: ReadonlyArray<FilePath>,
): Promise<SparseMatcher | undefined>;
export async function withGitlinkKinds(
  ctx: Context,
  operation: string,
  sparse: SparseMatcher | undefined,
  candidates: ReadonlyArray<Iterable<KindCandidate>>,
  assumedDirectories: ReadonlyArray<FilePath> = [],
): Promise<SparseMatcher | undefined> {
  if (sparse === undefined) return undefined;
  const directories = new Set(assumedDirectories);
  const present = await presentGitlinkDirectories(ctx, requireWorkTree(ctx, operation), candidates);
  for (const path of present) directories.add(path);
  if (directories.size === 0) return sparse;
  return (path, kind) => sparse(path, kind ?? (directories.has(path) ? 'directory' : 'file'));
}
