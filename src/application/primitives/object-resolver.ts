/**
 * Internal object resolver — loose-first-then-pack, iterative delta walker.
 * Consumed only by readObject.
 */
import { operationAborted } from '../../domain/error.js';
import { objectHashMismatch, objectNotFound, objectTooLarge } from '../../domain/objects/error.js';
import {
  type GitObject,
  type ObjectId,
  parseHeader,
  parseObject,
  serializeObject,
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
import { nextOffsetForEntry, type PackLookupHit, type PackRegistry } from './pack-registry.js';
import { commonGitDir, looseObjectPath } from './path-layout.js';

export async function resolveObject(
  ctx: Context,
  registry: PackRegistry,
  id: ObjectId,
  verifyHash: boolean,
  maxBytes?: number,
): Promise<GitObject> {
  checkAborted(ctx);
  const loose = await tryLoose(ctx, id);
  if (loose !== undefined) {
    checkAborted(ctx);
    enforceLooseCap(id, loose, maxBytes);
    return finalize(ctx, id, loose, verifyHash);
  }

  checkAborted(ctx);
  const hit = await registry.lookup(id);
  if (hit === undefined) {
    throw objectNotFound(id);
  }
  checkAborted(ctx);
  const bytes = await resolvePackChain(ctx, registry, hit, id, maxBytes);
  checkAborted(ctx);
  return finalize(ctx, id, bytes, verifyHash);
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
 * Pre-inflate cap for pack base entries — fires at ANY depth, not just
 * `depth === 0`. The cap exists to bound memory: when the chain walker
 * reaches a base entry whose declared inflated size exceeds the cap, the
 * subsequent `inflate` materialises a buffer larger than the
 * contract permits regardless of whether the final delta-applied result
 * shrinks below the cap.
 */
function enforcePackBaseCap(
  targetId: ObjectId,
  declaredSize: number,
  maxBytes: number | undefined,
): void {
  if (maxBytes === undefined) return;
  if (declaredSize > maxBytes) {
    throw objectTooLarge(targetId, declaredSize, maxBytes);
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
  const path = looseObjectPath(commonGitDir(ctx), id);
  if (!(await ctx.fs.exists(path))) return undefined;
  const compressed = await ctx.fs.read(path);
  return ctx.compressor.inflate(compressed);
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
  const path = looseObjectPath(commonGitDir(ctx), id);
  if (!(await ctx.fs.exists(path))) return undefined;
  return ctx.fs.read(path);
}

async function finalize(
  ctx: Context,
  id: ObjectId,
  bytes: Uint8Array,
  verifyHash: boolean,
): Promise<GitObject> {
  if (verifyHash) {
    const actual = (await ctx.hash.hashHex(bytes)) as ObjectId;
    checkAborted(ctx);
    if (actual !== id) {
      throw objectHashMismatch(id, actual);
    }
  }
  return parseObject(id, bytes, ctx.hashConfig);
}

interface DeltaStep {
  readonly instructions: Uint8Array;
  readonly resolvedBaseId: ObjectId | undefined; // for REF_DELTA we know the base id; for OFS we don't necessarily
}

interface Phase1Result {
  readonly deltas: ReadonlyArray<DeltaStep>;
  readonly baseContent: Uint8Array;
  readonly baseType: PackEntryHeader['type'];
}

async function collectDeltaChain(
  ctx: Context,
  registry: PackRegistry,
  hit: PackLookupHit,
  targetId: ObjectId,
  maxBytes: number | undefined,
): Promise<Phase1Result> {
  const deltas: DeltaStep[] = [];
  let currentHit: PackLookupHit = hit;
  let depth = 0;
  // OFS_DELTA always stays on the same pack; REF_DELTA and base entries return
  // before the next iteration, so hit.pack is invariant for the whole loop.
  const table = await hit.pack.offsetTable();

  for (;;) {
    checkAborted(ctx);
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
      };
    }
    depth += 1;
    if (depth > MAX_DELTA_CHAIN_DEPTH) {
      throw deltaChainTooDeep(depth);
    }
    const instructions = await ctx.compressor.inflate(chunk.subarray(headerEndInChunk));
    enforcePackDeltaPreApplyCap(targetId, instructions, maxBytes, depth);

    if (header.type === PACK_ENTRY_TYPE.OFS_DELTA) {
      const baseOffset = currentHit.offset - header.baseDistance;
      if (baseOffset < 0) {
        throw objectNotFound(targetId);
      }
      deltas.push({ instructions, resolvedBaseId: undefined });
      currentHit = { pack: currentHit.pack, offset: baseOffset };
      continue;
    }
    if (header.type === PACK_ENTRY_TYPE.REF_DELTA) {
      const refDeltaBaseId = header.baseId;
      deltas.push({ instructions, resolvedBaseId: refDeltaBaseId });
      // Cap propagates into the REF_DELTA base resolution so an oversized
      // base never inflates fully. The cap applies to the BASE object now,
      // not just the delta's target — tightens the OBJECT_TOO_LARGE
      // contract beyond what originally documented.
      const base = await resolveBaseForRefDelta(ctx, registry, refDeltaBaseId, maxBytes);
      return { deltas, baseContent: base.content, baseType: base.type };
    }
    throw objectNotFound(targetId);
  }
}

async function resolvePackChain(
  ctx: Context,
  registry: PackRegistry,
  hit: PackLookupHit,
  targetId: ObjectId,
  maxBytes: number | undefined,
): Promise<Uint8Array> {
  const phase1 = await collectDeltaChain(ctx, registry, hit, targetId, maxBytes);

  // apply deltas bottom-up. The REF_DELTA terminator already cached
  // its base in `resolveBaseForRefDelta`; intermediate results are NOT cached
  // here because their ObjectId is unknown (mid-chain intermediates do not
  // correspond to step.resolvedBaseId — that id refers to the base, not the
  // post-apply result).
  let current = phase1.baseContent;
  for (let i = phase1.deltas.length - 1; i >= 0; i -= 1) {
    const step = phase1.deltas[i];
    if (step === undefined) break;
    current = applyDelta(current, step.instructions);
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
  return fullBytes;
}

function prependHeader(
  content: Uint8Array,
  type: PackEntryHeader['type'],
  targetId: ObjectId,
): Uint8Array {
  const typeName = packTypeName(type, targetId);
  const headerStr = `${typeName} ${content.length}\0`;
  const headerBytes = new TextEncoder().encode(headerStr);
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

function isBase(h: PackEntryHeader): h is PackEntryHeader & { type: 1 | 2 | 3 | 4 } {
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
async function readEntryHeaderWithChunk(
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
  const chunk = await ctx.fs.readSlice(hit.pack.packPath, hit.offset, sliceLength);
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
): Promise<{ content: Uint8Array; type: PackEntryHeader['type'] }> {
  // Resolve the base object (may recurse into another chain) and strip its header
  // to obtain content + type for delta application.
  const cached = ctx.deltaCache.get(baseId);
  if (cached !== undefined) {
    // Cache stores raw loose-format (header+content). An earlier uncapped
    // read may have admitted an oversized object; enforce the cap here
    // before returning bytes that bypass the regular read path.
    enforceCachedCap(baseId, cached, maxBytes);
    return splitHeader(cached, baseId);
  }
  const obj = await resolveObject(ctx, registry, baseId, false, maxBytes);
  const rawBytes = serializeObject(obj, ctx.hashConfig);
  cacheEntry(ctx.deltaCache, baseId, rawBytes);
  return splitHeader(rawBytes, baseId);
}

function splitHeader(
  bytes: Uint8Array,
  sourceId: ObjectId,
): {
  content: Uint8Array;
  type: PackEntryHeader['type'];
} {
  // Cache bytes come from our own resolvePackChain / serializeObject paths, which
  // always produce `<type> <size>\0...`. If those invariants ever break, treat it
  // as a missing object rather than silently mis-typing.
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
