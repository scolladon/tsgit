/**
 * Stage a single index entry from raw bytes or a known OID. Granular CRUD
 * counterpart to `commands/add`: the porcelain walks pathspecs and reads
 * the working tree; this primitive lets a caller bypass both and commit
 * one entry atomically under `${gitDir}/index.lock` (ADR-164).
 */
import { operationAborted, TsgitError } from '../../domain/error.js';
import {
  type IndexEntry,
  type IndexEntryFlags,
  STAGE0_FLAGS,
} from '../../domain/git-index/index-entry.js';
import { NO_PARSER_OFFSET, validateIndexPath } from '../../domain/git-index/path-validator.js';
import type { FileMode, ObjectId } from '../../domain/objects/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { hashBlob } from './hash-blob.js';
import { acquireIndexLock } from './internal/index-lock.js';
import { assertNotBare, assertRepository } from './internal/repo-state.js';
import { readIndex } from './read-index.js';

export type StageEntrySource =
  | { readonly content: Uint8Array; readonly mode?: FileMode }
  | { readonly id: ObjectId; readonly mode: FileMode };

export interface StageEntryOptions {
  readonly breakStaleLockMs?: number;
  /** Flags overlay on top of `STAGE0_FLAGS`. Use to seed `intentToAdd` etc. */
  readonly flags?: Partial<IndexEntryFlags>;
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

const buildEntry = (
  path: FilePath,
  id: ObjectId,
  mode: FileMode,
  contentLength: number,
  flags: IndexEntryFlags,
): IndexEntry => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    ctimeSeconds: nowSeconds,
    ctimeNanoseconds: 0,
    mtimeSeconds: nowSeconds,
    mtimeNanoseconds: 0,
    dev: 0,
    ino: 0,
    mode,
    uid: 0,
    gid: 0,
    fileSize: contentLength,
    id,
    flags,
    path,
  };
};

export const stageEntry = async (
  ctx: Context,
  path: FilePath,
  source: StageEntrySource,
  opts: StageEntryOptions = {},
): Promise<IndexEntry> => {
  if (ctx.signal?.aborted) throw operationAborted();
  validateIndexPath(path as string, NO_PARSER_OFFSET);
  await assertRepository(ctx);
  await assertNotBare(ctx, 'stageEntry');

  const flags: IndexEntryFlags = { ...STAGE0_FLAGS, ...opts.flags };
  const lock = await acquireIndexLock(
    ctx,
    opts.breakStaleLockMs !== undefined ? { breakStaleLockMs: opts.breakStaleLockMs } : {},
  );
  try {
    const existing = await readExistingEntries(ctx);

    let id: ObjectId;
    let mode: FileMode;
    let contentLength: number;
    if ('content' in source) {
      id = await hashBlob(ctx, source.content, { write: true });
      mode = source.mode ?? ('100644' as FileMode);
      contentLength = source.content.byteLength;
    } else {
      id = source.id;
      mode = source.mode;
      contentLength = 0;
    }

    const entry = buildEntry(path, id, mode, contentLength, flags);
    const next = existing.filter((e) => e.path !== path || e.flags.stage !== flags.stage);
    next.push(entry);
    await lock.commit(next);
    return entry;
  } finally {
    await lock.release();
  }
};
