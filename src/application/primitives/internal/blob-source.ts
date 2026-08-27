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

/**
 * The closed gate, and deliberately two things at once: it fails every
 * `fitsBuffer` test AND, being not greater than zero, skips the delta-cache
 * probe entirely. A caller that wants nothing materialised wants both — a
 * cache hit IS a whole materialised object, so honouring it would defeat the
 * first meaning. Anything that ever wants one without the other needs a real
 * second knob, not this constant.
 */
export const NEVER_BUFFER = 0;

export type BlobSource =
  | { readonly kind: 'bytes'; readonly type: ObjectType; readonly content: Uint8Array }
  | {
      readonly kind: 'stream';
      readonly type: ObjectType | undefined;
      readonly stream: AsyncIterable<Uint8Array>;
      readonly materialised: boolean;
      /**
       * Cancels the inflate pipeline behind `stream` for a caller that decides
       * NOT to drain it (a sibling side failed, a type refusal fired). Without
       * it the pipeline — and the adapter's inflate instance — survives until
       * GC. Never rejects: it runs on paths that are already reporting a
       * failure, and a stream with nothing left to release must not overwrite
       * that failure with one of its own.
       */
      release(): Promise<void>;
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
  const gate: BufferGate = { maxBufferedBytes, verifyHash: options?.verifyHash ?? false };

  checkAborted(ctx);
  // Same store-setup gate as resolveObjectBytes: a structurally
  // self-inconsistent multi-pack-index denies streamed loose reads too —
  // otherwise the two read paths would disagree about a corrupt store.
  await getPackRegistry(ctx).assertLoadable();

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

// The canonical loose-format header a pack entry's inflated bytes are missing.
// Built from the entry's OWN type: a non-blob entry then verifies cleanly and
// is reported for the caller to refuse, instead of dying here on a hash rebuilt
// as if it were a blob.
function syntheticObjectHeader(type: ObjectType, declaredSize: number): Uint8Array {
  return new TextEncoder().encode(`${type} ${declaredSize}\0`);
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
  type: ObjectType,
  declaredSize: number,
  content: Uint8Array,
  verifyHash: boolean,
): Promise<void> {
  const hasher: Hasher | undefined = verifyHash ? ctx.hash.createHasher() : undefined;
  hasher?.update(syntheticObjectHeader(type, declaredSize));
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
  const inflated = inflateOneShot(ctx, compressed);
  return {
    kind: 'stream',
    type: undefined,
    materialised: false,
    stream: yieldAndVerifyChunks(ctx, id, readableStreamToAsyncIterable(inflated), gate.verifyHash),
    release: () => cancelUnread(inflated),
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
  // Both conditions: the compressed payload is the gated quantity everywhere,
  // but a pack base entry also knows its inflated size for free from the entry
  // header, and compressed size alone is no bound on it — deflate reaches
  // 1029:1, so a 64 KiB payload can inflate to ~64 MiB.
  //
  // What this actually buys, stated honestly: `declaredSize` is read from the
  // entry header, so it holds an HONEST entry to the gate and nothing more. A
  // crafted entry can declare a tiny size and carry a maximally-compressible
  // payload, pass both tests, and still inflate to ~64 MiB before the hash
  // check rejects it. That is no worse than the loose arm, whose ceiling is the
  // same 64 KiB-compressed bound, and both sit under the compressor port's
  // 2 GiB inflate cap. Bounding a lying header would take streaming the entry
  // and counting bytes, which is a different gate than this one.
  if (
    fitsBuffer(payload.length, gate.maxBufferedBytes) &&
    fitsBuffer(declaredSize, gate.maxBufferedBytes)
  ) {
    const content = await ctx.compressor.inflate(payload);
    await verifyPackBaseBytes(ctx, id, type, declaredSize, content, gate.verifyHash);
    return { kind: 'bytes', type, content };
  }
  const inflated = inflateOneShot(ctx, payload);
  return {
    kind: 'stream',
    type,
    materialised: false,
    stream: yieldAndVerifyPackedBaseChunks(
      ctx,
      id,
      readableStreamToAsyncIterable(inflated),
      type,
      declaredSize,
      gate.verifyHash,
    ),
    release: () => cancelUnread(inflated),
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

function inflateOneShot(ctx: Context, bytes: Uint8Array): ReadableStream<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return source.pipeThrough(ctx.compressor.createInflateStream());
}

// Cancelling can reject for two reasons, and neither is this caller's news to
// carry: an already-errored readable rejects with the error it stored, and a
// locked one (already owned by an iterator, whose own `return` does the
// cancelling) rejects on the lock. Both mean "there is nothing left here to
// release" — and a release runs *while another failure is being reported*, so
// letting either escape would replace the real error with this one. Same
// swallow, and the same reason, as `readableStreamToAsyncIterable`'s `return`.
async function cancelUnread(stream: ReadableStream<Uint8Array>): Promise<void> {
  try {
    await stream.cancel();
  } catch {
    // already errored or already owned; nothing left to release
  }
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

  // The header yield below sits outside the `for await`, so an early return
  // there would otherwise abandon `iter` — and the reader behind it — without
  // cancelling. Cancelling a spent iterator is a no-op, so this is safe on the
  // normal path too.
  try {
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
  } finally {
    await iter.return?.();
  }
}

/**
 * Streaming tail for packed BASE entries. Pack base entries hold raw content
 * bytes (no loose-format header in the inflated output). The canonical header
 * `<type> <declaredSize>\0` is built from the pack entry header's own type and
 * declared inflated size — both known before inflation — so chunks can be
 * yielded as they arrive. A wrong declared size is caught: the incremental hash
 * over the synthetic header plus the true inflated bytes will not equal id, so
 * objectHashMismatch fires.
 */
async function* yieldAndVerifyPackedBaseChunks(
  ctx: Context,
  id: ObjectId,
  chunks: AsyncIterable<Uint8Array>,
  type: ObjectType,
  declaredSize: number,
  verifyHash: boolean,
): AsyncIterable<Uint8Array> {
  const hasher: Hasher | undefined = verifyHash ? ctx.hash.createHasher() : undefined;

  hasher?.update(syntheticObjectHeader(type, declaredSize));

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
