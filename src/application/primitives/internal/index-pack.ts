/**
 * The pack entry indexer: walks a pack's entries from either an
 * already-resident buffer (`walkPackEntries`) or a quarantined pack file
 * read back from disk in bounded windows (`indexQuarantinedPack`), in two
 * bounded-memory passes. Pass 1 (`scanEntries`) scans every entry once,
 * sequentially, hashing base entries incrementally and recording delta
 * positions into a typed-array store (`./pack-records.js`) — nothing but
 * fixed-width records survives the pass. Pass 2 (`resolveFromRoots`) walks
 * the delta forest root-down from every base entry, resolving each delta
 * against its already-resolved parent's content, held on an explicit stack
 * rather than the JS call stack so depth costs heap, never frames. Split out
 * of `fetch-pack.ts` purely to keep that module under the repo's line
 * ceiling — nothing about the pipeline's observable behaviour changes here.
 */
import { TsgitError } from '../../../domain/error.js';
import { bytesToHex, hexToBytes } from '../../../domain/objects/encoding.js';
import type { ObjectId } from '../../../domain/objects/object-id.js';
import {
  applyDelta,
  type BasePackEntryHeader,
  type BasePackEntryType,
  invalidPackHeader,
  PACK_ENTRY_TYPE,
  type PackEntryHeader,
  type PackEntryType,
  type PackIndexEntries,
} from '../../../domain/storage/index.js';
import { createLruCache, type LruCache } from '../../../domain/storage/lru-cache.js';
import { PACK_HEADER_SIZE } from '../../../domain/storage/pack-entry.js';
import type { Context } from '../../../ports/context.js';
import {
  DISK_WALK_WINDOW_BYTES,
  diskPackByteSource,
  inMemoryPackByteSource,
  type PackByteSource,
} from './pack-byte-source.js';
import { createPackRecordStore, type PackRecordStore } from './pack-records.js';

export { DISK_WALK_WINDOW_BYTES };

/** Threaded through `walkPackEntries`/`indexQuarantinedPack` so a caller —
 *  chiefly this module's own R15 sweep — can force the base cache's budget,
 *  down to disabling it entirely (`0`). `fetchPack` deliberately gains no
 *  such parameter of its own: the receive path always runs at
 *  {@link INDEX_PASS_BASE_CACHE_MAX_BYTES}. */
export interface IndexPackOptions {
  readonly baseCacheMaxBytes?: number;
}

/**
 * Resolves an object referenced by a REF_DELTA whose base is absent from the
 * pack being walked. Used by `bundle verify` to complete thin packs against
 * the local object store. Return `undefined` when the base is not available;
 * the caller will treat the delta as unresolvable.
 */
export type ExternalBaseResolver = (
  baseOid: ObjectId,
) => Promise<
  { readonly type: 'commit' | 'tree' | 'blob' | 'tag'; readonly content: Uint8Array } | undefined
>;

/**
 * Default cap on the entry count declared in the pack header. The 32-bit
 * field is server-controlled; without an explicit ceiling, a malicious server
 * could declare 2^32 entries and drive `walkPackEntries` into a DoS loop even
 * though the pack body itself is bounded by `maxResponseBytes`. Matches the
 * order of magnitude beyond which canonical git refuses to operate. Callers
 * can tighten the limit via `ctx.config?.maxObjectsPerPack`.
 */
const DEFAULT_MAX_OBJECT_COUNT = 50_000_000;

/** Reads the quarantined pack back from disk (it was never resident in
 *  memory during receive) and indexes its entries through
 *  `diskPackByteSource` — the same two-pass `indexPackEntries` core
 *  `walkPackEntries` uses, fed by bounded `readSlice` windows instead of one
 *  whole-pack buffer. Failures here mean the body is malformed even though
 *  its trailer verified, so `onFailure` — the caller's quarantine cleanup —
 *  runs before rethrow. */
export const indexQuarantinedPack = async (
  ctx: Context,
  tmpPath: string,
  totalBytes: number,
  onFailure: (path: string) => Promise<void>,
  options?: IndexPackOptions,
): Promise<PackIndexEntries> => {
  try {
    return await indexPackEntries(
      ctx,
      diskPackByteSource(ctx, tmpPath, totalBytes),
      undefined,
      options,
    );
  } catch (err) {
    await onFailure(tmpPath);
    throw err;
  }
};

interface WalkedEntry {
  readonly id: string;
  readonly crc32: number;
  readonly offset: number;
}

type BaseTypeName = 'commit' | 'tree' | 'blob' | 'tag';

/**
 * Measured — see `docs/spike/index-pass-base-cache-budget.md` for the
 * demand curve, the eight-point sweep and the falsifier verdicts this
 * number is pinned against. The sweep found no clean wall-clock knee on the
 * real-clone fixture (hit rate rises roughly in proportion to budget rather
 * than plateauing), so the honest reading is the smaller, still-justified
 * budget rather than a larger one chasing a speedup the data doesn't
 * clearly back: 8 MiB clears the largest observed base-with-children
 * object (4.76 MiB) with headroom, is neither a fraction of nor equal to
 * `ctx.deltaCache`'s own budget, and gives a real, if modest, measured
 * benefit. This cache is transient (one index pass), on the write path,
 * with a hit pattern that resembles neither the read-path delta-base
 * cache's nor the parsed-object memo's.
 */
export const INDEX_PASS_BASE_CACHE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Entry-count ceiling, independent of the byte budget: a byte cap alone
 * undercounts a typical entry's real retained cost, so a pack crafted with
 * many tiny base objects could otherwise hold far more LIVE entries than
 * {@link INDEX_PASS_BASE_CACHE_ENTRY_OVERHEAD_BYTES} alone models — the
 * same failure mode the sibling read-path caches guard against with their
 * own entry caps (`FLAT_TREE_CACHE_MAX_ENTRIES`, `PARSED_OBJECT_MEMO_MAX_ENTRIES`),
 * at their same 65 536.
 *
 * Sized against measurement, not a smaller "just big enough" guess: pass 1
 * offers EVERY base entry to the cache, not only the ones that turn out to
 * have children (it cannot know which until the whole pack is scanned), so
 * the count this cap must clear is the pack's TOTAL base-object count, not
 * the smaller base-with-children count the byte budget is sized against. A
 * real clone of this repository (15 270 objects) carries 4 794 base
 * objects — comfortably under 65 536, with headroom for repositories
 * several times larger, while a pack crafted with tens of thousands of
 * near-zero-length base objects — cheap in bytes, expensive in per-entry
 * LRU/V8 overhead — still gets bounded. A smaller cap measured against
 * only the with-children count was tried first and evicted real,
 * still-needed roots on that same fixture purely from entry-count
 * pressure, at a budget far under the byte ceiling — the exact failure
 * mode this cap exists to prevent, discovered by measuring the real
 * fixture rather than assuming the byte budget alone would bind first.
 */
export const INDEX_PASS_BASE_CACHE_MAX_ENTRIES = 65_536;

/**
 * Fixed per-entry overhead the raw content length alone doesn't account
 * for: the `o:<passId>:<offset>` / `x:<oid>` key string, the LRU's own node
 * object, and the `CachedBase` wrapper — mirrors the read-path delta-base
 * cache's own overhead constant. Its presence alone keeps
 * {@link cachedBaseByteSize}'s result positive — `LruCache.set` requires
 * `byteSize > 0`, and a genuinely zero-length base object (an empty blob)
 * or a cached "base not found" result is still worth caching — so no
 * separate floor is needed on top of it.
 */
const INDEX_PASS_BASE_CACHE_ENTRY_OVERHEAD_BYTES = 200;

/**
 * One cache entry: either a resolved base's type and content, or the
 * recorded fact that an external base lookup came back empty. The `found`
 * discriminant — never a bare `undefined` value inside the cache — is what
 * lets a `get()` miss (`undefined`, "not cached") stay unambiguous from a
 * cached absence (`{ found: false }`, "looked up, and it's genuinely not
 * there"): the same distinction the deleted `bundle-verify.ts` `Map` drew
 * with `has()` before `get()`, restated so a single `get()` is enough here.
 */
type CachedBase =
  | { readonly found: true; readonly type: BaseTypeName; readonly content: Uint8Array }
  | { readonly found: false };

const cachedBaseByteSize = (entry: CachedBase): number =>
  (entry.found ? entry.content.byteLength : 0) + INDEX_PASS_BASE_CACHE_ENTRY_OVERHEAD_BYTES;

/**
 * One byte-capped LRU per session (never per `Context` identity — a `pull`
 * derives a Context between its fetch and its merge, and identity-keyed
 * caches have been silently dropped by exactly that before), serving both
 * pass-1→pass-2 carry-over of in-pack bases and externally-resolved
 * thin-pack bases. `passId` is a per-session invocation counter, bumped
 * once per `indexPackEntries` call, so two index passes sharing a session
 * never collide on a raw pack offset (see {@link inPackCacheKey}).
 *
 * Deliberately NOT gated by the read-path caches' enablement check: that
 * gate exists so fsck's zero-budget audit Context cannot poison a memo it
 * shares a session with the opening Context on. This cache is on the write
 * path, sized by its own `IndexPackOptions.baseCacheMaxBytes`/
 * {@link INDEX_PASS_BASE_CACHE_MAX_BYTES} independently of `ctx.deltaCache`,
 * and has no fsck-audit counterpart to protect against.
 */
interface BaseCacheSlot {
  readonly cache: LruCache<CachedBase>;
  passId: number;
}

const baseCacheSlots = new WeakMap<Context['session'], BaseCacheSlot>();

const baseCacheSlotFor = (ctx: Context, maxBytes: number): BaseCacheSlot => {
  const existing = baseCacheSlots.get(ctx.session);
  if (existing !== undefined) return existing;
  const created: BaseCacheSlot = {
    cache: createLruCache<CachedBase>(maxBytes, INDEX_PASS_BASE_CACHE_MAX_ENTRIES),
    passId: 0,
  };
  baseCacheSlots.set(ctx.session, created);
  return created;
};

/** In-pack bases key on their pass-scoped offset — `passId` keeps two
 *  index passes sharing a session from reading each other's bases when
 *  their packs happen to place a base at the same raw offset. */
const inPackCacheKey = (passId: number, offset: number): string => `o:${passId}:${offset}`;

/** External bases key on their oid alone: an oid is already globally
 *  unique within the repository, unlike a raw pack offset. */
const externalCacheKey = (oid: ObjectId): string => `x:${oid}`;

/** Minimum bytes one pack entry can occupy: one type/size byte plus the
 *  8-byte zlib stream of an empty payload. Bounds the record store's growth
 *  independently of whatever `header.objectCount` claims — a pack of
 *  `totalBytes` bytes cannot hold more than
 *  `(totalBytes - PACK_HEADER_SIZE - digestLength) / MIN_PACK_ENTRY_BYTES`
 *  real entries, regardless of what its header declares, so this clamp
 *  underneath the store's own geometric growth is what keeps a lying
 *  header from sizing an allocation. */
const MIN_PACK_ENTRY_BYTES = 9;

const structuralMaxEntries = (totalBytes: number, digestLength: number): number =>
  Math.max(0, Math.floor((totalBytes - PACK_HEADER_SIZE - digestLength) / MIN_PACK_ENTRY_BYTES));

/** Whether a raw stored `PackEntryType` byte names a base (non-delta) entry
 *  — the pass-2 counterpart to `isBaseHeader` below, operating on the
 *  record store's own `typeOf(ordinal)` rather than a freshly parsed
 *  `PackEntryHeader`. */
const isBaseType = (type: PackEntryType): type is BasePackEntryType =>
  type === PACK_ENTRY_TYPE.COMMIT ||
  type === PACK_ENTRY_TYPE.TREE ||
  type === PACK_ENTRY_TYPE.BLOB ||
  type === PACK_ENTRY_TYPE.TAG;

/**
 * Pass 1 — sequential scan, retain nothing. Walks every entry once, in
 * strictly increasing offset order, inflating it to learn where the next
 * entry starts (`bytesConsumed`, counted from `dataOffset` — a pack stores
 * no entry lengths). A base entry's oid is hashed incrementally
 * (`ctx.hash.createHasher()`) and its inflated payload dropped immediately
 * after; a delta entry's base position (OFS) or base id (REF) is recorded
 * in the record store and its payload dropped without ever being applied.
 * Peak residency during this pass is one entry's inflated payload plus the
 * read window — nothing else survives the loop.
 */
const scanEntries = async <TCrcContext>(
  ctx: Context,
  source: PackByteSource<TCrcContext>,
  cache: LruCache<CachedBase>,
  passId: number,
): Promise<PackRecordStore> => {
  const header = await source.header();
  const objectCountCap = ctx.config?.maxObjectsPerPack ?? DEFAULT_MAX_OBJECT_COUNT;
  if (header.objectCount > objectCountCap) {
    throw new TsgitError({
      code: 'PACK_TOO_LARGE',
      objectCount: header.objectCount,
      limit: objectCountCap,
    });
  }
  const trailerStart = source.totalBytes - ctx.hash.digestLength;
  const store = createPackRecordStore(
    ctx.hash.digestLength,
    structuralMaxEntries(source.totalBytes, ctx.hash.digestLength),
  );
  let offset = PACK_HEADER_SIZE;
  for (let i = 0; i < header.objectCount; i += 1) {
    const entryHeader = await source.entryHeader(offset);
    const inflated = await source.inflateEntry(offset, entryHeader.dataOffset, entryHeader.size);
    const entryEnd = entryHeader.dataOffset + inflated.result.bytesConsumed;
    // Defence-in-depth guard. The trailer is always verified before either
    // byte source above is ever walked — `verifyPackTrailer` for an
    // in-memory buffer (`bundle-verify.ts`), `receivePackToQuarantine`'s
    // incremental hash for the quarantine file — so the final
    // `digestLength` bytes are fixed as `sha(body)` by the time this runs;
    // `streamInflate` reports the minimal valid zlib-stream length. An
    // entry whose stream consumed bytes past `trailerStart` would require
    // those SHA bytes to also be a valid zlib continuation — unreachable
    // for any verifiable pack.
    // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent — `entryEnd > trailerStart` is unreachable once the trailer has been accepted; the throw cannot fire. Restated against this scan's own loop — the pipeline this replaced made the identical argument at the identical point in an otherwise identical scan.
    if (entryEnd > trailerStart) {
      // Stryker disable next-line StringLiteral: equivalent — the guarded throw is unreachable (see above), so its message is never observed.
      throw invalidPackHeader('entry extends past pack trailer');
    }
    const entryCrc = await source.entryCrc32(offset, entryEnd, inflated.crcContext);
    const ordinal = store.append(offset, entryCrc, entryHeader.type);
    if (isBaseHeader(entryHeader)) {
      const typeName = baseTypeName(entryHeader.type);
      store.setOid(ordinal, await hashObject(ctx, typeName, inflated.result.output));
      // A base entry is resolved the moment its oid is known — pass 2 never
      // revisits this flag for it, only for the deltas that chain off it.
      store.markResolved(ordinal);
      // Carried into pass 2: every base entry is offered to the cache here,
      // not only the ones that turn out to have children — pass 1 cannot
      // yet know which those are, since the child index is only built once
      // the whole scan (and every OFS/REF record) is in. A base without
      // children is simply never looked up again in pass 2, so caching it
      // costs nothing but a slot this same LRU is free to evict first.
      const cached: CachedBase = { found: true, type: typeName, content: inflated.result.output };
      cache.set(inPackCacheKey(passId, offset), cached, cachedBaseByteSize(cached));
    } else if (entryHeader.type === PACK_ENTRY_TYPE.OFS_DELTA) {
      // `recordOfsDelta` applies the widened out-of-bound guard: a distance
      // landing before the pack body OR at/after the entry's own offset
      // (including the self-referential distance-0 case) refuses here with
      // git's own reason. A distance that lands in range but not on a real
      // entry boundary is not caught here — it stays an unresolved-delta
      // count, the same split git makes.
      store.recordOfsDelta(ordinal, offset - entryHeader.baseDistance);
    } else {
      store.recordRefDelta(ordinal, hexToBytes(entryHeader.baseId));
    }
    offset = entryEnd;
  }
  if (offset !== trailerStart) {
    throw invalidPackHeader('extra bytes between last entry and trailer');
  }
  store.buildChildIndexes();
  return store;
};

/** One frame of pass 2's explicit stack: a resolved parent's content, held
 *  only while it still has children left to resolve. `cursor` is the
 *  "children remaining" counter, counting UP against `children.length`
 *  rather than down — equivalent, and simpler to pair with a plain array.
 *  The frame — and with it the only remaining reference to `content` — is
 *  popped the instant `cursor` reaches `children.length`: the load-bearing
 *  release the memory bound depends on (a linear chain then retains two
 *  objects at a time regardless of depth; only a branching subtree retains
 *  more, and only for as long as it still has unresolved children). */
interface WalkFrame {
  readonly content: Uint8Array;
  readonly typeName: BaseTypeName;
  readonly children: ReadonlyArray<number>;
  cursor: number;
}

/** Every entry ordinal chained onto `offset` (OFS) or `oidBytes` (REF),
 *  merged into one plain array via a loop — never `push(...spread)`, which
 *  overflows the call stack near 125k arguments and a real clone's delta
 *  forest can exceed. */
const collectChildren = (
  store: PackRecordStore,
  offset: number,
  oidBytes: Uint8Array,
): number[] => {
  const children: number[] = [];
  const ofsRange = store.ofsChildren(offset);
  for (let p = ofsRange.start; p < ofsRange.end; p += 1) {
    children.push(store.ofsChildOrdinalAt(p));
  }
  const refRange = store.refChildren(oidBytes);
  for (let p = refRange.start; p < refRange.end; p += 1) {
    children.push(store.refChildOrdinalAt(p));
  }
  return children;
};

/**
 * Depth-first walk of one forest root's subtree via an explicit stack —
 * never recursion, since depth is uncapped (git itself accepts chains a
 * thousand deep) and must cost heap, not JS call frames. The `isResolved`
 * check below is not defensive padding: a pack may legally carry the same
 * oid twice (git's default fetch accepts it, `transfer.fsckObjects`
 * defaulting false), which makes a REF delta keyed on that oid a child of
 * two parents; without the check it would be applied twice and
 * `resolvedCount` would overshoot `objectCount`, turning the unresolved
 * count into nonsense.
 */
const walkFromRoot = async <TCrcContext>(
  ctx: Context,
  source: PackByteSource<TCrcContext>,
  store: PackRecordStore,
  rootContent: Uint8Array,
  typeName: BaseTypeName,
  rootChildren: ReadonlyArray<number>,
): Promise<void> => {
  const stack: WalkFrame[] = [
    { content: rootContent, typeName, children: rootChildren, cursor: 0 },
  ];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.cursor >= frame.children.length) {
      stack.pop();
      continue;
    }
    const childOrdinal = frame.children[frame.cursor]!;
    frame.cursor += 1;
    if (store.isResolved(childOrdinal)) continue;
    const childOffset = store.offsetOf(childOrdinal);
    const childHeader = await source.entryHeader(childOffset);
    const inflated = await source.inflateEntry(
      childOffset,
      childHeader.dataOffset,
      childHeader.size,
    );
    const childContent = applyDelta(frame.content, inflated.result.output);
    const oidBytes = await hashObject(ctx, frame.typeName, childContent);
    store.setOid(childOrdinal, oidBytes);
    store.markResolved(childOrdinal);
    const grandchildren = collectChildren(store, childOffset, oidBytes);
    stack.push({
      content: childContent,
      typeName: frame.typeName,
      children: grandchildren,
      cursor: 0,
    });
  }
};

/** A root's content, from the base cache when pass 1 carried it forward and
 *  budget still holds it, or freshly re-inflated from `source` otherwise —
 *  the one piece of re-work the cache exists to remove. A miss here is
 *  never wrong, only slower: the root's oid is already known from pass 1
 *  either way, so a re-read reconstructs identical content. */
const rootContentOf = async <TCrcContext>(
  source: PackByteSource<TCrcContext>,
  cache: LruCache<CachedBase>,
  passId: number,
  offset: number,
): Promise<Uint8Array> => {
  const cached = cache.get(inPackCacheKey(passId, offset));
  if (cached?.found === true) return cached.content;
  const header = await source.entryHeader(offset);
  const inflated = await source.inflateEntry(offset, header.dataOffset, header.size);
  return inflated.result.output;
};

/**
 * Pass 2 — resolve from the roots down. Every base-typed entry is a forest
 * root, visited in increasing offset order (the store's own append order,
 * since pass 1 appends strictly forward) so root reads stay sequential;
 * child reads jump around, which is unavoidable — the forest's shape is the
 * server's choice. A root with no children is never re-inflated at all: its
 * oid is already known from pass 1, and content is only ever needed to
 * resolve children.
 */
const resolveFromRoots = async <TCrcContext>(
  ctx: Context,
  source: PackByteSource<TCrcContext>,
  store: PackRecordStore,
  cache: LruCache<CachedBase>,
  passId: number,
): Promise<void> => {
  const { oids } = store.view();
  for (let ordinal = 0; ordinal < store.count; ordinal += 1) {
    const type = store.typeOf(ordinal);
    if (!isBaseType(type)) continue;
    const offset = store.offsetOf(ordinal);
    const oidRange = store.oidRangeOf(ordinal);
    const oidBytes = oids.subarray(oidRange.start, oidRange.end);
    const children = collectChildren(store, offset, oidBytes);
    if (children.length === 0) continue;
    const rootContent = await rootContentOf(source, cache, passId, offset);
    await walkFromRoot(ctx, source, store, rootContent, baseTypeName(type), children);
  }
};

/**
 * Thin-pack completion: after the in-pack walk, every REF delta still
 * unresolved is offered — in the order pass 1 recorded it — to
 * `externalBaseResolver`. A resolved external base becomes an extra forest
 * root exactly like an in-pack one: `walkFromRoot` resolves the orphaned
 * delta itself against it, then descends into whatever chains onto that
 * delta's own offset or oid, so a multi-entry thin chain hanging off one
 * missing base resolves in a single sweep regardless of which entry in the
 * chain happens to be recorded first. `applyDelta`'s own base-length guard
 * refuses a wrong-sized external base rather than reconstructing garbage.
 */
/** Resolves one external base through the shared cache: a cache hit (found
 *  OR previously-recorded-absent) skips `externalBaseResolver` entirely;
 *  a miss calls it once and records whichever answer it gives, so a repeat
 *  lookup for the same absent oid still answers `{ found: false }` rather
 *  than re-invoking the resolver — the behaviour the deleted `bundle-verify`
 *  `Map` gave via its own `has()`-before-`get()` memo. */
const resolveExternalCached = async (
  cache: LruCache<CachedBase>,
  baseOid: ObjectId,
  externalBaseResolver: ExternalBaseResolver,
): Promise<CachedBase> => {
  const key = externalCacheKey(baseOid);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const resolved = await externalBaseResolver(baseOid);
  const entry: CachedBase =
    resolved === undefined ? { found: false } : { found: true, ...resolved };
  cache.set(key, entry, cachedBaseByteSize(entry));
  return entry;
};

const resolveExternalBases = async <TCrcContext>(
  ctx: Context,
  source: PackByteSource<TCrcContext>,
  store: PackRecordStore,
  externalBaseResolver: ExternalBaseResolver,
  cache: LruCache<CachedBase>,
): Promise<void> => {
  for (let r = 0; r < store.refDeltaCount; r += 1) {
    const ordinal = store.refDeltaOrdinalAt(r);
    if (store.isResolved(ordinal)) continue;
    const baseOid = bytesToHex(store.refDeltaBaseOidAt(r)) as ObjectId;
    const external = await resolveExternalCached(cache, baseOid, externalBaseResolver);
    if (!external.found) continue;
    const offset = store.offsetOf(ordinal);
    const header = await source.entryHeader(offset);
    const inflated = await source.inflateEntry(offset, header.dataOffset, header.size);
    const content = applyDelta(external.content, inflated.result.output);
    const oidBytes = await hashObject(ctx, external.type, content);
    store.setOid(ordinal, oidBytes);
    store.markResolved(ordinal);
    const children = collectChildren(store, offset, oidBytes);
    if (children.length > 0) {
      await walkFromRoot(ctx, source, store, content, external.type, children);
    }
  }
};

/**
 * Module-private core: both passes over one `PackByteSource`, then the
 * refusal check. After the walk (and, when given a resolver, the thin-pack
 * sweep), `resolvedCount < objectCount` means some delta was never
 * reachable — a REF cycle, an all-deltas pack with no base entry, or an OFS
 * base offset landing mid-entry (three cases that converge here, exactly as
 * they do in git). The refusal is git's own count, singular at one, under
 * the unchanged `INVALID_PACK_HEADER` code.
 *
 * The base cache's slot is looked up once per call and its byte budget is
 * never retained past this one pass, success or failure: `finally` clears
 * it unconditionally, even when clearing wipes entries a DIFFERENT,
 * still-in-flight pass sharing this session populated — safe because
 * dropping a live entry only ever costs that other pass a re-read, never a
 * different result (R15 pins the equivalence this relies on).
 */
const indexPackEntries = async <TCrcContext>(
  ctx: Context,
  source: PackByteSource<TCrcContext>,
  externalBaseResolver?: ExternalBaseResolver,
  options?: IndexPackOptions,
): Promise<PackIndexEntries> => {
  const slot = baseCacheSlotFor(ctx, options?.baseCacheMaxBytes ?? INDEX_PASS_BASE_CACHE_MAX_BYTES);
  const passId = slot.passId;
  slot.passId += 1;
  try {
    const store = await scanEntries(ctx, source, slot.cache, passId);
    await resolveFromRoots(ctx, source, store, slot.cache, passId);
    if (externalBaseResolver !== undefined && store.resolvedCount < store.count) {
      await resolveExternalBases(ctx, source, store, externalBaseResolver, slot.cache);
    }
    const unresolvedCount = store.count - store.resolvedCount;
    if (unresolvedCount > 0) {
      throw invalidPackHeader(
        `pack has ${unresolvedCount} unresolved delta${unresolvedCount === 1 ? '' : 's'}`,
      );
    }
    return store.view();
  } finally {
    slot.cache.clear();
  }
};

export const walkPackEntries = async (
  ctx: Context,
  packBytes: Uint8Array,
  externalBaseResolver?: ExternalBaseResolver,
  options?: IndexPackOptions,
): Promise<ReadonlyArray<WalkedEntry>> => {
  const entries = await indexPackEntries(
    ctx,
    inMemoryPackByteSource(ctx, packBytes),
    externalBaseResolver,
    options,
  );
  const walked: WalkedEntry[] = [];
  for (let i = 0; i < entries.count; i += 1) {
    const start = i * entries.digestLength;
    const end = start + entries.digestLength;
    walked.push({
      id: bytesToHex(entries.oids.subarray(start, end)),
      // `crcValues` is a signed `Int32Array` (the `.idx`/`.rev` byte-level
      // shape); `crc32()` and this module's own `WalkedEntry` contract are
      // unsigned, so the bit pattern is reinterpreted back on the way out.
      crc32: (entries.crcValues[i] ?? 0) >>> 0,
      offset: entries.offsets[i] ?? 0,
    });
  }
  return walked;
};

const isBaseHeader = (header: PackEntryHeader): header is BasePackEntryHeader => {
  return (
    header.type === PACK_ENTRY_TYPE.COMMIT ||
    header.type === PACK_ENTRY_TYPE.TREE ||
    header.type === PACK_ENTRY_TYPE.BLOB ||
    header.type === PACK_ENTRY_TYPE.TAG
  );
};

const baseTypeName = (type: BasePackEntryHeader['type']): BaseTypeName => {
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
};

const TEXT_ENCODER = new TextEncoder();

/**
 * Computes an object's oid incrementally: `ctx.hash.createHasher()` fed the
 * loose header then the content, never a second concatenated copy the way
 * the deleted `computeLooseObjectId` used to build purely to hand
 * `ctx.hash.hashHex` one buffer. Node's `createHasher()` wraps
 * `crypto.createHash` and streams genuinely; the memory and browser adapters
 * collect chunks and concatenate at `digest()` time (no streaming digest in
 * SubtleCrypto), so this is a clear win on Node and exactly neutral
 * elsewhere — it never regresses.
 */
const hashObject = async (
  ctx: Context,
  typeName: BaseTypeName,
  content: Uint8Array,
): Promise<Uint8Array> => {
  const headerBytes = TEXT_ENCODER.encode(`${typeName} ${content.length}\0`);
  const hasher = ctx.hash.createHasher();
  hasher.update(headerBytes);
  hasher.update(content);
  return hexToBytes(await hasher.digestHex());
};
