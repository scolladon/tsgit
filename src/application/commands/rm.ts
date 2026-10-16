/**
 * `rm` porcelain — remove tracked paths from the index (and the working tree
 * unless `cached`), faithful to `git rm`. Before removing, the same safety valve
 * `git rm` runs (`check_local_mod`) refuses paths whose removal would lose
 * un-recoverable changes, unless `force` (or, per category, `cached`) overrides.
 * The resulting index + tree read back (via `git ls-files --stage` /
 * `git write-tree`) match canonical git; raw index bytes differ only by per-host
 * stat-cache fields.
 *
 * @writes
 *   surface: rm
 *   kind:    equivalent-under-readback
 *   format:  git-index-tree-state
 */
import {
  rmLocalModifications,
  rmRecursiveWithoutR,
  rmStagedAndLocalChanges,
  rmStagedChanges,
} from '../../domain/commands/error.js';
import type { FlatTreeEntry } from '../../domain/diff/flat-tree.js';
import { TsgitError } from '../../domain/error.js';
import type { GitIndex, IndexEntry } from '../../domain/git-index/index.js';
import type { IndexPathKey } from '../../domain/git-index/index-path-key.js';
import { escapedPathOf, indexPathKey, isLossy } from '../../domain/git-index/index-path-key.js';
import { emptyPathspec } from '../../domain/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import { matchesIndexPath } from '../../domain/pathspec/matching-path.js';
import type { Context } from '../../ports/context.js';
import {
  compareWorkingTreeEntry,
  isWorkingTreeModified,
} from '../primitives/compare-working-tree-entry.js';
import {
  pruneEmptiedDirectories,
  survivingDirectoriesOf,
} from '../primitives/internal/prune-emptied-directories.js';
import { buildCheckinAttributeProvider } from '../primitives/internal/read-gitattributes.js';
import { readHeadTreeEscaped } from '../primitives/read-head-tree.js';
import { readIndex } from '../primitives/read-index.js';
import { acquireIndexLock } from './internal/index-update.js';
import {
  assertNoPendingOperation,
  assertOperationalRepository,
  requireWorkTree,
} from './internal/repo-state.js';
import { enforceLiteralMustMatch, resolvePathspec } from './internal/resolve-pathspec.js';
import { removeFile } from './internal/working-tree.js';

// A predicate (not a static Set) so Stryker attributes per-test coverage to
// each literal — a module-level `new Set([...])` initializer runs before any
// test, leaving its string mutants unattributed under `coverageAnalysis`.
const isIndexMissingCode = (code: string): boolean =>
  code === 'FILE_NOT_FOUND' || code === 'INVALID_INDEX_HEADER' || code === 'INVALID_INDEX_ENTRY';

export interface RmOptions {
  readonly cached?: boolean;
  /** Override the safety valve (`-f`) — remove even staged / locally-modified paths. */
  readonly force?: boolean;
  /** Allow a pathspec to remove a whole directory (`-r`); without it, git refuses. */
  readonly recursive?: boolean;
}

export interface RmResult {
  readonly removed: ReadonlyArray<FilePath>;
}

/**
 * Remove the given paths from the index (and from the working tree unless
 * `cached: true`). Refuses when a path isn't tracked, matches `git rm`'s default.
 */
export const rm = async (
  ctx: Context,
  paths: ReadonlyArray<string>,
  opts: RmOptions = {},
): Promise<RmResult> => {
  await assertOperationalRepository(ctx);
  requireWorkTree(ctx, 'rm');
  await assertNoPendingOperation(ctx);
  if (paths.length === 0) throw emptyPathspec();
  const { matcher, literalSpellings } = resolvePathspec(paths);
  const lock = await acquireIndexLock(ctx);
  try {
    const index = await readIndex(ctx).catch((err: unknown) => {
      if (err instanceof TsgitError && isIndexMissingCode(err.data.code)) {
        return {
          entries: [] as ReadonlyArray<IndexEntry>,
          indexMtime: undefined as GitIndex['indexMtime'],
        };
      }
      throw err;
    });
    const byPath = new Map<IndexPathKey, IndexEntry>();
    for (const entry of index.entries) byPath.set(indexPathKey(entry), entry);
    const removed: FilePath[] = [];
    const removedKeys: IndexPathKey[] = [];
    const removedEntries: IndexEntry[] = [];
    for (const [key, entry] of byPath) {
      if (matchesIndexPath(matcher, entry)) {
        removed.push(entry.path);
        removedKeys.push(key);
        removedEntries.push(entry);
      }
    }
    enforceLiteralMatches(
      literalSpellings,
      removed,
      opts.recursive === true ? 'recursive' : 'paths-only',
    );
    if (opts.force !== true) {
      await enforceSafetyValve(ctx, removedEntries, opts.cached === true, index.indexMtime);
    }
    for (const key of removedKeys) byPath.delete(key);
    if (!opts.cached) {
      const workingTreeEntries = removedEntries.filter((entry) => !isLossy(entry));
      for (const { path } of workingTreeEntries) {
        // FILE_NOT_FOUND is the only tolerable error: working file already gone.
        await removeFile(ctx, path).catch((err: unknown) => {
          if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return;
          throw err;
        });
      }
      await pruneEmptiedDirectories(
        ctx,
        requireWorkTree(ctx, 'rm'),
        workingTreeEntries.map((entry) => entry.path),
        survivingDirectoriesOf([]),
      );
    }
    await lock.commit(Array.from(byPath.values()), 'update');
    return { removed };
  } finally {
    await lock.release();
  }
};

/** Whether a pathspec may remove the paths beneath a directory (`-r`) or only paths it names. */
type RemovalReach = 'recursive' | 'paths-only';

/**
 * git rm's per-pathspec check, in pathspec order: a literal must match, and
 * under `paths-only`, it must name a tracked path itself — one that only reached
 * paths beneath it is a directory removal git refuses without `-r`.
 */
const enforceLiteralMatches = (
  spellings: ReadonlyMap<FilePath, string>,
  removed: ReadonlyArray<FilePath>,
  reach: RemovalReach,
): void => {
  const exact = new Set<string>(removed);
  for (const [literal, spelled] of spellings) {
    enforceLiteralMustMatch([literal], removed, spellings);
    if (reach === 'paths-only' && !exact.has(literal)) throw rmRecursiveWithoutR(spelled);
  }
};

/**
 * `git rm`'s `check_local_mod` valve. Validates every matched entry up front and
 * removes nothing if any path is refused. A path whose working file is absent is
 * never refused (the deletion is the goal). For a present file:
 * `staged` = index `(id, mode)` differs from HEAD; `local` = working file differs
 * from the index entry. `--cached` (`cached`) suppresses the staged-only and
 * local-only categories but not the combined one — faithful to git.
 */
interface LocalModCategories {
  readonly both: ReadonlyArray<FilePath>;
  readonly stagedOnly: ReadonlyArray<FilePath>;
  readonly localOnly: ReadonlyArray<FilePath>;
}

/** Classify entries by modification category for the safety valve. */
const classifyEntries = async (
  ctx: Context,
  entries: ReadonlyArray<IndexEntry>,
  head: ReadonlyMap<FilePath, FlatTreeEntry>,
  cached: boolean,
  indexMtime: GitIndex['indexMtime'],
): Promise<LocalModCategories> => {
  const provider = await buildCheckinAttributeProvider(ctx);
  const both: FilePath[] = [];
  const stagedOnly: FilePath[] = [];
  const localOnly: FilePath[] = [];
  for (const entry of entries) {
    const worktree = await compareWorkingTreeEntry(ctx, entry, provider, indexMtime);
    if (worktree === 'absent') continue;
    const local = isWorkingTreeModified(worktree);
    const staged = isStaged(head, entry);
    if (staged && local) both.push(entry.path);
    else if (staged && !cached) stagedOnly.push(entry.path);
    else if (local && !cached) localOnly.push(entry.path);
  }
  return { both, stagedOnly, localOnly };
};

const enforceSafetyValve = async (
  ctx: Context,
  entries: ReadonlyArray<IndexEntry>,
  cached: boolean,
  indexMtime: GitIndex['indexMtime'],
): Promise<void> => {
  const head = await headTreeEntries(ctx);
  const { both, stagedOnly, localOnly } = await classifyEntries(
    ctx,
    entries,
    head,
    cached,
    indexMtime,
  );
  // Precedence: surface the strongest required override first (`both` needs `-f`).
  if (both.length > 0) throw rmStagedAndLocalChanges(both);
  if (stagedOnly.length > 0) throw rmStagedChanges(stagedOnly);
  if (localOnly.length > 0) throw rmLocalModifications(localOnly);
};

const isStaged = (head: ReadonlyMap<FilePath, FlatTreeEntry>, entry: IndexEntry): boolean => {
  const headEntry = head.get(escapedPathOf(entry));
  // Absent from HEAD (newly added / never committed) counts as staged, as does a
  // blob-id or mode difference.
  return headEntry === undefined || headEntry.id !== entry.id || headEntry.mode !== entry.mode;
};

// An unborn HEAD (no commits yet) has no tree — every entry is then staged.
const headTreeEntries = async (ctx: Context): Promise<ReadonlyMap<FilePath, FlatTreeEntry>> =>
  (await readHeadTreeEscaped(ctx))?.entries ?? new Map();
