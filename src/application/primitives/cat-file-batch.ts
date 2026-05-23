/**
 * Streaming git-`cat-file --batch` equivalent — yields one entry per input
 * id, in input order, sequentially. A missing object becomes
 * `{ ok: false, reason: 'missing' }` so the stream survives misses
 * (ADR-088). Partial-clone lazy-fetch is transparent: it is handled by
 * `readObject`. Other resolver errors propagate unchanged.
 *
 * See `docs/design/cat-file-batch.md` and ADRs 087–090.
 */
import { operationAborted, TsgitError } from '../../domain/error.js';
import { type GitObject, type ObjectId, payloadByteLength } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { readObject } from './read-object.js';
import type { CatFileBatchEntry, CatFileBatchOptions, ReadObjectOptions } from './types.js';

const throwIfAborted = (ctx: Context): void => {
  if (ctx.signal?.aborted) throw operationAborted();
};

const buildOkEntry = (ctx: Context, id: ObjectId, object: GitObject): CatFileBatchEntry => ({
  ok: true,
  id,
  type: object.type,
  size: payloadByteLength(object, ctx.hashConfig),
  object,
});

const buildMissingEntry = (id: ObjectId): CatFileBatchEntry => ({
  ok: false,
  id,
  reason: 'missing',
});

const isObjectNotFound = (err: unknown): boolean =>
  err instanceof TsgitError && err.data.code === 'OBJECT_NOT_FOUND';

const readOne = async (
  ctx: Context,
  id: ObjectId,
  readOptions: ReadObjectOptions | undefined,
): Promise<CatFileBatchEntry> => {
  try {
    const object = await readObject(ctx, id, readOptions);
    return buildOkEntry(ctx, id, object);
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
