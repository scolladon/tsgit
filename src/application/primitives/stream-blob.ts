import { operationAborted } from '../../domain/error.js';
import {
  objectHashMismatch,
  objectNotFound,
  unexpectedObjectType,
} from '../../domain/objects/error.js';
import { parseHeader } from '../../domain/objects/header.js';
import type { ObjectId } from '../../domain/objects/index.js';
import { readableStreamToAsyncIterable } from '../../operators/readable-stream.js';
import type { Context } from '../../ports/context.js';
import type { Hasher } from '../../ports/hash-service.js';
import { looseCompressedBytes } from './object-resolver.js';

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

  throw objectNotFound(id);
}

async function streamLooseBlob(
  ctx: Context,
  id: ObjectId,
  compressed: Uint8Array,
  verifyHash: boolean,
): Promise<BlobStream> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(compressed);
      controller.close();
    },
  });

  const inflated = source.pipeThrough(ctx.compressor.createInflateStream());
  const chunks = readableStreamToAsyncIterable(inflated);

  const iterable = streamLooseBlobChunks(ctx, id, chunks, verifyHash);
  return Object.assign(iterable, { materialised: false as const });
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
): Promise<HeaderStripped | undefined> {
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
      return undefined;
    }
    buf = concat(buf, next.value);
  }
}

async function* streamLooseBlobChunks(
  ctx: Context,
  id: ObjectId,
  chunks: AsyncIterable<Uint8Array>,
  verifyHash: boolean,
): AsyncIterable<Uint8Array> {
  const hasher: Hasher | undefined = verifyHash ? ctx.hash.createHasher() : undefined;
  const iter = chunks[Symbol.asyncIterator]();

  const firstChunk = await iter.next();
  if (firstChunk.done === true) {
    return;
  }

  const stripped = await stripHeader(id, iter, firstChunk.value);
  if (stripped === undefined) {
    return;
  }

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

  if (hasher !== undefined) {
    const actual = (await hasher.digestHex()) as ObjectId;
    if (actual !== id) {
      throw objectHashMismatch(id, actual);
    }
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
