/**
 * What stands in the working tree where a changeset is about to write, weighed
 * the way git's `verify_absent` / `check_leading_path` weigh it: one classifier
 * shared by every pre-flight, so a clash is named identically wherever it is found.
 */
import { errorDataCode } from '../../../domain/error-data-code.js';
import type { IndexEntry } from '../../../domain/git-index/index-entry.js';
import { deriveWorkingMode } from '../../../domain/objects/file-mode.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';
import type { FileStat } from '../../../ports/file-system.js';
import { compareFile, isWorkingTreeModified, scopeOf } from '../compare-working-tree-entry.js';
import { createConcurrencyLimiter } from './concurrency-limiter.js';
import { lstatIfPresent, lstatIfReachable } from './fs-probes.js';
import { buildRepoIgnorePredicate } from './ignore-evaluator.js';
import { type IndexMtime, isRacy, matchesContentStat } from './is-entry-stat-clean.js';
import { joinPath } from './join-working-tree-path.js';
import { lazily } from './lazily.js';
import { buildCheckinAttributeProvider } from './read-gitattributes.js';
import { requireWorkTree } from './repo-state.js';
import type { LeadingPathScanner } from './symlinked-leading-path.js';

export type IgnoredProbe = (absPath: string, isDirectory: boolean) => Promise<boolean>;

// A tracked path's index entry with the mtime of the index it came from (the racy-guard reference).
export interface TrackedStat {
  readonly entry: IndexEntry;
  readonly indexMtime: IndexMtime | undefined;
}

export type TrackedLookup = (path: FilePath) => Promise<TrackedStat | undefined>;

// What the clash check weighs an occupant against: the paths the changeset deletes,
// the repo's ignore rules (git removes ignored files along with a directory that
// becomes a file), and the files or symlinks standing where a directory is due.
export interface ClashScope {
  readonly workdir: string;
  readonly removed: ReadonlySet<string>;
  readonly isIgnoredPath: IgnoredProbe;
  readonly scanner: LeadingPathScanner;
  // The index entry whose cached stat judges a path reached through a symlinked directory.
  readonly tracked: TrackedLookup;
}

export interface OccupantClash {
  readonly class: 'local-changes' | 'untracked';
  readonly path: FilePath;
}

export type OccupantVerdict =
  | { readonly kind: 'clash'; readonly clash: OccupantClash }
  | { readonly kind: 'clear' }
  // A plain file or symlink stands at the path (the probe saw it): the caller hashes it against the index.
  | { readonly kind: 'compare-content' };

export type OccupantShape =
  | { readonly kind: 'add'; readonly path: FilePath }
  | { readonly kind: 'update' | 'delete'; readonly path: FilePath };

const CLEAR: OccupantVerdict = { kind: 'clear' };
const COMPARE_CONTENT: OccupantVerdict = { kind: 'compare-content' };

export const repoRelativePath = (ctx: Context, absPath: string): FilePath =>
  absPath.slice(requireWorkTree(ctx, 'isWorkingTreeDirty').length + 1) as FilePath;

// One ignore predicate per probe, built on first use. It grows a shared stack as it
// meets directories, so concurrent questions are answered one at a time.
export const createIgnoredProbe = (ctx: Context): IgnoredProbe => {
  const predicate = lazily(() => buildRepoIgnorePredicate(ctx));
  const oneAtATime = createConcurrencyLimiter(1);
  return (absPath, isDirectory) =>
    oneAtATime.run(async () => (await predicate())(repoRelativePath(ctx, absPath), isDirectory));
};

// Whether a child of a directory that becomes a file outlives the changeset: a file
// the changeset does not delete and the ignore rules do not match is an untracked
// occupant, while emptied directories go away with it.
const childSurvives = async (
  ctx: Context,
  absDir: string,
  child: { readonly name: string; readonly isDirectory: boolean },
  scope: ClashScope,
): Promise<boolean> => {
  const absChild = joinPath(absDir, child.name);
  if (!child.isDirectory && scope.removed.has(absChild)) return false;
  if (await scope.isIgnoredPath(absChild, child.isDirectory)) return false;
  return child.isDirectory ? holdsSurvivor(ctx, absChild, scope) : true;
};

export const holdsSurvivor = async (
  ctx: Context,
  absDir: string,
  scope: ClashScope,
): Promise<boolean> => {
  for (const child of await ctx.fs.readdir(absDir)) {
    if (await childSurvives(ctx, absDir, child, scope)) return true;
  }
  return false;
};

const untracked = (path: FilePath): OccupantVerdict => ({
  kind: 'clash',
  clash: { class: 'untracked', path },
});

// git's check_leading_path: a file or symlink standing where a leading directory must
// be is the clash, named in place of the added path — unless the changeset deletes it
// or the ignore rules cover it. Nothing beyond it is looked at.
const classifyLeadingObstruction = async (
  path: FilePath,
  scope: ClashScope,
): Promise<OccupantVerdict | undefined> => {
  const obstruction = await scope.scanner.obstructingLeadingComponent(path);
  if (obstruction === undefined) return undefined;
  const absObstruction = joinPath(scope.workdir, obstruction.path);
  if (scope.removed.has(absObstruction)) return CLEAR;
  return (await scope.isIgnoredPath(absObstruction, false)) ? CLEAR : untracked(obstruction.path);
};

// A directory at an added path is the tracked tree being swapped for a file: its
// tracked children arrive as `delete` entries and are dirty-checked on their own.
const classifyAddedPath = async (
  ctx: Context,
  path: FilePath,
  scope: ClashScope,
): Promise<OccupantVerdict> => {
  const absPath = joinPath(scope.workdir, path);
  const stat = await lstatIfReachable(ctx.fs, absPath);
  if (stat === undefined) return CLEAR;
  if (stat.isDirectory) return (await holdsSurvivor(ctx, absPath, scope)) ? untracked(path) : CLEAR;
  return (await scope.isIgnoredPath(absPath, false)) ? CLEAR : untracked(path);
};

const localChange = (path: FilePath): OccupantVerdict => ({
  kind: 'clash',
  clash: { class: 'local-changes', path },
});

const UNREACHABLE = Symbol('unreachable');

// git's lstat of the whole path: ENOENT reads as absent, ENOTDIR as unreachable.
const lstatBeyondLink = async (
  ctx: Context,
  absPath: string,
): Promise<FileStat | undefined | typeof UNREACHABLE> => {
  try {
    return await lstatIfPresent(ctx.fs, absPath);
  } catch (err) {
    if (errorDataCode(err) === 'NOT_A_DIRECTORY') return UNREACHABLE;
    throw err;
  }
};

// git's `ie_match_stat`: the cached stat fields settle it, and a racy entry (its mtime not
// older than the index file's) is settled by the content instead.
const matchesCachedStat = async (
  ctx: Context,
  { entry, indexMtime }: TrackedStat,
  absPath: string,
  stat: FileStat,
): Promise<boolean> => {
  if (entry.flags.assumeValid) return true;
  if (deriveWorkingMode(stat) !== entry.mode || !matchesContentStat(entry, stat)) return false;
  if (indexMtime !== undefined && !isRacy(entry, indexMtime)) return true;
  const provider = await buildCheckinAttributeProvider(ctx);
  const { status } = await compareFile(ctx, entry, absPath, stat, scopeOf(provider));
  return !isWorkingTreeModified(status);
};

// The leading symlink is followed, as git's verify_uptodate lstat()s the whole path: nothing
// beyond it reads as the entry deleted, a file in the way as a change, and what is reached
// is a change only when it no longer matches the index entry's cached stat.
const classifyThroughLink = async (
  ctx: Context,
  path: FilePath,
  scope: Pick<ClashScope, 'workdir' | 'tracked'>,
): Promise<OccupantVerdict> => {
  const absPath = joinPath(scope.workdir, path);
  const reached = await lstatBeyondLink(ctx, absPath);
  if (reached === undefined) return CLEAR;
  if (reached === UNREACHABLE) return localChange(path);
  const tracked = await scope.tracked(path);
  if (tracked === undefined) return localChange(path);
  return (await matchesCachedStat(ctx, tracked, absPath, reached)) ? CLEAR : localChange(path);
};

// A file or symlink standing where a leading directory of a changed path must be: a regular
// file makes the path unreachable and reads as a change; a symlink is followed.
export const classifyBeneathObstruction = async (
  ctx: Context,
  path: FilePath,
  scope: Pick<ClashScope, 'workdir' | 'scanner' | 'tracked'>,
): Promise<OccupantVerdict | undefined> => {
  const obstruction = await scope.scanner.obstructingLeadingComponent(path);
  if (obstruction === undefined) return undefined;
  if (obstruction.kind === 'file') return localChange(path);
  return classifyThroughLink(ctx, path, scope);
};

// git's verify_uptodate lstat()s the entry and only ENOENT reads as absent: a
// directory standing at the path is a change (an emptied or ignored-only one when
// the entry is deleted).
const classifyChangedPath = async (
  ctx: Context,
  shape: Extract<OccupantShape, { readonly kind: 'update' | 'delete' }>,
  scope: ClashScope,
): Promise<OccupantVerdict> => {
  const beneath = await classifyBeneathObstruction(ctx, shape.path, scope);
  if (beneath !== undefined) return beneath;
  const absPath = joinPath(scope.workdir, shape.path);
  const stat = await lstatIfReachable(ctx.fs, absPath);
  if (stat === undefined) return CLEAR;
  if (!stat.isDirectory) return COMPARE_CONTENT;
  if (shape.kind === 'update') return localChange(shape.path);
  return (await holdsSurvivor(ctx, absPath, scope))
    ? untracked(shape.path)
    : localChange(shape.path);
};

export const classifyOccupant = async (
  ctx: Context,
  shape: OccupantShape,
  scope: ClashScope,
): Promise<OccupantVerdict> => {
  switch (shape.kind) {
    case 'add':
      return (
        (await classifyLeadingObstruction(shape.path, scope)) ??
        classifyAddedPath(ctx, shape.path, scope)
      );
    case 'update':
    case 'delete':
      return classifyChangedPath(ctx, shape, scope);
  }
};
