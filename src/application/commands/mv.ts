/**
 * `mv` porcelain — rename/move tracked paths in the index and working tree,
 * faithful to `git mv`. The resulting index + tree read back (via
 * `git ls-files --stage` / `git write-tree`) match canonical git; raw index
 * bytes differ only by per-host stat-cache fields.
 *
 * @writes
 *   surface: mv
 *   kind:    equivalent-under-readback
 *   format:  git-index-tree-state
 */
import {
  mvBadSource,
  mvDestinationDirectoryMissing,
  mvDestinationExists,
  mvDestinationNotDirectory,
  mvIntoSelf,
  mvMultipleSourcesSameTarget,
  mvOverlappingSources,
  mvSourceNotTracked,
} from '../../domain/commands/error.js';
import { basename, dirname, TsgitError } from '../../domain/error.js';
import type { IndexEntry } from '../../domain/git-index/index.js';
import { emptyPathspec } from '../../domain/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { joinPathSegment } from '../primitives/internal/join-path-segment.js';
import { joinPath } from '../primitives/internal/join-working-tree-path.js';
import { readIndex } from '../primitives/read-index.js';
import { acquireIndexLock } from './internal/index-update.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertOperationalRepository,
} from './internal/repo-state.js';
import { renameInWorkingTree, validatePath } from './internal/working-tree.js';

// Same tolerance set as `rm`: a missing-or-unparsable index is treated as
// "no entries" so a refusal is still computed off the empty map; every other
// read error propagates. A predicate (not a Set) so each literal is attributed
// per-test under mutation coverage.
const isIndexMissingCode = (code: string): boolean =>
  code === 'FILE_NOT_FOUND' || code === 'INVALID_INDEX_HEADER' || code === 'INVALID_INDEX_ENTRY';

export interface MvOptions {
  /** Overwrite an existing destination (a file source only). `-f`. */
  readonly force?: boolean;
  /** Validate and report the plan without touching index or working tree. `-n`. */
  readonly dryRun?: boolean;
  /** Skip refused (source → target) pairs instead of aborting the whole call. `-k`. */
  readonly skipErrors?: boolean;
}

export interface MvMove {
  readonly from: FilePath;
  readonly to: FilePath;
}

/** Per-source refusals that `skipErrors` collects rather than throwing. */
export type MvSkipReason = 'source-not-tracked' | 'bad-source' | 'destination-exists' | 'into-self';

export interface MvSkipped {
  readonly source: FilePath;
  readonly reason: MvSkipReason;
}

export interface MvResult {
  readonly moved: ReadonlyArray<MvMove>;
  readonly skipped: ReadonlyArray<MvSkipped>;
}

type DestinationMode =
  | { readonly kind: 'rename'; readonly target: FilePath }
  | { readonly kind: 'into-dir'; readonly destDir: FilePath };

interface PlanItem {
  readonly source: FilePath;
  readonly target: FilePath;
  readonly entries: ReadonlyArray<IndexEntry>;
}

type Verdict =
  | { readonly kind: 'file' | 'directory'; readonly entries: ReadonlyArray<IndexEntry> }
  | { readonly skip: MvSkipReason };

/**
 * Move/rename tracked paths in the index and the working tree, faithful to
 * `git mv`. Each (source → target) pair is validated up front; on any refusal
 * nothing is moved (unless `skipErrors`). Blob ids and modes are copied from the
 * source's index entry — the working file is renamed as-is, never re-hashed.
 */
export const mv = async (
  ctx: Context,
  sources: ReadonlyArray<string>,
  destination: string,
  opts: MvOptions = {},
): Promise<MvResult> => {
  await assertOperationalRepository(ctx);
  await assertNotBare(ctx, 'mv');
  await assertNoPendingOperation(ctx);
  const validatedSources = sources.map((source) => validatePath(source));
  const [firstSource] = validatedSources;
  if (firstSource === undefined) throw emptyPathspec();
  assertNoOverlappingSources(validatedSources);
  const destNoSlash = validatePath(stripTrailingSlash(destination));

  const lock = await acquireIndexLock(ctx);
  try {
    const byPath = await readIndexMap(ctx);
    const mode = await resolveDestinationMode(ctx, firstSource, destination, destNoSlash);
    if (mode.kind === 'rename' && validatedSources.length > 1) {
      throw mvDestinationNotDirectory(firstSource, mode.target);
    }
    const { planned, skipped } = await buildPlan(ctx, byPath, validatedSources, mode, opts);
    assertNoTargetCollision(planned);
    const moved = plannedMoves(planned);
    if (opts.dryRun === true) return { moved, skipped };
    applyToIndex(byPath, planned);
    for (const item of planned) {
      await renameInWorkingTree(ctx, item.source, item.target);
    }
    await lock.commit(Array.from(byPath.values()));
    return { moved, skipped };
  } finally {
    await lock.release();
  }
};

const readIndexMap = async (ctx: Context): Promise<Map<FilePath, IndexEntry>> => {
  const index = await readIndex(ctx).catch((err: unknown) => {
    if (err instanceof TsgitError && isIndexMissingCode(err.data.code)) {
      return { entries: [] as ReadonlyArray<IndexEntry> };
    }
    throw err;
  });
  const byPath = new Map<FilePath, IndexEntry>();
  for (const entry of index.entries) byPath.set(entry.path, entry);
  return byPath;
};

const resolveDestinationMode = async (
  ctx: Context,
  firstSource: FilePath,
  destination: string,
  destNoSlash: FilePath,
): Promise<DestinationMode> => {
  const stat = await lstatOrUndefined(ctx, destNoSlash);
  // equivalent-mutant: lstat never reports a path as both a directory and a symlink
  // (it does not follow the final component), so when `isDirectory === true` the
  // `isSymbolicLink !== true` operand is always true — the guard stays defensive for
  // adapters that might diverge from that contract.
  if (stat?.isDirectory === true && stat.isSymbolicLink !== true) {
    return { kind: 'into-dir', destDir: destNoSlash };
  }
  if (destination.endsWith('/')) {
    // A trailing slash forces directory interpretation; the directory is absent.
    // `destination` (with its slash) is display-only here, never operated on.
    throw mvDestinationDirectoryMissing(firstSource, destination as FilePath);
  }
  return { kind: 'rename', target: destNoSlash };
};

interface Plan {
  readonly planned: ReadonlyArray<PlanItem>;
  readonly skipped: ReadonlyArray<MvSkipped>;
}

const buildPlan = async (
  ctx: Context,
  byPath: ReadonlyMap<FilePath, IndexEntry>,
  sources: ReadonlyArray<FilePath>,
  mode: DestinationMode,
  opts: MvOptions,
): Promise<Plan> => {
  const planned: PlanItem[] = [];
  const skipped: MvSkipped[] = [];
  for (const source of sources) {
    const target =
      mode.kind === 'rename'
        ? mode.target
        : (joinPathSegment(mode.destDir, basename(source)) as FilePath);
    const verdict = await validateMove(ctx, byPath, source, target, opts);
    if ('skip' in verdict) {
      if (opts.skipErrors === true) {
        skipped.push({ source, reason: verdict.skip });
        continue;
      }
      throw refusal(verdict.skip, source, target);
    }
    planned.push({ source, target, entries: verdict.entries });
  }
  return { planned, skipped };
};

const validateMove = async (
  ctx: Context,
  byPath: ReadonlyMap<FilePath, IndexEntry>,
  source: FilePath,
  target: FilePath,
  opts: MvOptions,
): Promise<Verdict> => {
  const classified = classifySource(byPath, source);
  if (classified.kind === 'untracked') return { skip: 'source-not-tracked' };
  if (!(await sourceExistsOnDisk(ctx, source, classified.kind))) return { skip: 'bad-source' };
  if (target === source || target.startsWith(`${source}/`)) return { skip: 'into-self' };
  // `dirname` of a validated path is a prefix of it — still a valid repo path.
  const parent = dirname(target) as FilePath;
  // equivalent-mutant: an empty parent is the work-tree root, which
  // `isDirectoryOnDisk('')` always reports as a directory, so the `parent !== ''`
  // short-circuit only spares a redundant lstat — mutating the operand (or the `''`
  // literal) yields the same no-throw result.
  if (parent !== '' && !(await isDirectoryOnDisk(ctx, parent))) {
    throw mvDestinationDirectoryMissing(source, target);
  }
  if (!(await destinationFree(ctx, byPath, target, classified.kind, opts.force === true))) {
    return { skip: 'destination-exists' };
  }
  return { kind: classified.kind, entries: classified.entries };
};

type SourceClass =
  | { readonly kind: 'file'; readonly entries: ReadonlyArray<IndexEntry> }
  | { readonly kind: 'directory'; readonly entries: ReadonlyArray<IndexEntry> }
  | { readonly kind: 'untracked' };

const classifySource = (
  byPath: ReadonlyMap<FilePath, IndexEntry>,
  source: FilePath,
): SourceClass => {
  const exact = byPath.get(source);
  if (exact !== undefined) return { kind: 'file', entries: [exact] };
  const prefix = `${source}/`;
  const entries = Array.from(byPath.values()).filter((entry) => entry.path.startsWith(prefix));
  if (entries.length > 0) return { kind: 'directory', entries };
  return { kind: 'untracked' };
};

const sourceExistsOnDisk = async (
  ctx: Context,
  source: FilePath,
  kind: 'file' | 'directory',
): Promise<boolean> => {
  const stat = await lstatOrUndefined(ctx, source);
  if (stat === undefined) return false;
  if (kind === 'directory') return stat.isDirectory && !stat.isSymbolicLink;
  return stat.isFile || stat.isSymbolicLink;
};

const destinationFree = async (
  ctx: Context,
  byPath: ReadonlyMap<FilePath, IndexEntry>,
  target: FilePath,
  kind: 'file' | 'directory',
  force: boolean,
): Promise<boolean> => {
  const exists = byPath.has(target) || (await lstatOrUndefined(ctx, target)) !== undefined;
  if (!exists) return true;
  // `force` overwrites only a file source; a directory source over an existing
  // path is always refused (verified against git: `mv -f dir present-file` fails).
  return kind === 'file' && force;
};

// Refuse moving both a directory and something inside it (`mv a a/b dir`) — the
// shared subtree would be relocated twice. Faithful to git's
// "cannot move both 'a/b' and its parent directory 'a'".
const assertNoOverlappingSources = (sources: ReadonlyArray<FilePath>): void => {
  for (const parent of sources) {
    for (const child of sources) {
      // equivalent-mutant: a path never startsWith(itself + '/'), so the self-pair is
      // already excluded by the startsWith check; the `child !== parent` operand is
      // redundant and forcing it true cannot change the outcome.
      if (child !== parent && child.startsWith(`${parent}/`)) {
        throw mvOverlappingSources(child, parent);
      }
    }
  }
};

const assertNoTargetCollision = (planned: ReadonlyArray<PlanItem>): void => {
  const seen = new Set<FilePath>();
  for (const item of planned) {
    if (seen.has(item.target)) throw mvMultipleSourcesSameTarget(item.source, item.target);
    seen.add(item.target);
  }
};

const plannedMoves = (planned: ReadonlyArray<PlanItem>): ReadonlyArray<MvMove> => {
  const moves: MvMove[] = [];
  for (const item of planned) {
    for (const entry of item.entries) {
      moves.push({ from: entry.path, to: repath(entry, item.source, item.target) });
    }
  }
  // equivalent-mutant: a move set has unique `from` paths, so `a.from === b.from` is
  // unreachable; the tie-branch (0), the `<`/`>` boundary variants, and the second
  // ternary's value are all indistinguishable for an insertion sort over distinct keys
  // (it only ever moves an element on the strictly-less `-1` result).
  return moves.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
};

const applyToIndex = (
  byPath: Map<FilePath, IndexEntry>,
  planned: ReadonlyArray<PlanItem>,
): void => {
  for (const item of planned) {
    for (const entry of item.entries) {
      const newPath = repath(entry, item.source, item.target);
      byPath.delete(entry.path);
      byPath.set(newPath, { ...entry, path: newPath });
    }
  }
};

// `entry.path` is `source` (file) or `${source}/…` (directory member), so the
// suffix after `source` (possibly empty) reparents onto `target` unchanged.
const repath = (entry: IndexEntry, source: FilePath, target: FilePath): FilePath =>
  `${target}${entry.path.slice(source.length)}` as FilePath;

const refusal = (reason: MvSkipReason, source: FilePath, target: FilePath): TsgitError => {
  switch (reason) {
    case 'source-not-tracked':
      return mvSourceNotTracked(source, target);
    case 'bad-source':
      return mvBadSource(source, target);
    case 'destination-exists':
      return mvDestinationExists(source, target);
    case 'into-self':
      return mvIntoSelf(source, target);
  }
};

const stripTrailingSlash = (path: string): string =>
  path.endsWith('/') ? path.slice(0, -1) : path;

const workPath = (ctx: Context, path: FilePath): string => joinPath(ctx.layout.workDir, path);

const lstatOrUndefined = async (
  ctx: Context,
  path: FilePath,
): Promise<Awaited<ReturnType<Context['fs']['lstat']>> | undefined> =>
  ctx.fs.lstat(workPath(ctx, path)).catch(() => undefined);

const isDirectoryOnDisk = async (ctx: Context, path: FilePath): Promise<boolean> => {
  const stat = await lstatOrUndefined(ctx, path);
  // equivalent-mutant: lstat never reports a path as both a directory and a symlink, so
  // when `isDirectory === true` the `isSymbolicLink !== true` operand is always true.
  return stat?.isDirectory === true && stat.isSymbolicLink !== true;
};
