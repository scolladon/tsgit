/**
 * Flip flags (`assumeValid`, `skipWorktree`, `intentToAdd`) on an existing
 * index entry without rehashing. Used by `stash pop`, `mv`, and other
 * porcelain that need to restore flag state after a tree-level operation.
 *
 * The on-disk version is auto-promoted to v3 by `serializeIndex` whenever
 * an extended flag flips true — nothing to manage at the primitive layer
 * (ADR-164).
 */

import { pathspecNoMatch } from '../../domain/commands/error.js';
import { operationAborted, TsgitError } from '../../domain/error.js';
import type { IndexEntry, IndexEntryFlags } from '../../domain/git-index/index-entry.js';
import { NO_PARSER_OFFSET, validateIndexPath } from '../../domain/git-index/path-validator.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { acquireIndexLock } from './internal/index-lock.js';
import { assertNotBare, assertRepository } from './internal/repo-state.js';
import { readIndex } from './read-index.js';

export interface SetEntryFlagsOptions {
  readonly breakStaleLockMs?: number;
}

const INDEX_MISSING_CODES = new Set([
  'FILE_NOT_FOUND',
  'INVALID_INDEX_HEADER',
  'INVALID_INDEX_ENTRY',
]);

const readExistingEntries = async (ctx: Context): Promise<ReadonlyArray<IndexEntry>> => {
  try {
    const index = await readIndex(ctx);
    return index.entries;
  } catch (err) {
    if (err instanceof TsgitError && INDEX_MISSING_CODES.has(err.data.code)) {
      return [];
    }
    throw err;
  }
};

const pickUserFacingEntry = (entries: ReadonlyArray<IndexEntry>): IndexEntry => {
  // Stage-0 wins when present; otherwise the lowest stage. Entries are
  // already byte-sorted by path then stage, but we don't rely on that —
  // explicit min keeps the contract stable across input orderings.
  let best = entries[0] as IndexEntry;
  for (const entry of entries) {
    if (entry.flags.stage < best.flags.stage) best = entry;
  }
  return best;
};

export const setEntryFlags = async (
  ctx: Context,
  path: FilePath,
  flags: Partial<IndexEntryFlags>,
  opts: SetEntryFlagsOptions = {},
): Promise<IndexEntry> => {
  if (ctx.signal?.aborted) throw operationAborted();
  validateIndexPath(path as string, NO_PARSER_OFFSET);
  await assertRepository(ctx);
  await assertNotBare(ctx, 'setEntryFlags');

  const lock = await acquireIndexLock(
    ctx,
    opts.breakStaleLockMs !== undefined ? { breakStaleLockMs: opts.breakStaleLockMs } : {},
  );
  try {
    const existing = await readExistingEntries(ctx);
    const matching = existing.filter((entry) => entry.path === path);
    if (matching.length === 0) {
      throw pathspecNoMatch(path as string);
    }
    const updatedMatching = matching.map((entry) => ({
      ...entry,
      flags: { ...entry.flags, ...flags },
    }));
    const next = existing.map((entry) => {
      if (entry.path !== path) return entry;
      const replacement = updatedMatching.find((u) => u.flags.stage === entry.flags.stage);
      return replacement ?? entry;
    });
    await lock.commit(next);
    return pickUserFacingEntry(updatedMatching);
  } finally {
    await lock.release();
  }
};
