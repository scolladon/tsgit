/**
 * Shared storage-resolution seam beneath `streamBlob`. Buffers a blob's bytes
 * below `maxBufferedBytes` (measured in compressed/on-disk bytes) and streams
 * above it, across every storage form: the delta cache, loose objects,
 * packed base entries and packed delta entries.
 *
 * Type identity is REPORTED, never enforced here — the blob-only refusal is a
 * caller concern (`streamBlob`'s wrap tail). The one exception is the loose
 * streamed arm, whose `type` is unknown until the header is found inside the
 * inflate stream; it keeps refusing lazily, on first drain, exactly as the
 * pre-existing pipeline does today.
 */
import { operationAborted } from '../../../domain/error.js';
import {
  invalidObjectHeader,
  type ObjectType,
  objectHashMismatch,
  objectNotFound,
  unexpectedObjectType,
} from '../../../domain/objects/error.js';
import { splitObject } from '../../../domain/objects/git-object.js';
import { parseHeader } from '../../../domain/objects/header.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import { PACK_ENTRY_TYPE } from '../../../domain/storage/index.js';
import { readableStreamToAsyncIterable } from '../../../operators/readable-stream.js';
import type { Context } from '../../../ports/context.js';
import type { Hasher } from '../../../ports/hash-service.js';
import {
  isBase,
  looseCompressedBytes,
  readEntryHeaderWithChunk,
  resolvePackChain,
} from '../object-resolver.js';
import { nextOffsetForEntry, type PackLookupHit, type PackRegistry } from '../pack-registry.js';
import { getPackRegistry } from '../read-object.js';
import type { StreamBlobOptions } from '../stream-blob.js';

/** 64 KiB of compressed/on-disk bytes — the uniform buffered/streamed gate. */
export const MAX_BUFFERED_BLOB_BYTES = 65_536;

export type BlobSource =
  | { readonly kind: 'bytes'; readonly type: ObjectType; readonly content: Uint8Array }
  | {
      readonly kind: 'stream';
      readonly type: ObjectType | undefined;
      readonly stream: AsyncIterable<Uint8Array>;
      readonly materialised: boolean;
    };

interface BufferGate {
  readonly maxBufferedBytes: number;
  readonly verifyHash: boolean;
}

export async function openBlobSource(
  ctx: Context,
  id: ObjectId,
  maxBufferedBytes: number,
  options?: StreamBlobOptions,
): Promise<BlobSource> {
  const gate: BufferGate = { maxBufferedBytes, verifyHash: options?.verifyHash ?? true };

  checkAborted(ctx);

  if (gate.maxBufferedBytes > 0) {
    const cached = ctx.deltaCache.get(id);
    if (cached !== undefined) {
      return await resolveFromCache(ctx, id, cached, gate);
    }
  }

  const compressed = await looseCompressedBytes(ctx, id);
  if (compressed !== undefined) {
    checkAborted(ctx);
    return await resolveLoose(ctx, id, compressed, gate);
  }

  checkAborted(ctx);
  const registry = getPackRegistry(ctx);
  const hit = await registry.lookup(id);
  if (hit === undefined) throw objectNotFound(id);

  const table = await hit.pack.offsetTable();
  const nextOffset = nextOffsetForEntry(table, hit.offset);
  const { header, chunk, headerEndInChunk } = await readEntryHeaderWithChunk(ctx, hit, nextOffset);

  if (isBase(header)) {
    return await resolvePackBase(
      ctx,
      id,
      header.type,
      header.size,
      chunk.subarray(headerEndInChunk),
      gate,
    );
  }

  checkAborted(ctx);
  return await resolvePackDelta(ctx, registry, hit, id, gate);
}

function checkAborted(ctx: Context): void {
  if (ctx.signal?.aborted === true) {
    throw operationAborted();
  }
}

function fitsBuffer(byteLength: number, maxBufferedBytes: number): boolean {
  return byteLength <= maxBufferedBytes;
}

function toBytesSource(looseFormatBytes: Uint8Array): BlobSource {
  const { type, content } = splitObject(looseFormatBytes);
  return { kind: 'bytes', type, content };
}

function syntheticBlobHeader(declaredSize: number): Uint8Array {
  return new TextEncoder().encode(`blob ${declaredSize}\0`);
}

async function verifyBufferedBytes(
  ctx: Context,
  id: ObjectId,
  looseFormatBytes: Uint8Array,
  verifyHash: boolean,
): Promise<void> {
  if (!verifyHash) return;
  const actual = (await ctx.hash.hashHex(looseFormatBytes)) as ObjectId;
  if (actual !== id) throw objectHashMismatch(id, actual);
}

async function verifyPackBaseBytes(
  ctx: Context,
  id: ObjectId,
  declaredSize: number,
  content: Uint8Array,
  verifyHash: boolean,
): Promise<void> {
  const hasher: Hasher | undefined = verifyHash ? ctx.hash.createHasher() : undefined;
  hasher?.update(syntheticBlobHeader(declaredSize));
  hasher?.update(content);
  await finalizeHash(hasher, id);
}

async function resolveFromCache(
  ctx: Context,
  id: ObjectId,
  cached: Uint8Array,
  gate: BufferGate,
): Promise<BlobSource> {
  await verifyBufferedBytes(ctx, id, cached, gate.verifyHash);
  return toBytesSource(cached);
}

async function resolveLoose(
  ctx: Context,
  id: ObjectId,
  compressed: Uint8Array,
  gate: BufferGate,
): Promise<BlobSource> {
  if (fitsBuffer(compressed.length, gate.maxBufferedBytes)) {
    const inflated = await ctx.compressor.inflate(compressed);
    await verifyBufferedBytes(ctx, id, inflated, gate.verifyHash);
    return toBytesSource(inflated);
  }
  return {
    kind: 'stream',
    type: undefined,
    materialised: false,
    stream: yieldAndVerifyChunks(ctx, id, inflateOneShot(ctx, compressed), gate.verifyHash),
  };
}

async function resolvePackBase(
  ctx: Context,
  id: ObjectId,
  baseType: 1 | 2 | 3 | 4,
  declaredSize: number,
  payload: Uint8Array,
  gate: BufferGate,
): Promise<BlobSource> {
  const type = packTypeName(baseType);
  if (fitsBuffer(payload.length, gate.maxBufferedBytes)) {
    const content = await ctx.compressor.inflate(payload);
    await verifyPackBaseBytes(ctx, id, declaredSize, content, gate.verifyHash);
    return { kind: 'bytes', type, content };
  }
  return {
    kind: 'stream',
    type,
    materialised: false,
    stream: yieldAndVerifyPackedBaseChunks(
      ctx,
      id,
      inflateOneShot(ctx, payload),
      declaredSize,
      gate.verifyHash,
    ),
  };
}

async function resolvePackDelta(
  ctx: Context,
  registry: PackRegistry,
  hit: PackLookupHit,
  id: ObjectId,
  gate: BufferGate,
): Promise<BlobSource> {
  const fullBytes = await resolvePackChain(ctx, registry, hit, id, undefined);
  await verifyBufferedBytes(ctx, id, fullBytes, gate.verifyHash);
  return toBytesSource(fullBytes);
}

function packTypeName(type: 1 | 2 | 3 | 4): ObjectType {
  switch (type) {
    case PACK_ENTRY_TYPE.COMMIT:
      return 'commit';
    case PACK_ENTRY_TYPE.TREE:
      return 'tree';
    case PACK_ENTRY_TYPE.BLOB:
      return 'blob';
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

  hasher?.update(syntheticBlobHeader(declaredSize));

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
