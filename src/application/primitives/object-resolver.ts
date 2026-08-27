/**
 * Internal object resolver — loose-first-then-pack, iterative delta walker.
 * Consumed only by readObject.
 */
import { operationAborted, TsgitError } from '../../domain/error.js';
import { encode } from '../../domain/objects/encoding.js';
import { objectHashMismatch, objectNotFound, objectTooLarge } from '../../domain/objects/error.js';
import {
  type Commit,
  emptyTreeOid,
  type GitObject,
  type ObjectId,
  parseHeader,
  parseObject,
  serializeObject,
  type Tag,
} from '../../domain/objects/index.js';
import { MAX_DELTA_CHAIN_DEPTH } from '../../domain/storage/delta.js';
import { deltaChainTooDeep, invalidPackIndex } from '../../domain/storage/error.js';
import {
  applyDelta,
  createLruCache,
  type LruCache,
  PACK_ENTRY_TYPE,
  type PackEntryHeader,
  parsePackEntryHeader,
  readDeltaTargetSize,
} from '../../domain/storage/index.js';
import type { Context } from '../../ports/context.js';
import { forgetLooseOidPrefix, probeLooseOid } from './internal/loose-oid-cache.js';
import {
  type DeltaBaseCacheEntry,
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
 * Parsed-commit-and-tag memo. `resolveObject` re-parses on every read
 * even when `resolveObjectBytes` already served the raw bytes from
 * `ctx.deltaCache` — the memo skips that redundant re-parse for the two
 * object types whose parse cost is non-trivial (blob/tree already return
 * near-raw data from `parseObject`). It sits strictly AFTER
 * `resolveObjectBytes`, so every verifyHash/maxBytes check that call already
 * performs still fires on every read: the memo only ever skips
 * reconstructing an object the bytes already proved identical, never a
 * safety check.
 *
 * Keyed on `ctx.session` — not `ctx` itself — so the memo survives every
 * spread-derivation this codebase does (a worktree or submodule Context,
 * `listWorktrees`'s per-worktree Contexts, …), sharing one memo per
 * repository instead of missing on every fresh spread.
 *
 * fsck's audit Context shares the session (it isolates only `deltaCache`),
 * so keying on session ALONE would let it read and populate this memo from
 * the very object-byte state it exists to bypass. `deltaBaseCachingEnabled`
 * (below) is the gate that keeps it out: a zero-budget `deltaCache` disables
 * this memo too, exactly as it disables the offset-keyed delta-base cache.
 */
type MemoisedObject = Commit | Tag;

const parsedObjectMemos = new WeakMap<Context['session'], LruCache<MemoisedObject>>();

/**
 * Share of `ctx.deltaCache`'s own byte budget the parsed-object memo gets,
 * as an independent allocation (not carved out of the byte cache itself —
 * the two caches hold different things and compete only for process
 * memory/cache locality, not a shared accounting ledger).
 *
 * A/B-measured (`log`/`show`/`describe`/`blame`'s medium-fixture scenarios,
 * plus `loose-read`'s two scenarios to price the shared budget) at 1/16,
 * 1/8 and 1/4 of the 16 MiB default. Absolute means, ms, memo disabled
 * (fraction 0) vs each candidate:
 *
 * | scenario                | disabled | 1/16  | 1/8   | 1/4   |
 * |-------------------------|---------:|------:|------:|------:|
 * | log (medium, 5000)      |   18.30  |  7.80 |  8.11 |  8.22 |
 * | log via commit-graph    |   18.09  |  7.65 |  7.86 |  7.71 |
 * | show (medium)           |    0.324 | 0.271 | 0.275 | 0.275 |
 * | describe (medium)       |    0.761 | 0.536 | 0.535 | 0.531 |
 * | blame (deep, 500)       |    2.766 | 1.386 | 1.390 | 1.379 |
 * | loose-read (fresh repo) |    0.491 | 0.479 | 0.483 | 0.476 |
 * | loose-read (reused)     |  0.0007  |0.0007 |0.0007 |0.0007 |
 *
 * Enabling the memo at all is the win (>2x on `log`/`log`-via-graph/`blame`,
 * ~15-30% on `show`/`describe`); the three fractions land within each
 * other's noise band on this fixture, because the memo's footprint here
 * (message-only, per {@link parsedObjectByteSize}) is tiny next to any of
 * the three caps — none of them evict mid-walk. `loose-read` (blob-only,
 * never touches this memo) is flat across every fraction, confirming no
 * interference with the existing loose-read byte cache that shares
 * `ctx.deltaCache`'s budget. 1/16 wins outright on the dominant `log`
 * scenario and claims the least share of the shared budget, so it is the
 * one that ships.
 */
export const PARSED_OBJECT_MEMO_FRACTION = 0.0625;

function parsedObjectMemoFor(ctx: Context): LruCache<MemoisedObject> | undefined {
  if (!deltaBaseCachingEnabled(ctx)) return undefined;
  const existing = parsedObjectMemos.get(ctx.session);
  if (existing !== undefined) return existing;
  const created = createLruCache<MemoisedObject>(
    ctx.deltaCache.maxSize * PARSED_OBJECT_MEMO_FRACTION,
  );
  parsedObjectMemos.set(ctx.session, created);
  return created;
}

/**
 * Drops `id` from the parsed-commit/tag memo, if one exists for this
 * session — the counterpart `ctx.deltaCache.delete` does not reach, since
 * this memo lives outside `deltaCache`'s own byte budget. Neither cache has
 * a generation concept: nothing normally deletes an object, so nothing
 * normally needed to forget one. `maintenance`'s `gc` task is the first
 * caller that does, and it calls this for every oid it destroys — an
 * un-invalidated HIT here would let a destroyed commit or tag keep reading
 * back successfully forever, which is exactly the guarantee gc's expiry
 * cutoff exists to break.
 */
export function forgetParsedObjectMemo(ctx: Context, id: ObjectId): void {
  parsedObjectMemos.get(ctx.session)?.delete(id);
}

/**
 * Approximate retained footprint of a parsed commit/tag: the sum of its
 * unbounded-length fields — the message, an armored gpg/ssh signature, and
 * any extra header's key+value (a `mergetag` header can embed a whole
 * nested tag object). Fixed-size fields (the tree/object oid, parent oids,
 * identity name/email/timestamp/timezone) are deliberately excluded: they
 * vary by tens of bytes at most, while the fields counted here vary by
 * orders of magnitude — the same reason a byte cap beats an entry cap for
 * this memo. Floored at 1: `LruCache.set` throws on `byteSize <= 0`, and a
 * commit with an empty message, no signature and no extra headers is a
 * real, valid object (e.g. `git commit --allow-empty-message`), not an
 * edge case worth special-casing away.
 */
function parsedObjectByteSize(data: {
  readonly message: string;
  readonly gpgSignature?: string;
  readonly extraHeaders: ReadonlyArray<{ readonly key: string; readonly value: string }>;
}): number {
  const extraHeaderBytes = data.extraHeaders.reduce(
    (sum, header) => sum + header.key.length + header.value.length,
    0,
  );
  const signatureBytes = data.gpgSignature?.length ?? 0;
  return Math.max(1, data.message.length + signatureBytes + extraHeaderBytes);
}

export async function resolveObjectBytes(
  ctx: Context,
  registry: PackRegistry,
  id: ObjectId,
  verifyHash: boolean,
  maxBytes?: number,
): Promise<Uint8Array> {
  // An already-aborted read honours the abort before paying any scan I/O.
  checkAborted(ctx);
  // Git dies during object-store setup, ahead of every read — a structurally
  // self-inconsistent multi-pack-index must deny loose reads too, so this
  // gate sits before the empty-tree short-circuit and the deltaCache probe.
  await registry.assertLoadable();
  if (id === emptyTreeOid(ctx.hashConfig)) {
    return EMPTY_TREE_BYTES;
  }
  const cached = ctx.deltaCache.get(id);
  if (cached !== undefined) {
    enforceCachedCap(id, cached, maxBytes);
    return verifyAndReturn(ctx, id, cached, verifyHash);
  }
  const loose = await tryLoose(ctx, id);
  if (loose !== undefined) {
    checkAborted(ctx);
    enforceLooseCap(id, loose, maxBytes);
    cacheEntry(ctx.deltaCache, id, loose);
    return verifyAndReturn(ctx, id, loose, verifyHash);
  }

  checkAborted(ctx);
  const hit = await registry.lookup(id);
  if (hit === undefined) {
    throw objectNotFound(id);
  }
  checkAborted(ctx);
  const bytes = await resolvePackChain(ctx, registry, hit, id, maxBytes);
  checkAborted(ctx);
  return verifyAndReturn(ctx, id, bytes, verifyHash);
}

export async function resolveObject(
  ctx: Context,
  registry: PackRegistry,
  id: ObjectId,
  verifyHash: boolean,
  maxBytes?: number,
): Promise<GitObject> {
  const bytes = await resolveObjectBytes(ctx, registry, id, verifyHash, maxBytes);
  const memo = parsedObjectMemoFor(ctx);
  const memoised = memo?.get(id);
  if (memoised !== undefined) return memoised;
  const parsed = parseObject(id, bytes, ctx.hashConfig);
  if (parsed.type === 'commit' || parsed.type === 'tag') {
    memo?.set(id, parsed, parsedObjectByteSize(parsed.data));
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
    // Probe BEFORE descending: a level cached by an earlier chain (this
    // offset reached as someone else's intermediate) short-circuits the
    // whole rest of the walk exactly as reaching a real base entry would.
    const cached = probeDeltaBaseCache(ctx, registry, currentHit, targetId, maxBytes);
    if (cached !== undefined) {
      return { deltas, baseContent: cached.content, baseType: cached.type, baseOffset: undefined };
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
      };
    }
    depth += 1;
    if (depth > MAX_DELTA_CHAIN_DEPTH) {
      throw deltaChainTooDeep(depth);
    }
    const instructions = await ctx.compressor.inflate(chunk.subarray(headerEndInChunk));
    enforcePackDeltaPreApplyCap(targetId, instructions, maxBytes, depth);

    if (header.type === PACK_ENTRY_TYPE.OFS_DELTA) {
      const baseOffset = ofsDeltaBaseOffset(targetId, currentHit.offset, header.baseDistance);
      deltas.push({ instructions, resolvedBaseId: undefined, offset: currentHit.offset });
      currentHit = { pack: currentHit.pack, offset: baseOffset };
      continue;
    }
    if (header.type === PACK_ENTRY_TYPE.REF_DELTA) {
      const refDeltaBaseId = header.baseId;
      deltas.push({ instructions, resolvedBaseId: refDeltaBaseId, offset: currentHit.offset });
      // Cap propagates into the REF_DELTA base resolution so an oversized
      // base never inflates fully. The cap applies to the BASE object now,
      // not just the delta's target — tightens the OBJECT_TOO_LARGE
      // contract beyond what originally documented.
      const base = await resolveBaseForRefDelta(ctx, registry, refDeltaBaseId, maxBytes);
      return { deltas, baseContent: base.content, baseType: base.type, baseOffset: undefined };
    }
    throw objectNotFound(targetId);
  }
}

/** An OFS_DELTA's base offset is a distance BACK from the entry's own offset
 *  — never forward, and never off the front of the pack. */
function ofsDeltaBaseOffset(targetId: ObjectId, entryOffset: number, baseDistance: number): number {
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
  const phase1 = await collectDeltaChain(ctx, registry, hit, targetId, maxBytes);

  // Apply deltas bottom-up. The REF_DELTA terminator already cached its base
  // (by id) in `resolveBaseForRefDelta`; every OFS/REF level here is cached
  // too, now by (pack, offset) — the fix for the gap the old comment
  // documented: mid-chain intermediates have no known ObjectId, so a REF's
  // own id-keyed cache could only ever hold a chain's tip.
  let current = phase1.baseContent;
  cacheDeltaBase(ctx, registry, hit.pack.name, phase1.baseOffset, phase1.baseType, current);
  for (let i = phase1.deltas.length - 1; i >= 0; i -= 1) {
    const step = phase1.deltas[i];
    if (step === undefined) break;
    current = applyDelta(current, step.instructions);
    cacheDeltaBase(ctx, registry, hit.pack.name, step.offset, phase1.baseType, current);
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

/**
 * fsck's audit Context swaps in a zero-budget `deltaCache`
 * (`createNoDeltaCache()`, `maxSize: 0`) while keeping the same session as
 * the opening Context, so it still shares the ordinary pack registry — a
 * second registry would double the scan and duplicate every persistent pack
 * handle. That means the offset-keyed cache below is reachable through BOTH
 * Contexts even though it is sized once, at registry creation, from
 * whichever Context created it first (almost always the real one, not the
 * audit view). Per-Context disablement can only be honoured by checking
 * THIS call's own budget, so a zero-budget Context never probes or populates
 * it — the store-only guarantee `fsck` needs, not just a memory-budget
 * preference.
 *
 * Exported for `read-head-tree.ts`'s `flatTreeCaches`, which needs the SAME
 * gate for the same reason: a flattened tree is derived from object bytes,
 * and fsck's audit Context shares the session that memo now keys on.
 */
export function deltaBaseCachingEnabled(ctx: Context): boolean {
  return ctx.deltaCache.maxSize > 0;
}

/**
 * The `collectDeltaChain` loop's probe, extracted so the loop body stays
 * flat: a hit enforces the same size cap a freshly-read base entry would,
 * so a warm chain cannot bypass a cap a cold one would have rejected at.
 */
function probeDeltaBaseCache(
  ctx: Context,
  registry: PackRegistry,
  hit: PackLookupHit,
  targetId: ObjectId,
  maxBytes: number | undefined,
): DeltaBaseCacheEntry | undefined {
  if (!deltaBaseCachingEnabled(ctx)) return undefined;
  const cached = registry.deltaBaseCache.get(deltaBaseCacheKey(hit.pack.name, hit.offset));
  if (cached === undefined) return undefined;
  enforcePackBaseCap(targetId, cached.content.length, maxBytes);
  return cached;
}

/** Floors at 1: `LruCache.set` requires a positive `byteSize`, and a
 *  genuinely empty reconstructed intermediate (an empty blob mid-chain) is
 *  still worth caching. */
function deltaBaseCacheEntrySize(content: Uint8Array): number {
  return Math.max(1, content.length);
}

/**
 * Populate one delta-chain level's offset-keyed entry. `offset` is
 * `undefined` for a level that came from a cache hit (already cached) or a
 * REF_DELTA base (resolved by id, not by this pack's offset) — both no-op
 * here rather than re-deriving an offset that doesn't apply.
 */
function cacheDeltaBase(
  ctx: Context,
  registry: PackRegistry,
  packName: string,
  offset: number | undefined,
  type: PackEntryHeader['type'],
  content: Uint8Array,
): void {
  if (offset === undefined || !deltaBaseCachingEnabled(ctx)) return;
  registry.deltaBaseCache.set(
    deltaBaseCacheKey(packName, offset),
    { type, content },
    deltaBaseCacheEntrySize(content),
  );
}
