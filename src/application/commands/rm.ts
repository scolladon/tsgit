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
  rmStagedAndLocalChanges,
  rmStagedChanges,
} from '../../domain/commands/error.js';
import type { FlatTreeEntry } from '../../domain/diff/flat-tree.js';
import { TsgitError } from '../../domain/error.js';
import type { IndexEntry } from '../../domain/git-index/index.js';
import { emptyPathspec } from '../../domain/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import { matchesPathspec } from '../../domain/pathspec/index.js';
import type { Context } from '../../ports/context.js';
import {
  compareWorkingTreeEntry,
  isWorkingTreeModified,
} from '../primitives/compare-working-tree-entry.js';
import { readHeadTree } from '../primitives/read-head-tree.js';
import { readIndex } from '../primitives/read-index.js';
import { acquireIndexLock } from './internal/index-update.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertRepository,
} from './internal/repo-state.js';
import { enforceLiteralMustMatch, resolvePathspec } from './internal/resolve-pathspec.js';
import { assertNoValuelessCoreConfig } from './internal/valueless-config-guard.js';
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
  await assertRepository(ctx);
  await assertNoValuelessCoreConfig(ctx);
  await assertNotBare(ctx, 'rm');
  await assertNoPendingOperation(ctx);
  if (paths.length === 0) throw emptyPathspec();
  const { matcher, literalMustMatch } = resolvePathspec(paths);
  const lock = await acquireIndexLock(ctx);
  try {
    const index = await readIndex(ctx).catch((err: unknown) => {
      if (err instanceof TsgitError && isIndexMissingCode(err.data.code)) {
        return { entries: [] as ReadonlyArray<IndexEntry> };
      }
      throw err;
    });
    const byPath = new Map<FilePath, IndexEntry>();
    for (const entry of index.entries) byPath.set(entry.path, entry);
    const removed: FilePath[] = [];
    const removedEntries: IndexEntry[] = [];
    for (const [path, entry] of byPath) {
      if (matchesPathspec(matcher, path)) {
        removed.push(path);
        removedEntries.push(entry);
      }
    }
    enforceLiteralMustMatch(literalMustMatch, removed);
    if (opts.force !== true) {
      await enforceSafetyValve(ctx, removedEntries, opts.cached === true);
    }
    for (const path of removed) byPath.delete(path);
    if (!opts.cached) {
      for (const path of removed) {
        // FILE_NOT_FOUND is the only tolerable error: working file already gone.
        await removeFile(ctx, path).catch((err: unknown) => {
          if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return;
          throw err;
        });
      }
    }
    await lock.commit(Array.from(byPath.values()));
    return { removed };
  } finally {
    await lock.release();
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
const enforceSafetyValve = async (
  ctx: Context,
  entries: ReadonlyArray<IndexEntry>,
  cached: boolean,
): Promise<void> => {
  const head = await headTreeEntries(ctx);
  const both: FilePath[] = [];
  const stagedOnly: FilePath[] = [];
  const localOnly: FilePath[] = [];
  for (const entry of entries) {
    const worktree = await compareWorkingTreeEntry(ctx, entry);
    if (worktree === 'absent') continue;
    const local = isWorkingTreeModified(worktree);
    const staged = isStaged(head, entry);
    if (staged && local) both.push(entry.path);
    else if (staged && !cached) stagedOnly.push(entry.path);
    else if (local && !cached) localOnly.push(entry.path);
  }
  // Precedence: surface the strongest required override first (`both` needs `-f`).
  if (both.length > 0) throw rmStagedAndLocalChanges(both);
  if (stagedOnly.length > 0) throw rmStagedChanges(stagedOnly);
  if (localOnly.length > 0) throw rmLocalModifications(localOnly);
};

const isStaged = (head: ReadonlyMap<FilePath, FlatTreeEntry>, entry: IndexEntry): boolean => {
  const headEntry = head.get(entry.path);
  // Absent from HEAD (newly added / never committed) counts as staged, as does a
  // blob-id or mode difference.
  return headEntry === undefined || headEntry.id !== entry.id || headEntry.mode !== entry.mode;
};

// An unborn HEAD (no commits yet) has no tree — every entry is then staged.
const headTreeEntries = async (ctx: Context): Promise<ReadonlyMap<FilePath, FlatTreeEntry>> =>
  (await readHeadTree(ctx))?.entries ?? new Map();
