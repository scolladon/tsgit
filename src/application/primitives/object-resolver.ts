/**
 * Internal object resolver — loose-first-then-pack, iterative delta walker.
 * Consumed only by readObject.
 */
import { operationAborted } from '../../domain/error.js';
import { objectHashMismatch, objectNotFound } from '../../domain/objects/error.js';
import {
  type GitObject,
  type ObjectId,
  parseObject,
  serializeObject,
} from '../../domain/objects/index.js';
import { MAX_DELTA_CHAIN_DEPTH } from '../../domain/storage/delta.js';
import { deltaChainTooDeep } from '../../domain/storage/error.js';
import {
  applyDelta,
  type LruCache,
  PACK_ENTRY_TYPE,
  type PackEntryHeader,
  parsePackEntryHeader,
} from '../../domain/storage/index.js';
import type { Context } from '../../ports/context.js';
import type { PackLookupHit, PackRegistry } from './pack-registry.js';
import { looseObjectPath } from './path-layout.js';

const PACK_SLICE_HINT = 1 << 16;

export async function resolveObject(
  ctx: Context,
  registry: PackRegistry,
  id: ObjectId,
  verifyHash: boolean,
): Promise<GitObject> {
  checkAborted(ctx);
  const loose = await tryLoose(ctx, id);
  if (loose !== undefined) {
    checkAborted(ctx);
    return finalize(ctx, id, loose, verifyHash);
  }

  checkAborted(ctx);
  const hit = await registry.lookup(id);
  if (hit === undefined) {
    throw objectNotFound(id);
  }
  checkAborted(ctx);
  const bytes = await resolvePackChain(ctx, registry, hit, id);
  checkAborted(ctx);
  return finalize(ctx, id, bytes, verifyHash);
}

function checkAborted(ctx: Context): void {
  if (ctx.signal?.aborted === true) {
    throw operationAborted();
  }
}

async function tryLoose(ctx: Context, id: ObjectId): Promise<Uint8Array | undefined> {
  const path = looseObjectPath(ctx.config.gitDir, id);
  if (!(await ctx.fs.exists(path))) return undefined;
  const compressed = await ctx.fs.read(path);
  return ctx.compressor.inflate(compressed);
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
): Promise<Phase1Result> {
  const deltas: DeltaStep[] = [];
  let currentHit: PackLookupHit = hit;
  let depth = 0;

  for (;;) {
    checkAborted(ctx);
    const { header, chunk, headerEndInChunk } = await readEntryHeaderWithChunk(ctx, currentHit);
    if (isBase(header)) {
      const inflated = await ctx.compressor.streamInflate(chunk, headerEndInChunk);
      return {
        deltas,
        baseContent: inflated.output,
        baseType: header.type,
      };
    }
    depth += 1;
    if (depth > MAX_DELTA_CHAIN_DEPTH) {
      throw deltaChainTooDeep(depth);
    }
    const { output: instructions } = await ctx.compressor.streamInflate(chunk, headerEndInChunk);

    if (header.type === PACK_ENTRY_TYPE.OFS_DELTA) {
      const nextOffset = currentHit.offset - header.baseDistance;
      if (nextOffset < 0) {
        throw objectNotFound(targetId);
      }
      deltas.push({ instructions, resolvedBaseId: undefined });
      currentHit = { pack: currentHit.pack, offset: nextOffset };
      continue;
    }
    if (header.type === PACK_ENTRY_TYPE.REF_DELTA) {
      const refDeltaBaseId = header.baseId;
      deltas.push({ instructions, resolvedBaseId: refDeltaBaseId });
      const base = await resolveBaseForRefDelta(ctx, registry, refDeltaBaseId);
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
): Promise<Uint8Array> {
  const phase1 = await collectDeltaChain(ctx, registry, hit, targetId);

  // Phase 2 — apply deltas bottom-up. The REF_DELTA terminator already cached
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

async function readEntryHeaderWithChunk(
  ctx: Context,
  hit: PackLookupHit,
): Promise<{ header: PackEntryHeader; chunk: Uint8Array; headerEndInChunk: number }> {
  // Read a generous slice at the entry offset; header parse and the zlib stream
  // both live inside this chunk so a single read covers both. REF_DELTA base-id
  // length follows the active hash algorithm (SHA-1 = 20 bytes, SHA-256 = 32).
  const chunk = await ctx.fs.readSlice(hit.pack.packPath, hit.offset, PACK_SLICE_HINT);
  const header = parsePackEntryHeader(chunk, 0, ctx.hashConfig);
  // parsePackEntryHeader was invoked with offset=0, so dataOffset is already
  // the position within the chunk where the zlib stream starts.
  return { header, chunk, headerEndInChunk: header.dataOffset };
}

async function resolveBaseForRefDelta(
  ctx: Context,
  registry: PackRegistry,
  baseId: ObjectId,
): Promise<{ content: Uint8Array; type: PackEntryHeader['type'] }> {
  // Resolve the base object (may recurse into another chain) and strip its header
  // to obtain content + type for delta application.
  const cached = ctx.deltaCache.get(baseId);
  if (cached !== undefined) {
    // Cache stores raw loose-format (header+content). Strip the header.
    return splitHeader(cached, baseId);
  }
  const obj = await resolveObject(ctx, registry, baseId, false);
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
  if (nulIdx < 0) {
    throw objectNotFound(sourceId);
  }
  const space = bytes.subarray(0, nulIdx).indexOf(0x20);
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
