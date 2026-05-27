/**
 * Drop a single index entry without touching the working tree. Granular
 * CRUD counterpart to `commands/rm`: no pathspec, no working-tree
 * deletion. Removes every stage matching the path (stage-0 plus any
 * conflict stages 1/2/3) in one lock-and-commit cycle (ADR-164).
 */
import { operationAborted, TsgitError } from '../../domain/error.js';
import type { IndexEntry } from '../../domain/git-index/index-entry.js';
import { NO_PARSER_OFFSET, validateIndexPath } from '../../domain/git-index/path-validator.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { acquireIndexLock } from '../commands/internal/index-update.js';
import { assertNotBare, assertRepository } from '../commands/internal/repo-state.js';
import { readIndex } from './read-index.js';

export interface UnstageEntryOptions {
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

export const unstageEntry = async (
  ctx: Context,
  path: FilePath,
  opts: UnstageEntryOptions = {},
): Promise<{ readonly removed: boolean }> => {
  if (ctx.signal?.aborted) throw operationAborted();
  validateIndexPath(path as string, NO_PARSER_OFFSET);
  await assertRepository(ctx);
  await assertNotBare(ctx, 'unstageEntry');

  const lock = await acquireIndexLock(
    ctx,
    opts.breakStaleLockMs !== undefined ? { breakStaleLockMs: opts.breakStaleLockMs } : {},
  );
  try {
    const existing = await readExistingEntries(ctx);
    const next = existing.filter((entry) => entry.path !== path);
    const removed = next.length !== existing.length;
    await lock.commit(next);
    return { removed };
  } finally {
    await lock.release();
  }
};
