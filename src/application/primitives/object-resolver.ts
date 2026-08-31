/**
 * Internal object resolver — loose-first-then-pack, iterative delta walker.
 * Consumed only by readObject.
 */
import { operationAborted, TsgitError } from '../../domain/error.js';
import { encode } from '../../domain/objects/encoding.js';
import { objectHashMismatch, objectNotFound, objectTooLarge } from '../../domain/objects/error.js';
import {
  emptyTreeOid,
  type GitObject,
  type ObjectId,
  parseHeader,
  parseObject,
} from '../../domain/objects/index.js';
import { MAX_DELTA_CHAIN_DEPTH } from '../../domain/storage/delta.js';
import { deltaChainTooDeep, invalidPackIndex } from '../../domain/storage/error.js';
import {
  applyDelta,
  type LruCache,
  PACK_ENTRY_TYPE,
  type PackEntryHeader,
  parsePackEntryHeader,
  readDeltaTargetSize,
} from '../../domain/storage/index.js';
import type { Context } from '../../ports/context.js';
import { forgetLooseOidPrefix, probeLooseOid } from './internal/loose-oid-cache.js';
import {
  cacheDeltaBase,
  enforcePackBaseCap,
  parsedObjectByteSize,
  parsedObjectMemoFor,
  probeDeltaBaseCache,
} from './internal/object-caches.js';
import {
  deltaBaseCacheKey,
  nextOffsetForEntry,
  type PackLookupHit,
  type PackRegistry,
} from './pack-registry.js';
import { commonGitDir, looseObjectPath } from './path-layout.js';

/**
 * Git treats the empty tree as a virtual, always-present object — resolvable
 * anywhere a tree-ish is valid even though it was never written to disk. The
 * loose-format content `tree 0\0` (7 bytes, zero content bytes) hashes to the
 * empty-tree oid for the active algorithm by construction, so `verifyHash`
 * holds trivially and no size cap can trip (content length is 0). Scope is
 * ONLY the empty tree — the empty blob is not virtual and still misses.
 */
const EMPTY_TREE_BYTES = new TextEncoder().encode('tree 0\0');

/**
 * Depth-aware object-bytes resolution — the single entry point for every
 * caller. The arms mirror the read model: empty-tree / deltaCache hit /
 * loose read never walk a delta chain, so each reports depth 0; a pack hit
 * threads `externalDepth` into `resolvePackChain` (bounding the cap early,
 * and any further REF_DELTA recursion beneath it) and surfaces the chain's
 * true depth back out. `resolveObject` (below) and `readRawObject`
 * (read-object.ts) call it with `externalDepth` 0 on the hottest read path;
 * `resolveBaseForRefDelta` calls it with the accumulated depth of the chain
 * that reached the base, and the base's own true depth comes back out for
 * the caching loop to record accurately.
 */
export async function resolveObjectBytesWithDepth(
  ctx: Context,
  registry: PackRegistry,
  id: ObjectId,
  verifyHash: boolean,
  maxBytes: number | undefined,
  externalDepth: number,
): Promise<{ bytes: Uint8Array; chainDepth: number }> {
  // An already-aborted read honours the abort before paying any scan I/O.
  checkAborted(ctx);
  // Git dies during object-store setup, ahead of every read — a structurally
  // self-inconsistent multi-pack-index must deny loose reads too, so this
  // gate sits before the empty-tree short-circuit and the deltaCache probe.
  await registry.assertLoadable();
  if (id === emptyTreeOid(ctx.hashConfig)) {
    return { bytes: EMPTY_TREE_BYTES, chainDepth: 0 };
  }
  const cached = ctx.deltaCache.get(id);
  if (cached !== undefined) {
    enforceCachedCap(id, cached, maxBytes);
    return { bytes: await verifyAndReturn(ctx, id, cached, verifyHash), chainDepth: 0 };
  }
  const loose = await tryLoose(ctx, id);
  if (loose !== undefined) {
    checkAborted(ctx);
    enforceLooseCap(id, loose, maxBytes);
    cacheEntry(ctx.deltaCache, id, loose);
    return { bytes: await verifyAndReturn(ctx, id, loose, verifyHash), chainDepth: 0 };
  }

  checkAborted(ctx);
  const hit = await registry.lookup(id);
  if (hit === undefined) {
    throw objectNotFound(id);
  }
  checkAborted(ctx);
  const resolved = await resolvePackChainWithDepth(ctx, registry, hit, id, maxBytes, externalDepth);
  checkAborted(ctx);
  return {
    bytes: await verifyAndReturn(ctx, id, resolved.bytes, verifyHash),
    chainDepth: resolved.chainDepth,
  };
}

export async function resolveObject(
  ctx: Context,
  registry: PackRegistry,
  id: ObjectId,
  verifyHash: boolean,
  maxBytes?: number,
): Promise<GitObject> {
  const { bytes } = await resolveObjectBytesWithDepth(ctx, registry, id, verifyHash, maxBytes, 0);
  const memo = parsedObjectMemoFor(ctx);
  const memoised = memo?.get(id);
  if (memoised !== undefined) return memoised;
  const parsed = parseObject(id, bytes, ctx.hashConfig);
  if (parsed.type === 'commit' || parsed.type === 'tag') {
    memo?.set(id, parsed, parsedObjectByteSize(parsed.data, ctx.hashConfig.hexLength));
  }
  return parsed;
}

/**
 * Loose objects materialise the full payload before this check fires (zlib's
 * compression ratio is unbounded, so a pre-inflate cap on the compressed file
 * is not meaningful). We measure the ACTUAL content byte count
 * (`inflated.length - contentOffset`) rather than the declared header size —
 * a hostile object can claim a tiny size and ship a huge body; the
 * memory-relevant quantity is what zlib already produced.
 */
function enforceLooseCap(id: ObjectId, inflated: Uint8Array, maxBytes: number | undefined): void {
  if (maxBytes === undefined) return;
  const { contentOffset } = parseHeader(inflated);
  const actualSize = inflated.length - contentOffset;
  if (actualSize > maxBytes) {
    throw objectTooLarge(id, actualSize, maxBytes);
  }
}

/**
 * Enforce the cap on cached bytes that bypass the regular read path. The LRU
 * stores raw loose-format `<type> <size>\0...` buffers; a previous uncapped
 * read may have admitted an oversized object that a later capped read would
 * otherwise see for free. The content size is `bytes.length - (nulIdx + 1)`.
 */
function enforceCachedCap(id: ObjectId, cached: Uint8Array, maxBytes: number | undefined): void {
  if (maxBytes === undefined) return;
  const nulIdx = cached.indexOf(0);
  // Defence-in-depth: a header-less cached buffer has no measurable content
  // size, so skip the cap and let `splitHeader` reject it downstream as
  // OBJECT_NOT_FOUND. The well-formed paths (`prependHeader` /
  // `serializeObject`) always emit a `<type> <size>\0...` header, but a
  // poisoned cache entry exercises this branch.
  if (nulIdx < 0) return;
  const actualSize = cached.length - (nulIdx + 1);
  if (actualSize > maxBytes) {
    throw objectTooLarge(id, actualSize, maxBytes);
  }
}

/**
 * Pre-apply cap for pack delta entries. Reads the OUTERMOST delta's
 * target-size varint (the final reconstructed object size) — costs ~10
 * bytes and bypasses both the apply loop and the
 * `new Uint8Array(targetSize)` allocation. Only fires once per chain
 * (`depth === 1`); intermediate deltas in the chain reference
 * intermediate base sizes that don't correspond to the user-visible
 * target.
 */
// Stryker disable BlockStatement: equivalent — this whole function is a pure pre-apply perf optimisation; emptying any block here (the function body, or the oversize-throw branch) defers to the post-apply cap in `resolvePackChain`, which raises the identical OBJECT_TOO_LARGE.
function enforcePackDeltaPreApplyCap(
  targetId: ObjectId,
  instructions: Uint8Array,
  maxBytes: number | undefined,
  depth: number,
): void {
  // This pre-apply cap is observationally equivalent to the post-apply cap
  // in `resolvePackChain` — both throw OBJECT_TOO_LARGE with the same
  // id/size/limit when the target is oversized. The pre-apply variant
  // exists purely as a performance optimisation (skip the apply loop + the
  // result allocation).
  if (maxBytes === undefined) return;
  // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — skipping the pre-apply cap leaves the post-apply cap in `resolvePackChain` to throw the identical OBJECT_TOO_LARGE; only timing differs.
  if (depth !== 1) return;
  const declaredTargetSize = readDeltaTargetSize(instructions);
  if (declaredTargetSize > maxBytes) {
    throw objectTooLarge(targetId, declaredTargetSize, maxBytes);
  }
}
// Stryker restore BlockStatement

function checkAborted(ctx: Context): void {
  if (ctx.signal?.aborted === true) {
    throw operationAborted();
  }
}

async function tryLoose(ctx: Context, id: ObjectId): Promise<Uint8Array | undefined> {
  const compressed = await readLooseCompressed(ctx, id);
  if (compressed === undefined) return undefined;
  return ctx.compressor.inflate(compressed);
}

/**
 * Membership-gated loose read. A cached HIT whose file has vanished (an
 * external pruner — `git gc` — removed it between the readdir and this
 * read) is git-faithfully a MISS: drop the stale set and fall through to
 * the pack, exactly as git's loose-open ENOENT does.
 */
async function readLooseCompressed(ctx: Context, id: ObjectId): Promise<Uint8Array | undefined> {
  if (!(await probeLooseOid(ctx, id))) return undefined;
  const path = looseObjectPath(commonGitDir(ctx), id);
  try {
    return await ctx.fs.read(path);
  } catch (error) {
    if (error instanceof TsgitError && error.data.code === 'FILE_NOT_FOUND') {
      forgetLooseOidPrefix(ctx, id);
      return undefined;
    }
    throw error;
  }
}

/**
 * Returns the raw compressed bytes for a loose object, or undefined if it
 * does not exist. Does not inflate — callers that need streaming inflate use
 * `createInflateStream` on these bytes directly.
 */
export async function looseCompressedBytes(
  ctx: Context,
  id: ObjectId,
): Promise<Uint8Array | undefined> {
  return readLooseCompressed(ctx, id);
}

/**
 * The unverified arm skips the hash entirely (F15's sync fast path for a
 * delta-cache hit), so it carries its OWN abort poll rather than relying on
 * the one between hash and compare below — omitting it would let a cache-hot
 * read return without ever observing an abort raised while this call was in
 * flight, unlike every other branch.
 */
async function verifyAndReturn(
  ctx: Context,
  id: ObjectId,
  bytes: Uint8Array,
  verifyHash: boolean,
): Promise<Uint8Array> {
  if (!verifyHash) {
    checkAborted(ctx);
    return bytes;
  }
  const actual = (await ctx.hash.hashHex(bytes)) as ObjectId;
  checkAborted(ctx);
  if (actual !== id) {
    throw objectHashMismatch(id, actual);
  }
  return bytes;
}

interface DeltaStep {
  readonly instructions: Uint8Array;
  readonly resolvedBaseId: ObjectId | undefined; // for REF_DELTA we know the base id; for OFS we don't necessarily
  /** Offset this step's entry was found at — the key `resolvePackChain`
   *  caches this level's reconstructed content under. */
  readonly offset: number;
  /** The `deltaBaseCacheKey(packName, offset)` string already built to probe
   *  this level — carried forward so `resolvePackChain`'s later cache write
   *  for this same offset reuses it instead of rebuilding an identical key. */
  readonly probeKey: string;
}

interface Phase1Result {
  readonly deltas: ReadonlyArray<DeltaStep>;
  readonly baseContent: Uint8Array;
  readonly baseType: PackEntryHeader['type'];
  /**
   * Offset `baseContent` was freshly read from, or `undefined` when it came
   * from a cache hit (already cached — re-caching would be redundant) or
   * from a REF_DELTA's base (resolved by id, possibly from a different pack
   * or a loose object — no single `(pack, offset)` applies).
   */
  readonly baseOffset: number | undefined;
  /**
   * How deep the resumed base itself already sat below whatever chain
   * reached it first — 0 for a freshly-read base entry, or `cached.chainDepth`
   * when this level came from a delta-base cache hit (see
   * `collectDeltaChain`'s probe). The caching loop in `resolvePackChain` adds
   * this onto every level IT re-caches — without it, a chain resumed from a
   * cache hit would recount its own newly-walked levels as if the resumed
   * base sat at depth zero, undercounting by exactly the depth the cache hit
   * skipped.
   *
   * For a REF_DELTA's resolved base, this is the base object's OWN true
   * chain depth — `resolveBaseForRefDelta` surfaces
   * `deltas.length + baseChainDepth` from the inner `resolvePackChain` that
   * reconstructed it. The cross-hop bound comes ENTIRELY from threading
   * `externalDepth` down into that inner `collectDeltaChain` call (via
   * `resolveObjectBytesWithDepth`): every terminator of the inner walk —
   * the per-level delta check, a cache-hit resumption, a nested REF_DELTA
   * hop — already asserts `externalDepth + depth [+ chainDepth]` against
   * the cap one frame down, before the base's bytes ever come back up here.
   * So `MAX_DELTA_CHAIN_DEPTH` bounds a chain's true length once it crosses
   * a REF_DELTA hop, not just each segment in isolation, without this level
   * needing to re-check the combined sum itself.
   *
   * One honest residual: a base served from the id-keyed `ctx.deltaCache`
   * (see `resolveBaseForRefDelta`'s own cache check) reports depth 0 even
   * when the object was originally delta-resolved — that cache stores raw
   * bytes only, never the depth they were reconstructed at. Consequence: a
   * chain that refuses cold (every hop walked and counted) can resolve warm
   * once an inner object populates that cache first — the cap still bounds
   * the recursion and I/O THIS walk performs, just not the reconstructed
   * chain's true length once a warm hit reports 0.
   */
  readonly baseChainDepth: number;
}

/** Extracted so both the per-level walk and a cache-hit resumption share one
 *  throw site rather than duplicating the branch inline. Also reused by
 *  `readObjectMetadata`'s header-only base-type walk (read-object.ts), so a
 *  third delta-chain walker cannot drift from the cap the other two enforce. */
export function assertChainDepthWithinCap(depth: number): void {
  if (depth > MAX_DELTA_CHAIN_DEPTH) {
    throw deltaChainTooDeep(depth);
  }
}

async function collectDeltaChain(
  ctx: Context,
  registry: PackRegistry,
  hit: PackLookupHit,
  targetId: ObjectId,
  maxBytes: number | undefined,
  externalDepth: number,
): Promise<Phase1Result> {
  const deltas: DeltaStep[] = [];
  let currentHit: PackLookupHit = hit;
  let depth = 0;
  // OFS_DELTA always stays on the same pack; REF_DELTA and base entries return
  // before the next iteration, so hit.pack is invariant for the whole loop.
  const table = await hit.pack.offsetTable();

  for (;;) {
    checkAborted(ctx);
    // Built once per level and carried on the pushed `DeltaStep` below, so a
    // probe miss that becomes a delta level never rebuilds this same key for
    // `resolvePackChain`'s later cache write.
    const probeKey = deltaBaseCacheKey(currentHit.pack.name, currentHit.offset);
    // Probe BEFORE descending: a level cached by an earlier chain (this
    // offset reached as someone else's intermediate) short-circuits the
    // whole rest of the walk exactly as reaching a real base entry would.
    const cached = probeDeltaBaseCache(ctx, registry, probeKey, targetId, maxBytes);
    if (cached !== undefined) {
      // The hit resumes from partway down the chain — depth so far (levels
      // actually walked) plus whatever the cached entry itself still has
      // beneath it, so a chain deeper than MAX_DELTA_CHAIN_DEPTH still
      // throws even though this walk never touched its lower levels.
      // `externalDepth` adds whatever depth a REF_DELTA hop already
      // accumulated before this walk even started.
      assertChainDepthWithinCap(externalDepth + depth + cached.chainDepth);
      return {
        deltas,
        baseContent: cached.content,
        baseType: cached.type,
        baseOffset: undefined,
        baseChainDepth: cached.chainDepth,
      };
    }
    const nextOffset = nextOffsetForEntry(table, currentHit.offset);
    if (nextOffset > table.packFileSize) {
      throw invalidPackIndex('next offset exceeds pack file size: corrupt index');
    }
    const { header, chunk, headerEndInChunk } = await readEntryHeaderWithChunk(
      ctx,
      currentHit,
      nextOffset,
    );
    if (isBase(header)) {
      enforcePackBaseCap(targetId, header.size, maxBytes);
      const inflated = await ctx.compressor.inflate(chunk.subarray(headerEndInChunk));
      return {
        deltas,
        baseContent: inflated,
        baseType: header.type,
        baseOffset: currentHit.offset,
        baseChainDepth: 0,
      };
    }
    depth += 1;
    assertChainDepthWithinCap(externalDepth + depth);
    const instructions = await ctx.compressor.inflate(chunk.subarray(headerEndInChunk));
    // Stryker disable next-line CallExpression: equivalent — this pre-apply cap is a documented perf-only optimisation (see enforcePackDeltaPreApplyCap's own docstring): removing the call leaves the POST-apply cap in resolvePackChainWithDepth (current.length > maxBytes) to throw the identical OBJECT_TOO_LARGE, just after the wasted apply+allocation instead of before it (full covering set — object-resolver, read-object, stream-blob, blob-source, fsck, pack-registry — passes unmutated).
    enforcePackDeltaPreApplyCap(targetId, instructions, maxBytes, depth);

    if (header.type === PACK_ENTRY_TYPE.OFS_DELTA) {
      const baseOffset = ofsDeltaBaseOffset(targetId, currentHit.offset, header.baseDistance);
      deltas.push({ instructions, resolvedBaseId: undefined, offset: currentHit.offset, probeKey });
      currentHit = { pack: currentHit.pack, offset: baseOffset };
      continue;
    }
    if (header.type === PACK_ENTRY_TYPE.REF_DELTA) {
      const refDeltaBaseId = header.baseId;
      deltas.push({
        instructions,
        resolvedBaseId: refDeltaBaseId,
        offset: currentHit.offset,
        probeKey,
      });
      // Cap propagates into the REF_DELTA base resolution so an oversized
      // base never inflates fully. The cap applies to the BASE object now,
      // not just the delta's target — tightens the OBJECT_TOO_LARGE
      // contract beyond what originally documented. `depth` already counts
      // this REF level's own increment above, so `externalDepth + depth` is
      // the accumulated depth at this exact point — not double-counted.
      const base = await resolveBaseForRefDelta(
        ctx,
        registry,
        refDeltaBaseId,
        maxBytes,
        externalDepth + depth,
      );
      return {
        deltas,
        baseContent: base.content,
        baseType: base.type,
        baseOffset: undefined,
        baseChainDepth: base.chainDepth,
      };
    }
    throw objectNotFound(targetId);
  }
}

/** An OFS_DELTA's base offset is a distance BACK from the entry's own offset
 *  — never forward, and never off the front of the pack. Exported so
 *  `readObjectMetadata`'s header-only base-type walk (read-object.ts) reuses
 *  the same arithmetic rather than re-deriving it. */
export function ofsDeltaBaseOffset(
  targetId: ObjectId,
  entryOffset: number,
  baseDistance: number,
): number {
  const baseOffset = entryOffset - baseDistance;
  if (baseOffset < 0) {
    throw objectNotFound(targetId);
  }
  return baseOffset;
}

export async function resolvePackChain(
  ctx: Context,
  registry: PackRegistry,
  hit: PackLookupHit,
  targetId: ObjectId,
  maxBytes: number | undefined,
): Promise<Uint8Array> {
  const resolved = await resolvePackChainWithDepth(ctx, registry, hit, targetId, maxBytes, 0);
  return resolved.bytes;
}

/**
 * Depth-aware core `resolvePackChain` delegates to (with `externalDepth` 0).
 * Threads `externalDepth` into `collectDeltaChain` so a chain reached through
 * a REF_DELTA hop is bounded by the SAME cap the outer walk enforces, and
 * surfaces the reconstructed object's own true chain depth
 * (`deltas.length + baseChainDepth`) back to `resolveObjectBytesWithDepth` —
 * the only other caller, used from `resolveBaseForRefDelta`.
 */
async function resolvePackChainWithDepth(
  ctx: Context,
  registry: PackRegistry,
  hit: PackLookupHit,
  targetId: ObjectId,
  maxBytes: number | undefined,
  externalDepth: number,
): Promise<{ bytes: Uint8Array; chainDepth: number }> {
  const phase1 = await collectDeltaChain(ctx, registry, hit, targetId, maxBytes, externalDepth);

  // Apply deltas bottom-up. A REF_DELTA terminator's base was cached (by id)
  // inside `resolveObjectBytesWithDepth`'s own loose/pack arms as it was
  // resolved; every OFS/REF level here is cached too, now by (pack, offset) —
  // the fix for the gap the old comment documented: mid-chain intermediates
  // have no known ObjectId, so a REF's own id-keyed cache could only ever
  // hold a chain's tip.
  let current = phase1.baseContent;
  // Only a real delta chain populates the offset-keyed cache: a single
  // non-delta base entry (deltas.length === 0) is never a delta target and
  // never a future chain's intermediate, so caching it under its own offset
  // would only ever be a wasted entry. The base never went through the probe
  // above (only `DeltaStep`s did), so its key is built fresh here — the one
  // key this function still computes rather than reuses.
  if (phase1.deltas.length > 0 && phase1.baseOffset !== undefined) {
    cacheDeltaBase(
      ctx,
      registry,
      deltaBaseCacheKey(hit.pack.name, phase1.baseOffset),
      phase1.baseType,
      current,
      0,
    );
  }
  for (let i = phase1.deltas.length - 1; i >= 0; i -= 1) {
    const step = phase1.deltas[i];
    if (step === undefined) break;
    current = applyDelta(current, step.instructions);
    // How many delta applications lie between THIS level and the true base:
    // 1 for the level closest to the base (i === deltas.length - 1), up to
    // deltas.length for the target's own level (i === 0) — PLUS whatever
    // depth the resumed base itself already carried (`baseChainDepth`,
    // nonzero exactly when `phase1` resumed from a delta-base cache hit).
    // Omitting that term would recount every level THIS walk re-caches as if
    // the resumed base sat at depth zero, undercounting by exactly the depth
    // the cache hit skipped — the gap a chain of successive warm reads
    // compounds across.
    const chainDepth = phase1.deltas.length - i + phase1.baseChainDepth;
    cacheDeltaBase(ctx, registry, step.probeKey, phase1.baseType, current, chainDepth);
  }
  // Post-apply cap on the reconstructed object (delta resolution is the only
  // place a payload can grow beyond what the base entry declared). The check
  // fires before `prependHeader` allocates the loose-format buffer that would
  // otherwise double the peak footprint.
  if (maxBytes !== undefined && current.length > maxBytes) {
    throw objectTooLarge(targetId, current.length, maxBytes);
  }
  // Cache the final reconstructed object under targetId for future lookups.
  const fullBytes = prependHeader(current, phase1.baseType, targetId);
  cacheEntry(ctx.deltaCache, targetId, fullBytes);
  return { bytes: fullBytes, chainDepth: phase1.deltas.length + phase1.baseChainDepth };
}

function prependHeader(
  content: Uint8Array,
  type: PackEntryHeader['type'],
  targetId: ObjectId,
): Uint8Array {
  const typeName = packTypeName(type, targetId);
  const headerStr = `${typeName} ${content.length}\0`;
  const headerBytes = encode(headerStr);
  const out = new Uint8Array(headerBytes.length + content.length);
  out.set(headerBytes, 0);
  out.set(content, headerBytes.length);
  return out;
}

function packTypeName(type: PackEntryHeader['type'], targetId: ObjectId): string {
  switch (type) {
    case PACK_ENTRY_TYPE.COMMIT:
      return 'commit';
    case PACK_ENTRY_TYPE.TREE:
      return 'tree';
    case PACK_ENTRY_TYPE.BLOB:
      return 'blob';
    case PACK_ENTRY_TYPE.TAG:
      return 'tag';
    default:
      // Unreachable by construction (isBase narrowed the type), but an
      // explicit throw catches corrupted pack entries that bypass isBase.
      throw objectNotFound(targetId);
  }
}

export function isBase(h: PackEntryHeader): h is PackEntryHeader & { type: 1 | 2 | 3 | 4 } {
  return (
    h.type === PACK_ENTRY_TYPE.COMMIT ||
    h.type === PACK_ENTRY_TYPE.TREE ||
    h.type === PACK_ENTRY_TYPE.BLOB ||
    h.type === PACK_ENTRY_TYPE.TAG
  );
}

/**
 * Reads the exact byte slice [entryOffset, nextOffset) from the pack file and
 * parses the entry header. The slice is bounded by the on-disk pack file size,
 * so the allocation is proportional to the compressed member, not the inflated
 * output. No per-object size cap is applied here because the inflated output is
 * capped separately by the compressor's `maxOutputLength` — adding a second cap
 * would create a lower ceiling than the caller's contract permits.
 */
export async function readEntryHeaderWithChunk(
  ctx: Context,
  hit: PackLookupHit,
  nextOffset: number,
): Promise<{ header: PackEntryHeader; chunk: Uint8Array; headerEndInChunk: number }> {
  const sliceLength = nextOffset - hit.offset;
  if (sliceLength <= 0) {
    throw invalidPackIndex('slice length ≤ 0: next offset not beyond entry offset');
  }
  // Read exactly the bytes belonging to this entry: [entryOffset, nextOffset).
  // REF_DELTA base-id length follows the active hash algorithm (SHA-1=20, SHA-256=32).
  // Routed through the pack's persistent handle (A4) — one `open` per pack for
  // the whole chain walk, not one per step.
  const chunk = await hit.pack.readSlice(hit.offset, sliceLength);
  const header = parsePackEntryHeader(chunk, 0, ctx.hashConfig);
  // parsePackEntryHeader was invoked with offset=0, so dataOffset is already
  // the position within the chunk where the zlib stream starts.
  return { header, chunk, headerEndInChunk: header.dataOffset };
}

async function resolveBaseForRefDelta(
  ctx: Context,
  registry: PackRegistry,
  baseId: ObjectId,
  maxBytes: number | undefined,
  externalDepth: number,
): Promise<{ content: Uint8Array; type: PackEntryHeader['type']; chainDepth: number }> {
  // Resolve the base object (may recurse into another chain) and strip its header
  // to obtain content + type for delta application.
  const cached = ctx.deltaCache.get(baseId);
  // Stryker disable next-line BlockStatement: equivalent — a perf-only shortcut: skipping this early return falls through to resolveObjectBytesWithDepth(baseId, ...), whose OWN ctx.deltaCache.get(baseId) hit (the same cache, same key) applies the identical enforceCachedCap and returns the identical bytes with chainDepth 0 via verifyAndReturn(verifyHash=false) — byte-for-byte the same result, one extra function-call hop (object-resolver.test.ts's full suite passes unmutated).
  if (cached !== undefined) {
    // Cache stores raw loose-format (header+content). An earlier uncapped
    // read may have admitted an oversized object; enforce the cap here
    // before returning bytes that bypass the regular read path. This
    // id-keyed cache holds bytes only, never the depth they were
    // reconstructed at, so a base served from here is honestly reported at
    // depth 0 even when it was originally delta-resolved. Consequence: a
    // chain whose base warms this cache first can admit a REF hop a cold
    // read of the same chain would refuse — the cap still bounds the
    // recursion and work THIS walk performs, just not the reconstructed
    // chain's true length once this hit reports 0.
    enforceCachedCap(baseId, cached, maxBytes);
    return { ...splitHeader(cached, baseId), chainDepth: 0 };
  }
  // Depth-aware bytes-only resolution (not the public `resolveObject`): the
  // base is applied to a delta, never returned to a caller as a parsed
  // object, and this walk needs the base's own true chain depth back out —
  // `externalDepth` bounds it against the SAME cap the outer walk enforces.
  // Deliberately skips the parse/re-serialize round-trip `resolveObject` +
  // `serializeObject` used to impose: delta application binds the base's
  // TRUE raw bytes, matching git — a base that would not survive that
  // round-trip now deltas correctly against its real bytes, and a
  // structurally malformed base no longer surfaces a parse error here
  // (also git's behaviour). `resolveObjectBytesWithDepth`'s own arms
  // (loose read, pack chain reconstruction) already cache the resolved
  // bytes under `baseId` — re-caching them here would be redundant.
  const resolved = await resolveObjectBytesWithDepth(
    ctx,
    registry,
    baseId,
    false,
    maxBytes,
    externalDepth,
  );
  return { ...splitHeader(resolved.bytes, baseId), chainDepth: resolved.chainDepth };
}

function splitHeader(
  bytes: Uint8Array,
  sourceId: ObjectId,
): {
  content: Uint8Array;
  type: PackEntryHeader['type'];
} {
  // Cache bytes come from our own resolvePackChainWithDepth /
  // resolveObjectBytesWithDepth paths, which always produce
  // `<type> <size>\0...`. If those invariants ever break, treat it as a
  // missing object rather than silently mis-typing.
  const nulIdx = bytes.indexOf(0);
  // Stryker disable next-line EqualityOperator: equivalent — at the only differing input (`nulIdx === 0`) the fall-through path finds no space (`space === -1`) and throws the identical OBJECT_NOT_FOUND.
  if (nulIdx < 0) {
    throw objectNotFound(sourceId);
  }
  const space = bytes.subarray(0, nulIdx).indexOf(0x20);
  // Stryker disable next-line EqualityOperator: equivalent — at the only differing input (`space === 0`) the fall-through path decodes an empty type name and `typeNameToPackType` throws the identical OBJECT_NOT_FOUND.
  if (space < 0) {
    throw objectNotFound(sourceId);
  }
  const typeName = new TextDecoder().decode(bytes.subarray(0, space));
  return { content: bytes.subarray(nulIdx + 1), type: typeNameToPackType(typeName, sourceId) };
}

function typeNameToPackType(name: string, sourceId: ObjectId): PackEntryHeader['type'] {
  switch (name) {
    case 'commit':
      return PACK_ENTRY_TYPE.COMMIT;
    case 'tree':
      return PACK_ENTRY_TYPE.TREE;
    case 'blob':
      return PACK_ENTRY_TYPE.BLOB;
    case 'tag':
      return PACK_ENTRY_TYPE.TAG;
    default:
      throw objectNotFound(sourceId);
  }
}

function cacheEntry(cache: LruCache<Uint8Array>, id: ObjectId, bytes: Uint8Array): void {
  // bytes always contains a loose-format header (`<type> <size>\0...`), so the
  // array is non-empty by construction — no zero-length guard needed.
  cache.set(id, bytes, bytes.length);
}
