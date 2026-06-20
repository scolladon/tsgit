import { operationAborted } from '../../domain/error.js';
import {
  invalidObjectHeader,
  type ObjectType,
  objectHashMismatch,
  objectNotFound,
  unexpectedObjectType,
} from '../../domain/objects/error.js';
import { parseHeader } from '../../domain/objects/header.js';
import type { ObjectId } from '../../domain/objects/index.js';
import { PACK_ENTRY_TYPE } from '../../domain/storage/index.js';
import { readableStreamToAsyncIterable } from '../../operators/readable-stream.js';
import type { Context } from '../../ports/context.js';
import type { Hasher } from '../../ports/hash-service.js';
import {
  isBase,
  looseCompressedBytes,
  readEntryHeaderWithChunk,
  resolvePackChain,
} from './object-resolver.js';
import { nextOffsetForEntry } from './pack-registry.js';
import { getPackRegistry } from './read-object.js';

export interface StreamBlobOptions {
  readonly verifyHash?: boolean;
}

export interface BlobStream extends AsyncIterable<Uint8Array> {
  readonly materialised: boolean;
}

export async function streamBlob(
  ctx: Context,
  id: ObjectId,
  options?: StreamBlobOptions,
): Promise<BlobStream> {
  const verifyHash = options?.verifyHash ?? true;

  if (ctx.signal?.aborted === true) {
    throw operationAborted();
  }

  const compressed = await looseCompressedBytes(ctx, id);
  if (compressed !== undefined) {
    return streamLooseBlob(ctx, id, compressed, verifyHash);
  }

  const registry = getPackRegistry(ctx);
  const hit = await registry.lookup(id);
  if (hit === undefined) {
    throw objectNotFound(id);
  }

  const table = await hit.pack.offsetTable();
  const nextOffset = nextOffsetForEntry(table, hit.offset);
  const { header, chunk, headerEndInChunk } = await readEntryHeaderWithChunk(ctx, hit, nextOffset);

  if (isBase(header)) {
    if (header.type !== PACK_ENTRY_TYPE.BLOB) {
      throw unexpectedObjectType('blob', packTypeName(header.type as 1 | 2 | 4), id);
    }
    return streamPackedBaseBlob(ctx, id, chunk.subarray(headerEndInChunk), header.size, verifyHash);
  }

  // Delta entry: reconstruct in full (full materialisation is expected for deltas)
  const fullBytes = await resolvePackChain(ctx, registry, hit, id, undefined);
  return streamFromBuffer(ctx, id, fullBytes, verifyHash, true);
}

function packTypeName(type: 1 | 2 | 4): ObjectType {
  switch (type) {
    case PACK_ENTRY_TYPE.COMMIT:
      return 'commit';
    case PACK_ENTRY_TYPE.TREE:
      return 'tree';
    case PACK_ENTRY_TYPE.TAG:
      return 'tag';
  }
}

async function finalizeHash(hasher: Hasher | undefined, id: ObjectId): Promise<void> {
  if (hasher === undefined) return;
  const actual = (await hasher.digestHex()) as ObjectId;
  if (actual !== id) throw objectHashMismatch(id, actual);
}

function inflateOneShot(ctx: Context, bytes: Uint8Array): AsyncIterable<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const inflated = source.pipeThrough(ctx.compressor.createInflateStream());
  return readableStreamToAsyncIterable(inflated);
}

function streamLooseBlob(
  ctx: Context,
  id: ObjectId,
  compressed: Uint8Array,
  verifyHash: boolean,
): BlobStream {
  const iterable = yieldAndVerifyChunks(ctx, id, inflateOneShot(ctx, compressed), verifyHash);
  return Object.assign(iterable, { materialised: false as const });
}

function streamPackedBaseBlob(
  ctx: Context,
  id: ObjectId,
  compressedPayload: Uint8Array,
  declaredSize: number,
  verifyHash: boolean,
): BlobStream {
  // Pack base entries carry no loose-format header in the inflated output.
  // Feed the exact compressed slice through inflate, then yield content chunks.
  const iterable = yieldAndVerifyPackedBaseChunks(
    ctx,
    id,
    inflateOneShot(ctx, compressedPayload),
    declaredSize,
    verifyHash,
  );
  return Object.assign(iterable, { materialised: false as const });
}

async function streamFromBuffer(
  ctx: Context,
  id: ObjectId,
  fullBytes: Uint8Array,
  verifyHash: boolean,
  materialised: boolean,
): Promise<BlobStream> {
  // fullBytes is loose-format: `<type> <size>\0<content>`. parseHeader owns the
  // malformed-header error (a missing NUL throws invalidObjectHeader) and locates
  // the content boundary, so no second manual scan is needed.
  const { type, contentOffset } = parseHeader(fullBytes);
  if (type !== 'blob') {
    throw unexpectedObjectType('blob', type, id);
  }
  const headerBytes = fullBytes.subarray(0, contentOffset);
  const content = fullBytes.subarray(contentOffset);

  async function* gen(): AsyncIterable<Uint8Array> {
    const hasher: Hasher | undefined = verifyHash ? ctx.hash.createHasher() : undefined;
    hasher?.update(headerBytes);
    if (content.length > 0) {
      hasher?.update(content);
      yield content;
    }
    await finalizeHash(hasher, id);
  }

  return Object.assign(gen(), { materialised });
}

/** Result of stripping the git object header from accumulated inflate chunks. */
interface HeaderStripped {
  readonly headerBytes: Uint8Array;
  readonly content: Uint8Array;
}

/**
 * Accumulate inflate chunks until the NUL byte is found, then return the
 * header bytes (including NUL) and the initial content slice.
 * Throws unexpectedObjectType if the object is not a blob.
 */
async function stripHeader(
  id: ObjectId,
  chunks: AsyncIterator<Uint8Array>,
  accum: Uint8Array,
): Promise<HeaderStripped> {
  let buf = accum;

  for (;;) {
    const nullPos = buf.indexOf(0x00);
    if (nullPos !== -1) {
      const { type } = parseHeader(buf);
      if (type !== 'blob') {
        throw unexpectedObjectType('blob', type, id);
      }
      return { headerBytes: buf.subarray(0, nullPos + 1), content: buf.subarray(nullPos + 1) };
    }

    const next = await chunks.next();
    if (next.done === true) {
      throw invalidObjectHeader(`no NUL terminator found in inflated object ${id}`);
    }
    buf = concat(buf, next.value);
  }
}

/**
 * Streaming tail for the loose path. Strips the git loose-format header
 * from the inflated output, then yields content chunks with incremental hash verification.
 */
async function* yieldAndVerifyChunks(
  ctx: Context,
  id: ObjectId,
  chunks: AsyncIterable<Uint8Array>,
  verifyHash: boolean,
): AsyncIterable<Uint8Array> {
  const hasher: Hasher | undefined = verifyHash ? ctx.hash.createHasher() : undefined;
  const iter = chunks[Symbol.asyncIterator]();

  const firstChunk = await iter.next();
  if (firstChunk.done === true) {
    throw invalidObjectHeader(`inflate stream produced no output for object ${id}`);
  }

  const stripped = await stripHeader(id, iter, firstChunk.value);

  hasher?.update(stripped.headerBytes);

  if (stripped.content.length > 0) {
    hasher?.update(stripped.content);
    yield stripped.content;
  }

  for await (const chunk of { [Symbol.asyncIterator]: () => iter }) {
    if (ctx.signal?.aborted === true) {
      throw operationAborted();
    }
    hasher?.update(chunk);
    yield chunk;
  }

  await finalizeHash(hasher, id);
}

/**
 * Streaming tail for packed BASE entries. Pack base entries hold raw content
 * bytes (no loose-format header in the inflated output). The canonical header
 * `blob <declaredSize>\0` is built from the pack entry header's declared inflated
 * size — known before inflation — so chunks can be yielded as they arrive.
 * A wrong declared size is caught: the incremental hash over the synthetic header
 * plus the true inflated bytes will not equal id, so objectHashMismatch fires.
 */
async function* yieldAndVerifyPackedBaseChunks(
  ctx: Context,
  id: ObjectId,
  chunks: AsyncIterable<Uint8Array>,
  declaredSize: number,
  verifyHash: boolean,
): AsyncIterable<Uint8Array> {
  const hasher: Hasher | undefined = verifyHash ? ctx.hash.createHasher() : undefined;

  if (hasher !== undefined) {
    const headerBytes = new TextEncoder().encode(`blob ${declaredSize}\0`);
    hasher.update(headerBytes);
  }

  for await (const chunk of chunks) {
    if (ctx.signal?.aborted === true) {
      throw operationAborted();
    }
    hasher?.update(chunk);
    yield chunk;
  }

  await finalizeHash(hasher, id);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
