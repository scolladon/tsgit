import { TsgitError } from '../../domain/error.js';
import type { IndexEntry } from '../../domain/git-index/index.js';
import { emptyPathspec } from '../../domain/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import { matchesPathspec } from '../../domain/pathspec/index.js';
import type { Context } from '../../ports/context.js';
import { readIndex } from '../primitives/read-index.js';
import { acquireIndexLock } from './internal/index-update.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertRepository,
} from './internal/repo-state.js';
import { enforceLiteralMustMatch, resolvePathspec } from './internal/resolve-pathspec.js';
import { removeFile } from './internal/working-tree.js';

const INDEX_MISSING_CODES = new Set([
  'FILE_NOT_FOUND',
  'INVALID_INDEX_HEADER',
  'INVALID_INDEX_ENTRY',
]);

export interface RmOptions {
  readonly cached?: boolean;
  readonly breakStaleLockMs?: number;
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
  await assertNotBare(ctx, 'rm');
  await assertNoPendingOperation(ctx);
  if (paths.length === 0) throw emptyPathspec();
  const { matcher, literalMustMatch } = resolvePathspec(paths);
  const lock = await acquireIndexLock(
    ctx,
    opts.breakStaleLockMs !== undefined ? { breakStaleLockMs: opts.breakStaleLockMs } : {},
  );
  try {
    const index = await readIndex(ctx).catch((err: unknown) => {
      if (err instanceof TsgitError && INDEX_MISSING_CODES.has(err.data.code)) {
        return { entries: [] as ReadonlyArray<IndexEntry> };
      }
      throw err;
    });
    const byPath = new Map<FilePath, IndexEntry>();
    for (const entry of index.entries) byPath.set(entry.path, entry);
    const removed: FilePath[] = [];
    for (const [path] of byPath) {
      if (matchesPathspec(matcher, path)) removed.push(path);
    }
    enforceLiteralMustMatch(literalMustMatch, removed);
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
