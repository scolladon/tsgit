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
import { errorDataCode } from '../../../domain/error-data-code.js';
import { concatBytes } from '../../../domain/objects/encoding.js';
import {
  invalidObjectHeader,
  looseObjectCorrupt,
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
  applyLooseVerdict,
  assertInflatedSizeMatches,
  cacheEntry,
  inflateLooseBuffered,
  isBase,
  type LooseReadMode,
  looseCompressedBytes,
  ownerUnavailableHit,
  readEntryHeaderWithChunk,
  resolvePackChain,
  verifyObjectContent,
} from '../object-resolver.js';
import {
  getObjectStore,
  looseCacheLocation,
  type ObjectSource,
  type ObjectStore,
  peekObjectStore,
} from '../object-store.js';
import { nextOffsetForEntry, type PackLookupHit, type PackRegistry } from '../pack-registry.js';
import {
  declaredTypeAtHit,
  getPackRegistry,
  peekPackRegistry,
  readDeclaredObjectHeader,
  withLazyFetchRetry,
} from '../read-object.js';
import type { StreamBlobOptions } from '../stream-blob.js';
import { readStrictBigFileThreshold } from './big-file-threshold.js';
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

/** Which of git's two per-source search orders locates the blob. `'stream'` is
 *  `open_istream`'s (a large non-delta pack entry wins, loose is the fallback,
 *  the delta cache is never consulted); `'in-core'` is `read_object`'s (loose
 *  first, then pack, the delta cache first of all). */
export type BlobReadOrder = 'stream' | 'in-core';

/** INTERNAL superset of the public `StreamBlobOptions`: `looseMode` selects
 *  git's buffered vs streamed loose read tier (`object-resolver.ts`'s
 *  `LooseReadMode`) per blob, and `order` the per-source search order. Every
 *  public `streamBlob`/`verifyStoredObject` caller stays on the public option
 *  shape and keeps today's `'streamed'` default — only an internal caller (the
 *  whitespace-drop predicate) asks for `'buffered'`. */
interface OpenBlobSourceOptions extends StreamBlobOptions {
  readonly looseMode?: LooseReadMode;
  readonly order: BlobReadOrder;
  /** `'spent'` when the caller's own probe already re-scanned for this id, so
   *  a miss is final instead of paying git's one retry a second time. */
  readonly missRescan?: MissRescan;
}

type MissRescan = 'pending' | 'spent';

type PackEntryRead = Awaited<ReturnType<typeof readEntryHeaderWithChunk>>;

interface LocatedBase {
  readonly id: ObjectId;
  readonly store: ObjectStore;
  readonly source: ObjectSource;
}

export type LocatedBlob =
  | (LocatedBase & { readonly arm: 'loose'; readonly compressed: Uint8Array })
  | (LocatedBase & {
      readonly arm: 'pack';
      readonly hit: PackLookupHit;
      readonly entry: PackEntryRead;
    });

type LocatedPack = Extract<LocatedBlob, { readonly arm: 'pack' }>;

interface BufferGate {
  readonly maxBufferedBytes: number;
  readonly verifyHash: boolean;
  readonly looseMode: LooseReadMode;
}

export async function openBlobSource(
  ctx: Context,
  id: ObjectId,
  maxBufferedBytes: number,
  options: OpenBlobSourceOptions,
): Promise<BlobSource> {
  const store = await openLoadableStore(ctx);
  if (options.order === 'in-core') {
    const cached = await tryDeltaCacheHit(ctx, id, gateOf(maxBufferedBytes, options));
    if (cached !== undefined) return cached;
  }
  const located = await locateWithRescan(ctx, store, id, options.order, options.missRescan);
  if (located === undefined) throw objectNotFound(id);
  return serveLocatedBlob(ctx, located, maxBufferedBytes, options);
}

/** A blob's whole content, opened in git's stream order: a small packed blob
 *  reaches every source, a large non-delta pack entry is served in place. */
export async function readBlobContentInStreamOrder(
  ctx: Context,
  id: ObjectId,
): Promise<Uint8Array> {
  const source = await openBlobSource(ctx, id, MAX_BUFFERED_BLOB_BYTES, {
    order: 'stream',
    looseMode: 'streamed',
  });
  if (source.kind === 'bytes') return source.content;
  const chunks: Uint8Array[] = [];
  for await (const chunk of source.stream) chunks.push(chunk);
  return concatBytes(chunks);
}

/** Locates `id` in git's `order` with the full-miss rescan, reporting a miss
 *  as `undefined` instead of throwing. */
export async function locateBlob(
  ctx: Context,
  id: ObjectId,
  options: { readonly order: BlobReadOrder },
): Promise<LocatedBlob | undefined> {
  const store = await openLoadableStore(ctx);
  return locateWithRescan(ctx, store, id, options.order);
}

export async function serveLocatedBlob(
  ctx: Context,
  located: LocatedBlob,
  maxBufferedBytes: number,
  options: OpenBlobSourceOptions,
): Promise<BlobSource> {
  return serveLocated(ctx, located, gateOf(maxBufferedBytes, options));
}

const gateOf = (maxBufferedBytes: number, options: OpenBlobSourceOptions): BufferGate => ({
  maxBufferedBytes,
  verifyHash: options.verifyHash ?? false,
  looseMode: options.looseMode ?? 'streamed',
});

async function openLoadableStore(ctx: Context): Promise<ObjectStore> {
  checkAborted(ctx);
  const store = peekObjectStore(ctx) ?? (await getObjectStore(ctx));
  // Same store-setup gate as resolveObjectContent: a structurally
  // self-inconsistent multi-pack-index denies streamed loose reads too —
  // otherwise the two read paths would disagree about a corrupt store.
  await store.primary.registry.assertLoadable();
  return store;
}

async function locateWithRescan(
  ctx: Context,
  store: ObjectStore,
  id: ObjectId,
  order: BlobReadOrder,
  missRescan: MissRescan = 'pending',
): Promise<LocatedBlob | undefined> {
  const locate = order === 'stream' ? locateStream : locateInCore;
  const first = await locate(ctx, store, id);
  if (first !== undefined || missRescan === 'spent') return first;
  // Full miss: as of the CURRENT generation, no source claims `id`. Mirrors
  // `resolveObjectContent`'s own retry — `retryOnceAfterRescan`
  // single-flights the re-scan across concurrent misses and honours an abort
  // raised during it.
  return retryOnceAfterRescan(
    ctx,
    store,
    id,
    async () => (await locate(ctx, store, id)) ?? locateViaOwnerUnavailable(ctx, store, id),
  );
}

/** The second read's last resort, as git's `find_pack_entry` serves a midx owner it cannot open. */
async function locateViaOwnerUnavailable(
  ctx: Context,
  store: ObjectStore,
  id: ObjectId,
): Promise<LocatedBlob | undefined> {
  const found = await ownerUnavailableHit(store, id);
  if (found === undefined) return undefined;
  return locatePackHit(ctx, store, found.source, found.hit, id);
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

async function readPackEntry(
  ctx: Context,
  store: ObjectStore,
  source: ObjectSource,
  id: ObjectId,
): Promise<LocatedBlob | undefined> {
  checkAborted(ctx);
  const hit = await source.registry.lookup(id);
  if (hit === undefined) return undefined;
  return locatePackHit(ctx, store, source, hit, id);
}

async function locatePackHit(
  ctx: Context,
  store: ObjectStore,
  source: ObjectSource,
  hit: PackLookupHit,
  id: ObjectId,
): Promise<LocatedPack> {
  const table = await hit.pack.offsetTable();
  const nextOffset = nextOffsetForEntry(table, hit.offset);
  const entry = await readEntryHeaderWithChunk(ctx, hit, nextOffset, table.packFileSize);
  return { arm: 'pack', id, store, source, hit, entry };
}

async function readLooseEntry(
  ctx: Context,
  store: ObjectStore,
  source: ObjectSource,
  id: ObjectId,
): Promise<LocatedBlob | undefined> {
  const compressed = await looseCompressedBytes(ctx, id, looseCacheLocation(store, source));
  return compressed === undefined ? undefined : { arm: 'loose', id, store, source, compressed };
}

const isLargeBase = (located: LocatedBlob, threshold: number): boolean =>
  located.arm === 'pack' && isBase(located.entry.header) && located.entry.header.size > threshold;

/** git's `packfile_read_object_stream` reads the threshold for every pack hit,
 *  before it weighs the entry's type. */
const servesLargeBase = async (ctx: Context, packed: LocatedBlob | undefined): Promise<boolean> =>
  packed !== undefined && isLargeBase(packed, await readStrictBigFileThreshold(ctx));

/**
 * git's `open_istream` order, one source at a time: a pack entry that is a
 * non-delta larger than `core.bigFileThreshold` wins; otherwise the first
 * source's pack entry is held back while the loose arm and every later source
 * get their turn, and it is served only when nothing better turns up. Any
 * other error (a corrupt entry) propagates, never a miss.
 */
async function locateStream(
  ctx: Context,
  store: ObjectStore,
  id: ObjectId,
): Promise<LocatedBlob | undefined> {
  let firstHeld: LocatedBlob | undefined;
  for (const source of store.sources) {
    if (source !== store.primary) await source.registry.assertLoadable();
    const packed = await readPackEntry(ctx, store, source, id);
    if (await servesLargeBase(ctx, packed)) return packed;
    firstHeld ??= packed;
    const loose = await readLooseEntry(ctx, store, source, id);
    if (loose !== undefined) return loose;
  }
  return firstHeld;
}

/** git's `read_object` order, one source at a time: loose, then pack. */
async function locateInCore(
  ctx: Context,
  store: ObjectStore,
  id: ObjectId,
): Promise<LocatedBlob | undefined> {
  for (const source of store.sources) {
    if (source !== store.primary) await source.registry.assertLoadable();
    const found =
      (await readLooseEntry(ctx, store, source, id)) ??
      (await readPackEntry(ctx, store, source, id));
    if (found !== undefined) return found;
  }
  return undefined;
}

async function serveLocated(
  ctx: Context,
  located: LocatedBlob,
  gate: BufferGate,
): Promise<BlobSource> {
  const { id } = located;
  if (located.arm === 'loose') {
    checkAborted(ctx);
    return resolveLoose(ctx, id, located.compressed, gate);
  }
  const { header, chunk, headerEndInChunk } = located.entry;
  if (isBase(header)) {
    const payload = chunk.subarray(headerEndInChunk);
    return resolvePackBase(ctx, id, header.type, header.size, payload, gate, located.hit.offset);
  }
  checkAborted(ctx);
  return resolvePackDelta(ctx, located.store, located.source, located.hit, id, gate);
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

/** git's `parse_object` reads a blob through the object stream and every other
 *  type in core, so the type is probed header-only before the read order is
 *  chosen. The probe misses like any read: `odb_read_object_info` re-scans the
 *  packs once before giving up. An object still without a stored header after
 *  that (a delta-cache entry) has no order to pick: the read itself owns the
 *  final miss. */
async function readOrderFor(ctx: Context, id: ObjectId): Promise<ReadPlan> {
  const type = await probeStoredType(ctx, id);
  if (type === undefined) return { order: 'in-core', missRescan: 'spent' };
  return { order: type === 'blob' ? 'stream' : 'in-core', missRescan: 'pending' };
}

interface ReadPlan {
  readonly order: BlobReadOrder;
  readonly missRescan: MissRescan;
}

async function probeStoredType(ctx: Context, id: ObjectId): Promise<ObjectType | undefined> {
  const probe = async (): Promise<ObjectType | undefined> => {
    try {
      return (await readDeclaredObjectHeader(ctx, id)).type;
    } catch (error) {
      if (errorDataCode(error) === 'OBJECT_NOT_FOUND') return undefined;
      throw error;
    }
  };
  const first = await probe();
  if (first !== undefined) return first;
  const store = peekObjectStore(ctx) ?? (await getObjectStore(ctx));
  return retryOnceAfterRescan(
    ctx,
    store,
    id,
    async () => (await probe()) ?? typeViaOwnerUnavailable(ctx, store, id),
  );
}

/** A delta entry's type is its chain base's, read from headers without inflating the chain. */
async function typeViaOwnerUnavailable(
  ctx: Context,
  store: ObjectStore,
  id: ObjectId,
): Promise<ObjectType | undefined> {
  const found = await ownerUnavailableHit(store, id);
  if (found === undefined) return undefined;
  return declaredTypeAtHit(ctx, found.source.registry, found.hit, id);
}

/**
 * Same order as resolveObjectContent: the store-setup gate runs
 * before the virtual tree short-circuit.
 */
async function verifiedEmptyTree(registry: PackRegistry): Promise<VerifiedObject> {
  await registry.assertLoadable();
  return VIRTUAL_EMPTY_TREE;
}

async function hashStoredObject(
  ctx: Context,
  registry: PackRegistry,
  id: ObjectId,
): Promise<VerifiedObject> {
  if (id === emptyTreeOid(ctx.hashConfig)) return verifiedEmptyTree(registry);
  const source = await openBlobSource(ctx, id, MAX_BUFFERED_BLOB_BYTES, {
    verifyHash: true,
    ...(await readOrderFor(ctx, id)),
  });
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

/** Caches `content` under `id` when the type is NOT a blob AND the caller's
 *  own verdict judges it `cacheable` — the streamed arm's declared-size-equals
 *  check and the buffered arm's `applyLooseVerdict` verdict both funnel
 *  through this one rule so neither re-implements it. A size-lying header
 *  (tolerated only for a blob) is never cached: a later consumer keyed on
 *  `id` would read the wrong claim. Blobs are excluded on purpose (measured:
 *  a checkout-scale buffered-blob walk — 300×60 KiB, exceeding the default
 *  16 MiB budget — evicted every tree/commit entry the walk had warmed,
 *  forcing them to re-read) — this seam is reached once per blob per caller
 *  (a diff's whitespace-drop predicate, a ref target's hash verification),
 *  so caching them only spends budget a repeatedly-walked tree or commit
 *  would otherwise keep warm. */
function toCachedBytesSource(
  ctx: Context,
  id: ObjectId,
  type: ObjectType,
  content: Uint8Array,
  cacheable: boolean,
): BlobSource {
  if (type !== 'blob' && cacheable) {
    cacheEntry(ctx.deltaCache, id, { type, content });
  }
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
    return gate.looseMode === 'buffered'
      ? resolveLooseBytesBuffered(ctx, id, compressed, gate.verifyHash)
      : resolveLooseBytesStreamed(ctx, id, compressed, gate.verifyHash);
  }
  return resolveLooseStreamArm(ctx, id, compressed, gate);
}

/** git's streaming-tier bytes arm: a full, uncapped inflate that ignores the
 *  header's size claim, serving a size-lying blob's real bytes. */
async function resolveLooseBytesStreamed(
  ctx: Context,
  id: ObjectId,
  compressed: Uint8Array,
  verifyHash: boolean,
): Promise<BlobSource> {
  const inflated = await ctx.compressor.inflate(compressed);
  await verifyBufferedBytes(ctx, id, inflated, verifyHash);
  const split = splitLooseObject(inflated);
  assertLooseSizeConsistent(split);
  // Stryker disable next-line ConditionalExpression: equivalent — toCachedBytesSource only
  // reads `cacheable` when type!=='blob', and assertLooseSizeConsistent above already refused
  // any non-blob mismatch, so this is always true whenever it matters.
  return toCachedBytesSource(
    ctx,
    id,
    split.type,
    split.content,
    split.declaredSize === split.content.byteLength,
  );
}

/** git's buffered-tier bytes arm: `inflateLooseBuffered` bounds the inflate
 *  to header + declared size, and `applyLooseVerdict` routes the resulting
 *  split to its servable bytes — neither routing decision is re-implemented
 *  here. */
async function resolveLooseBytesBuffered(
  ctx: Context,
  id: ObjectId,
  compressed: Uint8Array,
  verifyHash: boolean,
): Promise<BlobSource> {
  const { split } = await inflateLooseBuffered(ctx, id, compressed);
  const { content, cacheable } = applyLooseVerdict(split);
  await verifyObjectContent(ctx, id, split.type, content, verifyHash, split.declaredSize);
  return toCachedBytesSource(ctx, id, split.type, content, cacheable);
}

async function resolveLooseStreamArm(
  ctx: Context,
  id: ObjectId,
  compressed: Uint8Array,
  gate: BufferGate,
): Promise<BlobSource> {
  const iterator = readableStreamToAsyncIterable(inflateOneShot(ctx, compressed))[
    Symbol.asyncIterator
  ]();
  const header = await readHeaderOrRelease(id, iterator);
  // The whole object is already streaming, so it is well past git's 32-byte
  // header window — `applyLooseVerdict`'s window truncation can never apply
  // here; an overrun on this arm is always a refusal (checked incrementally
  // by `yieldAndVerifyLooseChunks`, never by materialising the claim first).
  const declaredSize = gate.looseMode === 'buffered' ? header.declaredSize : undefined;
  return {
    kind: 'stream',
    type: header.type,
    materialised: false,
    stream: yieldAndVerifyLooseChunks(ctx, id, header, iterator, gate.verifyHash, declaredSize),
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
  store: ObjectStore,
  source: ObjectSource,
  hit: PackLookupHit,
  id: ObjectId,
  gate: BufferGate,
): Promise<BlobSource> {
  const resolved = await resolvePackChain(ctx, store, source, hit, id, undefined);
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
  readonly declaredSize: number;
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
      const { type, size } = parseHeader(buf);
      return {
        type,
        headerBytes: buf.subarray(0, nullPos + 1),
        content: buf.subarray(nullPos + 1),
        declaredSize: size,
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

/** The buffered tier's own bound for the STREAM arm, checked incrementally so
 *  a small claim never buys a caller a full-size stream first — an overrun is
 *  `LOOSE_OBJECT_CORRUPT`; `declaredSize === undefined` (the streamed tier)
 *  skips the check entirely. */
function assertWithinClaim(id: ObjectId, total: number, declaredSize: number | undefined): void {
  if (declaredSize !== undefined && total > declaredSize) {
    throw looseObjectCorrupt(id);
  }
}

/**
 * Streaming tail for the loose path. The header is already known (read at
 * open by `readLooseHeader`); this hashes it and the remaining chunks with
 * incremental verification. `declaredSize` given (buffered mode) also
 * refuses as `LOOSE_OBJECT_CORRUPT` as soon as the body overruns the claim — undefined (streamed mode)
 * ignores the claim entirely, as git's streaming tier does.
 */
async function* yieldAndVerifyLooseChunks(
  ctx: Context,
  id: ObjectId,
  header: HeaderStripped,
  iterator: AsyncIterator<Uint8Array>,
  verifyHash: boolean,
  declaredSize?: number,
): AsyncIterable<Uint8Array> {
  const hasher: Hasher | undefined = verifyHash ? ctx.hash.createHasher() : undefined;
  let total = 0;

  try {
    hasher?.update(header.headerBytes);

    if (header.content.length > 0) {
      total += header.content.length;
      assertWithinClaim(id, total, declaredSize);
      hasher?.update(header.content);
      yield header.content;
    }

    for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
      if (ctx.signal?.aborted === true) {
        throw operationAborted();
      }
      total += chunk.byteLength;
      assertWithinClaim(id, total, declaredSize);
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
