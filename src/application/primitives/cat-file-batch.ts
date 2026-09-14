/**
 * Streaming git-`cat-file --batch` equivalent — yields one entry per input
 * id, in input order, sequentially. A missing object becomes
 * `{ ok: false, reason: 'missing' }` so the stream survives misses
 * (ADR-088). Partial-clone lazy-fetch is transparent: it is handled by
 * `readObject`. Other resolver errors propagate unchanged.
 *
 * See `docs/design/cat-file-batch.md` and ADRs 087–090.
 */
import { operationAborted } from '../../domain/error.js';
import { isObjectNotFound } from '../../domain/objects/error.js';
import type { GitObject, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { readObjectWithSize } from './read-object.js';
import type { CatFileBatchEntry, CatFileBatchOptions, ReadObjectOptions } from './types.js';

const throwIfAborted = (ctx: Context): void => {
  if (ctx.signal?.aborted) throw operationAborted();
};

const buildOkEntry = (
  id: ObjectId,
  resolved: { readonly object: GitObject; readonly size: number },
): CatFileBatchEntry => ({
  ok: true,
  id,
  type: resolved.object.type,
  size: resolved.size,
  object: resolved.object,
});

const buildMissingEntry = (id: ObjectId): CatFileBatchEntry => ({
  ok: false,
  id,
  reason: 'missing',
});

const readOne = async (
  ctx: Context,
  id: ObjectId,
  readOptions: ReadObjectOptions | undefined,
): Promise<CatFileBatchEntry> => {
  try {
    const resolved = await readObjectWithSize(ctx, id, readOptions);
    return buildOkEntry(id, resolved);
  } catch (err) {
    if (isObjectNotFound(err)) return buildMissingEntry(id);
    throw err;
  }
};

export async function* catFileBatch(
  ctx: Context,
  ids: AsyncIterable<ObjectId> | Iterable<ObjectId>,
  options?: CatFileBatchOptions,
): AsyncIterable<CatFileBatchEntry> {
  const readOptions: ReadObjectOptions | undefined =
    options?.maxBytes === undefined ? undefined : { maxBytes: options.maxBytes };
  for await (const id of ids) {
    throwIfAborted(ctx);
    const entry = await readOne(ctx, id, readOptions);
    yield entry;
    throwIfAborted(ctx);
  }
}
