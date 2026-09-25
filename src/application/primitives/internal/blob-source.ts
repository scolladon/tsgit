/**
 * Shared storage-resolution seam beneath `streamBlob`. Buffers a blob's bytes
 * below `maxBufferedBytes` (measured in compressed/on-disk bytes) and streams
 * above it, across every storage form: the delta cache, loose objects,
 * packed base entries and packed delta entries.
 *
 * Type identity is REPORTED, never enforced here — the blob-only refusal is a
 * caller concern (`streamBlob`'s wrap tail). Every arm, loose streamed
 * included, knows its type at open: the loose arm reads its header before
 * `openBlobSource` returns.
 */
import { operationAborted } from '../../../domain/error.js';
import {
  invalidObjectHeader,
  type ObjectType,
  objectHashMismatch,
  objectNotFound,
} from '../../../domain/objects/error.js';
import { assertLooseSizeConsistent, splitLooseObject } from '../../../domain/objects/git-object.js';
import { parseHeader } from '../../../domain/objects/header.js';
import { emptyTreeOid, type ObjectContent, type ObjectId } from '../../../domain/objects/index.js';
import {
  feedParseAcceptance,
  type ParseAcceptanceScan,
  startParseAcceptance,
} from '../../../domain/objects/parse-acceptance.js';
import { PACK_ENTRY_TYPE } from '../../../domain/storage/index.js';
import { readableStreamToAsyncIterable } from '../../../operators/readable-stream.js';
import type { Context } from '../../../ports/context.js';
import type { Hasher } from '../../../ports/hash-service.js';
import {
  assertInflatedSizeMatches,
  cacheEntry,
  isBase,
  looseCompressedBytes,
  readEntryHeaderWithChunk,
  resolvePackChain,
  verifyObjectContent,
} from '../object-resolver.js';
import { nextOffsetForEntry, type PackLookupHit, type PackRegistry } from '../pack-registry.js';
import { getPackRegistry, peekPackRegistry, withLazyFetchRetry } from '../read-object.js';
import type { StreamBlobOptions } from '../stream-blob.js';
import { checkAborted, retryOnceAfterRescan } from './retry-after-rescan.js';

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
      readonly type: ObjectType;
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
  const registry = peekPackRegistry(ctx) ?? (await getPackRegistry(ctx));
  // Same store-setup gate as resolveObjectContentWithDepth: a structurally
  // self-inconsistent multi-pack-index denies streamed loose reads too —
  // otherwise the two read paths would disagree about a corrupt store.
  await registry.assertLoadable();

  const cached = await tryDeltaCacheHit(ctx, id, gate);
  if (cached !== undefined) return cached;

  const first = await tryOpenBlobSource(ctx, id, gate);
  if (first !== undefined) return first;

  // Full miss: as of the CURRENT generation, no pack claims `id` and no loose
  // file exists for it either. Mirrors `resolveObjectContentWithDepth`'s own
  // retry — `retryOnceAfterRescan` single-flights the re-scan across
  // concurrent misses and honours an abort raised during it.
  const retried = await retryOnceAfterRescan(ctx, registry, id, () =>
    tryOpenBlobSource(ctx, id, gate),
  );
  if (retried !== undefined) return retried;
  throw objectNotFound(id);
}

/** The deltaCache fast path, gated at zero (`NEVER_BUFFER` skips it too — see
 *  its own doc). Extracted so the entry point above stays a short list of
 *  short-circuits, one per storage form. */
async function tryDeltaCacheHit(
  ctx: Context,
  id: ObjectId,
  gate: BufferGate,
): Promise<BlobSource | undefined> {
  if (gate.maxBufferedBytes <= 0) return undefined;
  const cached = ctx.deltaCache.get(id);
  if (cached === undefined) return undefined;
  return resolveFromCache(ctx, id, cached, gate);
}

/**
 * One resolution attempt against the CURRENT generation — loose first, then
 * pack, mirroring `openBlobSource`'s own original order — reporting
 * `undefined` when NEITHER claims `id`: the full-miss signal `openBlobSource`
 * retries once after a re-scan. Any OTHER error (a corrupt entry, a hash
 * mismatch) propagates directly, never converted to a miss.
 */
async function tryOpenBlobSource(
  ctx: Context,
  id: ObjectId,
  gate: BufferGate,
): Promise<BlobSource | undefined> {
  const compressed = await looseCompressedBytes(ctx, id);
  if (compressed !== undefined) {
    checkAborted(ctx);
    return await resolveLoose(ctx, id, compressed, gate);
  }

  checkAborted(ctx);
  const registry = peekPackRegistry(ctx) ?? (await getPackRegistry(ctx));
  const hit = await registry.lookup(id);
  if (hit === undefined) return undefined;

  const table = await hit.pack.offsetTable();
  const nextOffset = nextOffsetForEntry(table, hit.offset);
  const { header, chunk, headerEndInChunk } = await readEntryHeaderWithChunk(
    ctx,
    hit,
    nextOffset,
    table.packFileSize,
  );

  if (isBase(header)) {
    return await resolvePackBase(
      ctx,
      id,
      header.type,
      header.size,
      chunk.subarray(headerEndInChunk),
      gate,
      hit.offset,
    );
  }

  checkAborted(ctx);
  return await resolvePackDelta(ctx, registry, hit, id, gate);
}

/** The result of `verifyStoredObject`: the stored type of an object git's
 *  `parse_object` accepted — it exists and its stored bytes hash to it —
 *  and, for a commit or tag, the parse-acceptance scan over its bytes (git
 *  parses no blob or tree, so `acceptance` is `undefined` for those). */
export interface VerifiedObject {
  readonly type: ObjectType;
  readonly acceptance: ParseAcceptanceScan | undefined;
}

/** git models the empty tree as never stored; `openBlobSource` has no arm
 *  for it, so the verifier reports it directly, ahead of the store read. */
const VIRTUAL_EMPTY_TREE: VerifiedObject = { type: 'tree', acceptance: undefined };

/**
 * git's `parse_object` read for one ref-update target: the object exists and
 * its stored bytes hash to `id`. Every `openBlobSource` arm hashes under
 * `verifyHash: true` (buffered below the gate, hashed while it inflates
 * above it), so this never materialises a large body. A promised object is
 * lazy-fetched before it is reported missing.
 */
export async function verifyStoredObject(ctx: Context, id: ObjectId): Promise<VerifiedObject> {
  const registry = peekPackRegistry(ctx) ?? (await getPackRegistry(ctx));
  return withLazyFetchRetry(ctx, id, registry, () => hashStoredObject(ctx, registry, id));
}

/** A commit or tag target starts a parse-acceptance scan alongside the hash;
 *  git parses neither a blob nor a tree, so those get no scan at all. */
function startScanFor(type: ObjectType, hexLength: 40 | 64): ParseAcceptanceScan | undefined {
  return type === 'commit' || type === 'tag' ? startParseAcceptance(type, hexLength) : undefined;
}

async function hashStoredObject(
  ctx: Context,
  registry: PackRegistry,
  id: ObjectId,
): Promise<VerifiedObject> {
  if (id === emptyTreeOid(ctx.hashConfig)) {
    // Same order as resolveObjectContentWithDepth: the store-setup gate runs
    // before the virtual tree short-circuit.
    await registry.assertLoadable();
    return VIRTUAL_EMPTY_TREE;
  }
  const source = await openBlobSource(ctx, id, MAX_BUFFERED_BLOB_BYTES, { verifyHash: true });
  const scan = startScanFor(source.type, ctx.hashConfig.hexLength);
  if (source.kind === 'bytes') {
    return { type: source.type, acceptance: scan && feedParseAcceptance(scan, source.content) };
  }
  // Draining is the hash: the arm's own tail throws OBJECT_HASH_MISMATCH
  // after the last chunk, before the verdict is ever read from `acceptance`.
  let acceptance = scan;
  for await (const chunk of source.stream) {
    acceptance = acceptance && feedParseAcceptance(acceptance, chunk);
  }
  return { type: source.type, acceptance };
}

function fitsBuffer(byteLength: number, maxBufferedBytes: number): boolean {
  return byteLength <= maxBufferedBytes;
}

/** Splits an inflated loose-format buffer into a bytes source and, when the
 *  header's declared size was honest (matches the actual content length) AND
 *  the object is NOT a blob, warms `ctx.deltaCache` under `id` — mirroring
 *  `resolveObjectContentWithDepth`'s own loose arm. A size-lying header
 *  (tolerated only for a blob) is never cached: a later consumer keyed on
 *  `id` would read the wrong claim. Blobs are excluded on purpose (measured:
 *  a checkout-scale buffered-blob walk — 300×60 KiB, exceeding the default
 *  16 MiB budget — evicted every tree/commit entry the walk had warmed,
 *  forcing them to re-read) — this seam is reached once per blob per caller
 *  (a diff's whitespace-drop predicate, a ref target's hash verification),
 *  so caching them only spends budget a repeatedly-walked tree or commit
 *  would otherwise keep warm. */
function toCachedBytesSource(ctx: Context, id: ObjectId, looseFormatBytes: Uint8Array): BlobSource {
  const split = splitLooseObject(looseFormatBytes);
  assertLooseSizeConsistent(split);
  if (split.type !== 'blob' && split.declaredSize === split.content.byteLength) {
    cacheEntry(ctx.deltaCache, id, { type: split.type, content: split.content });
  }
  return { kind: 'bytes', type: split.type, content: split.content };
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

async function resolveFromCache(
  ctx: Context,
  id: ObjectId,
  cached: ObjectContent,
  gate: BufferGate,
): Promise<BlobSource> {
  await verifyObjectContent(ctx, id, cached.type, cached.content, gate.verifyHash);
  return { kind: 'bytes', ...cached };
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
    return toCachedBytesSource(ctx, id, inflated);
  }
  const iterator = readableStreamToAsyncIterable(inflateOneShot(ctx, compressed))[
    Symbol.asyncIterator
  ]();
  const header = await readHeaderOrRelease(id, iterator);
  return {
    kind: 'stream',
    type: header.type,
    materialised: false,
    stream: yieldAndVerifyLooseChunks(ctx, id, header, iterator, gate.verifyHash),
    release: () => returnIterator(iterator),
  };
}

/** Reads the loose header eagerly so the caller learns `type` at open; a
 *  header that never resolves (no NUL, no output) must still release the
 *  iterator it partially drained, or the inflate pipeline leaks. */
async function readHeaderOrRelease(
  id: ObjectId,
  iterator: AsyncIterator<Uint8Array>,
): Promise<HeaderStripped> {
  try {
    return await readLooseHeader(id, iterator);
  } catch (error) {
    await returnIterator(iterator);
    throw error;
  }
}

async function resolvePackBase(
  ctx: Context,
  id: ObjectId,
  baseType: 1 | 2 | 3 | 4,
  declaredSize: number,
  payload: Uint8Array,
  gate: BufferGate,
  offset: number,
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
  // payload, pass both tests, and still force a ~64 MiB inflate — the cost of
  // that single inflate call is not bounded ahead of time; only its result is.
  // `assertInflatedSizeMatches`, right below, refuses the object as soon as the
  // inflated byte count disagrees with the declared one, before either the
  // cache write or the hash check runs. That is no worse than the loose arm,
  // whose ceiling is the same 64 KiB-compressed bound, and both sit under the
  // compressor port's 2 GiB inflate cap. Bounding the inflate call's own cost
  // ahead of time would take streaming the entry and counting bytes as it
  // decompresses, which is a different gate than this one.
  if (
    fitsBuffer(payload.length, gate.maxBufferedBytes) &&
    fitsBuffer(declaredSize, gate.maxBufferedBytes)
  ) {
    const content = await ctx.compressor.inflate(payload);
    assertInflatedSizeMatches(offset, declaredSize, content.byteLength);
    // Blobs excluded: see `toCachedBytesSource`'s doc — a read-once buffered
    // blob only spends the shared cache's budget a repeatedly-walked tree or
    // commit would otherwise keep warm.
    if (type !== 'blob') {
      cacheEntry(ctx.deltaCache, id, { type, content });
    }
    await verifyObjectContent(ctx, id, type, content, gate.verifyHash);
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
      offset,
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
  const resolved = await resolvePackChain(ctx, registry, hit, id, undefined);
  await verifyObjectContent(ctx, id, resolved.type, resolved.content, gate.verifyHash);
  return { kind: 'bytes', ...resolved };
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

/** Result of reading the git object header from accumulated inflate chunks:
 *  the stored type, alongside the header and initial content bytes so the
 *  streaming tail can hash them without re-reading. */
interface HeaderStripped {
  readonly type: ObjectType;
  readonly headerBytes: Uint8Array;
  readonly content: Uint8Array;
}

/**
 * Accumulate inflate chunks until the NUL byte is found, then return the
 * stored type, the header bytes (including NUL) and the initial content
 * slice. Never refuses on type — every consumer decides that for itself
 * (`streamBlob`'s wrap tail, the ref-target verifier).
 */
async function readLooseHeader(
  id: ObjectId,
  iterator: AsyncIterator<Uint8Array>,
): Promise<HeaderStripped> {
  const first = await iterator.next();
  if (first.done === true) {
    throw invalidObjectHeader(`inflate stream produced no output for object ${id}`);
  }
  let buf = first.value;
  for (;;) {
    const nullPos = buf.indexOf(0x00);
    if (nullPos !== -1) {
      const { type } = parseHeader(buf);
      return {
        type,
        headerBytes: buf.subarray(0, nullPos + 1),
        content: buf.subarray(nullPos + 1),
      };
    }

    const next = await iterator.next();
    if (next.done === true) {
      throw invalidObjectHeader(`no NUL terminator found in inflated object ${id}`);
    }
    buf = concat(buf, next.value);
  }
}

/** Cancels the inflate pipeline THROUGH the iterator that read the header —
 *  by then the readable is locked to it, so cancelling the readable directly
 *  would reject on the lock and release nothing (`readableStreamToAsyncIterable`'s
 *  `return` swallows on our behalf). */
async function returnIterator(iterator: AsyncIterator<Uint8Array>): Promise<void> {
  await iterator.return?.();
}

/**
 * Streaming tail for the loose path. The header is already known (read at
 * open by `readLooseHeader`); this hashes it and the remaining chunks with
 * incremental verification.
 */
async function* yieldAndVerifyLooseChunks(
  ctx: Context,
  id: ObjectId,
  header: HeaderStripped,
  iterator: AsyncIterator<Uint8Array>,
  verifyHash: boolean,
): AsyncIterable<Uint8Array> {
  const hasher: Hasher | undefined = verifyHash ? ctx.hash.createHasher() : undefined;

  try {
    hasher?.update(header.headerBytes);

    if (header.content.length > 0) {
      hasher?.update(header.content);
      yield header.content;
    }

    for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
      if (ctx.signal?.aborted === true) {
        throw operationAborted();
      }
      hasher?.update(chunk);
      yield chunk;
    }

    await finalizeHash(hasher, id);
  } finally {
    await returnIterator(iterator);
  }
}

/**
 * Streaming tail for packed BASE entries. Pack base entries hold raw content
 * bytes (no loose-format header in the inflated output). The canonical header
 * `<type> <declaredSize>\0` is built from the pack entry header's own type and
 * declared inflated size — both known before inflation — so chunks can be
 * yielded as they arrive. The inflated length is known only once the stream
 * ends, so the declared-size check — the same structural refusal the buffered
 * arm and the index-pack write path enforce (`assertInflatedSizeMatches`,
 * `PACK_ENTRY_INFLATED_SIZE_MISMATCH_REASON`) — runs after the last chunk,
 * over a running byte count rather than the buffered bytes themselves. A hash
 * mismatch cannot substitute for it: `verifyObjectContent`/`finalizeHash`
 * rehash the object's OWN true content length, which a lying declared size
 * never changes.
 */
async function* yieldAndVerifyPackedBaseChunks(
  ctx: Context,
  id: ObjectId,
  chunks: AsyncIterable<Uint8Array>,
  type: ObjectType,
  declaredSize: number,
  verifyHash: boolean,
  offset: number,
): AsyncIterable<Uint8Array> {
  const hasher: Hasher | undefined = verifyHash ? ctx.hash.createHasher() : undefined;

  hasher?.update(syntheticObjectHeader(type, declaredSize));

  let total = 0;
  for await (const chunk of chunks) {
    if (ctx.signal?.aborted === true) {
      throw operationAborted();
    }
    total += chunk.byteLength;
    hasher?.update(chunk);
    yield chunk;
  }
  assertInflatedSizeMatches(offset, declaredSize, total);

  await finalizeHash(hasher, id);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
