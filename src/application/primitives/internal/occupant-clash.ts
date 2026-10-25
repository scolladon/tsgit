/**
 * What stands in the working tree where a changeset is about to write, weighed
 * the way git's `verify_absent` / `check_leading_path` weigh it: one classifier
 * shared by every pre-flight, so a clash is named identically wherever it is found.
 */
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';
import { createConcurrencyLimiter } from './concurrency-limiter.js';
import { lstatIfReachable } from './fs-probes.js';
import { buildRepoIgnorePredicate } from './ignore-evaluator.js';
import { joinPath } from './join-working-tree-path.js';
import { lazily } from './lazily.js';
import { requireWorkTree } from './repo-state.js';
import type { LeadingPathScanner } from './symlinked-leading-path.js';

export type IgnoredProbe = (absPath: string, isDirectory: boolean) => Promise<boolean>;

// What the clash check weighs an occupant against: the paths the changeset deletes,
// the repo's ignore rules (git removes ignored files along with a directory that
// becomes a file), and the files or symlinks standing where a directory is due.
export interface ClashScope {
  readonly workdir: string;
  readonly removed: ReadonlySet<string>;
  readonly isIgnoredPath: IgnoredProbe;
  readonly scanner: LeadingPathScanner;
}

export interface OccupantClash {
  readonly class: 'local-changes' | 'untracked';
  readonly path: FilePath;
}

export type OccupantVerdict =
  | { readonly kind: 'clash'; readonly clash: OccupantClash }
  | { readonly kind: 'clear' };

export interface OccupantShape {
  readonly kind: 'add';
  readonly path: FilePath;
}

const CLEAR: OccupantVerdict = { kind: 'clear' };

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

export const classifyOccupant = async (
  ctx: Context,
  shape: OccupantShape,
  scope: ClashScope,
): Promise<OccupantVerdict> =>
  (await classifyLeadingObstruction(shape.path, scope)) ??
  classifyAddedPath(ctx, shape.path, scope);
