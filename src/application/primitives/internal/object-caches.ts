/**
 * Object-resolver caches — extracted from `object-resolver.ts` to keep that
 * file's role scoped to the resolve pipeline. Owns the parsed-commit/tag
 * memo (`parsedObjectMemoFor`/`forgetParsedObjectMemo`) and the offset-keyed
 * delta-base cache (`probeDeltaBaseCache`/`cacheDeltaBase`) that
 * `object-resolver.ts`'s `resolveObject`/`collectDeltaChain`/`resolvePackChain`
 * consult. `read-head-tree.ts`'s `flatTreeCaches` also shares
 * {@link deltaBaseCachingEnabled}'s enablement gate — see that function's doc.
 */
import { objectTooLarge } from '../../../domain/objects/error.js';
import type { Commit, ObjectId, Tag } from '../../../domain/objects/index.js';
import {
  createLruCache,
  type LruCache,
  type PackEntryHeader,
} from '../../../domain/storage/index.js';
import type { Context } from '../../../ports/context.js';
import type { DeltaBaseCacheEntry, PackRegistry } from '../pack-registry.js';

/**
 * Parsed-commit-and-tag memo. `resolveObject` re-parses on every read
 * even when `resolveObjectContentWithDepth` already served the content from
 * `ctx.deltaCache` — the memo skips that redundant re-parse for the two
 * object types whose parse cost is non-trivial (blob/tree already return
 * near-raw data from `parseObjectContent`). It sits strictly AFTER
 * `resolveObjectContentWithDepth`, so every verifyHash/maxBytes check that call already
 * performs still fires on every read: the memo only ever skips
 * reconstructing an object the bytes already proved identical, never a
 * safety check.
 *
 * Keyed on `ctx.session` — not `ctx` itself — so the memo survives every
 * spread-derivation this codebase does (a worktree Context,
 * `listWorktrees`'s per-worktree Contexts, …), sharing one memo per
 * repository instead of missing on every fresh spread. A submodule Context
 * is NOT one of these: its common dir genuinely differs (a different
 * repository), so `deriveContext` mints it a fresh session and this memo
 * starts cold, exactly as intended.
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
 * The parsed-object memo is bound in the unit its consumer scales with —
 * entries, because a walk of N commits needs N slots — not in bytes. A byte
 * cap alone binds far too early: at a 1/16-of-16MiB share with a 256 B fixed
 * overhead per entry, the cap bound at ≤ 4,096 entries, so a 5,000-commit
 * walk in the same order every time (the worst case an LRU has) collapsed to
 * roughly 0% hits. The module's own fraction sweep — 1/16 vs 1/8 vs 1/4 of
 * the medium fixture's 16 MiB default — measured no difference between
 * fractions, because that fixture's walk was entirely on the wrong side of
 * the cliff already: any of the three fractions capped at a few thousand
 * entries against a 5,000-commit walk. See the medium-fixture A/B in
 * `log.bench` for the corrected before/after numbers.
 *
 * The byte cap becomes a *valve* instead: it is `ctx.deltaCache`'s own
 * budget (not a fraction of it) plus a width surcharge, sized so it only
 * ever binds for atypical entries — a signed/mergetag-heavy commit, an
 * octopus merge — never for a typical one. This valve and
 * {@link memoMaxEntries}'s default entry count both derive independently
 * from the dial (`ctx.deltaCache.maxSize`), which is what keeps the
 * ordering (entries bind, bytes rarely do) structural at every
 * `deltaCacheMaxBytes` dial and every hash width: a 4 MiB browser tab still
 * gets `entries × typicalEntryBytes(width) ≤ valve`.
 */
export const memoByteValve = (ctx: Context): number =>
  defaultMemoEntries(ctx) * typicalEntryBytes(ctx);

/**
 * Measured retained cost of one typical memo entry (one parent, a 216-byte
 * message), sha1 width: `process.memoryUsage().heapUsed` deltas after six
 * forced collections, 20,000 parsed commits/tags retained in
 * `createLruCache`, sampled twice with identical results. `950 (fixed) + 216
 * (message) + 40 (one sha1 parent) = 1,206` — a message-and-parents-only
 * sizer under-states this shape 2.34×. `maxEntries × typicalEntryBytes(width)`
 * is what the byte valve must admit at every `deltaCacheMaxBytes` dial — the
 * invariant a unit test pins so a future retune that flips the binding
 * constraint fails a test instead of shipping another dead cache.
 */
export const PARSED_OBJECT_TYPICAL_ENTRY_BYTES = 1206;

/** A sha256 oid (64 hex chars) costs this many bytes more per entry than sha1's (40). */
const SHA1_HEX_LENGTH = 40;

const oidWidthSurcharge = (ctx: Context): number => ctx.hashConfig.hexLength - SHA1_HEX_LENGTH;

const typicalEntryBytes = (ctx: Context): number =>
  PARSED_OBJECT_TYPICAL_ENTRY_BYTES + oidWidthSurcharge(ctx);

/**
 * Dial bytes charged per default memo entry — deliberately NOT
 * {@link PARSED_OBJECT_TYPICAL_ENTRY_BYTES}: this fixes the default entry
 * COUNT at `floor(dial / 512)` (32,768 at the 16 MiB default), the workload
 * the memo was originally sized for, while the honest per-entry cost above
 * prices what the valve must admit for that same count. Decoupling the two
 * is what lets the valve grow to its measured, honest size without
 * shrinking how many typical commits the default dial admits.
 */
export const PARSED_OBJECT_DIAL_BYTES_PER_ENTRY = 512;

/** The dial-derived entry count — the valve's reference, independent of an explicit entry option. */
const defaultMemoEntries = (ctx: Context): number =>
  Math.floor(ctx.deltaCache.maxSize / PARSED_OBJECT_DIAL_BYTES_PER_ENTRY);

/**
 * Entry-count cap for the parsed-object memo — a caller-supplied
 * `cacheBudgets.parsedObjectMemoMaxEntries` always wins; otherwise derived
 * from the dial (`ctx.deltaCache.maxSize`) so it tracks that budget at every
 * dial (32,768 at the 16 MiB default). A second FIXED cap here (as this
 * module used to carry) would either never bind — once the valve moved off
 * the wrong fraction — or silently re-create the exact cliff this sizing
 * exists to remove, so none is layered on top.
 */
export const memoMaxEntries = (ctx: Context): number =>
  ctx.cacheBudgets?.parsedObjectMemoMaxEntries ?? defaultMemoEntries(ctx);

/**
 * Base share of `ctx.deltaCache`'s own byte budget the FlatTree cache gets
 * by default — 8 MiB at the 16 MiB default dial. {@link defaultFlatTreeValve}
 * adds a width surcharge on top of this share so the same
 * ~50,000-tracked-file reference workload is admitted at every hash width,
 * not just sha1: a 64-hex oid costs 24 bytes more per entry than a 40-hex
 * one, and without the surcharge the same share only ever admitted ~44,600
 * sha256 files.
 */
const FLAT_TREE_DEFAULT_SHARE = 0.5;

/** Tracked files the FlatTree default admits per 16 MiB of dial, at every hash width. */
const FLAT_TREE_REFERENCE_FILES = 50_000;
const REFERENCE_DIAL_BYTES = 16 * 1024 * 1024;

/**
 * Default FlatTree byte valve: the base share of the dial plus a width
 * surcharge for the dial-scaled reference file count, so the same
 * reference workload (proportional to `ctx.deltaCache.maxSize`) is admitted
 * at every hash width — see {@link FLAT_TREE_DEFAULT_SHARE}.
 */
const defaultFlatTreeValve = (ctx: Context): number => {
  const dial = ctx.deltaCache.maxSize;
  const files = Math.floor((FLAT_TREE_REFERENCE_FILES * dial) / REFERENCE_DIAL_BYTES);
  return dial * FLAT_TREE_DEFAULT_SHARE + files * oidWidthSurcharge(ctx);
};

/**
 * The two synchronous derived-cache budgets, resolved together — the
 * parsed-object memo's entry cap and the FlatTree's own byte valve — shaped
 * on the existing `concurrency?`/`limitFor` house pattern: an explicit
 * `ctx.cacheBudgets` member always wins, otherwise the default derives from
 * `ctx.deltaCache`'s own budget. `read-head-tree.ts` imports this rather
 * than re-deriving its own share of `ctx.deltaCache.maxSize`.
 */
export interface ResolvedCacheBudgets {
  readonly parsedObjectMemoMaxEntries: number;
  readonly flatTreeCacheMaxBytes: number;
}

export const budgetsFor = (ctx: Context): ResolvedCacheBudgets => ({
  parsedObjectMemoMaxEntries: memoMaxEntries(ctx),
  flatTreeCacheMaxBytes: ctx.cacheBudgets?.flatTreeCacheMaxBytes ?? defaultFlatTreeValve(ctx),
});

export function parsedObjectMemoFor(ctx: Context): LruCache<MemoisedObject> | undefined {
  if (!deltaBaseCachingEnabled(ctx)) return undefined;
  const existing = parsedObjectMemos.get(ctx.session);
  if (existing !== undefined) return existing;
  const created = createLruCache<MemoisedObject>(memoByteValve(ctx), memoMaxEntries(ctx));
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
 * Fixed overhead per cached entry: the `Commit`/`Tag` and `CommitData`/
 * `TagData` wrapper objects, the entry's own oid and tree/target oid, two
 * identity blocks worth of name/email/timestamp/timezone (a commit's
 * author+committer; a tag's single tagger fits comfortably inside the same
 * budget), and the LRU node plus `Map` entry that hold the cached value.
 * Measured (see {@link PARSED_OBJECT_TYPICAL_ENTRY_BYTES}) rather than
 * estimated from field widths — an estimate undercounted a short-message,
 * unsigned, parentless commit by more than 3×.
 */
const PARSED_OBJECT_FIXED_OVERHEAD_BYTES = 950;

/**
 * Approximate retained footprint of a parsed commit/tag: the sum of its
 * unbounded-length fields — the message, an armored gpg/ssh signature, any
 * extra header's key+value (a `mergetag` header can embed a whole nested tag
 * object), and every parent oid (unbounded for an octopus merge) — plus
 * {@link PARSED_OBJECT_FIXED_OVERHEAD_BYTES} for the fields that vary too
 * little to be worth measuring individually. The fixed term alone is always
 * positive, so — unlike a message-only sizer — this can never compute to a
 * non-positive size; `LruCache.set`'s `byteSize <= 0` guard is unreachable
 * from here by construction, not by a floor this function adds itself.
 *
 * `hexLength` is the active hash algorithm's hex oid width (40 for SHA-1, 64
 * for SHA-256) — parent oids are counted at their real on-disk width, not a
 * SHA-1-shaped assumption.
 */
export function parsedObjectByteSize(
  data: {
    readonly message: string;
    readonly gpgSignature?: string;
    readonly extraHeaders: ReadonlyArray<{ readonly key: string; readonly value: string }>;
    readonly parents?: ReadonlyArray<ObjectId>;
  },
  hexLength: number,
): number {
  const extraHeaderBytes = data.extraHeaders.reduce(
    (sum, header) => sum + header.key.length + header.value.length,
    0,
  );
  const signatureBytes = data.gpgSignature?.length ?? 0;
  const parentsBytes = (data.parents?.length ?? 0) * hexLength;
  return (
    data.message.length +
    signatureBytes +
    extraHeaderBytes +
    parentsBytes +
    PARSED_OBJECT_FIXED_OVERHEAD_BYTES
  );
}

/**
 * Pre-inflate cap for pack base entries — fires at ANY depth, not just
 * `depth === 0`. The cap exists to bound memory: when the chain walker
 * reaches a base entry whose declared inflated size exceeds the cap, the
 * subsequent `inflate` materialises a buffer larger than the
 * contract permits regardless of whether the final delta-applied result
 * shrinks below the cap.
 *
 * Lives here (not `object-resolver.ts`) because {@link probeDeltaBaseCache}
 * needs it too — `object-resolver.ts`'s own `collectDeltaChain` calls it
 * directly for a freshly-read base entry, the same check a delta-base cache
 * hit below must pass.
 */
export function enforcePackBaseCap(
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
 * Takes the already-built key rather than `(packName, offset)` — the
 * caller needs that same key again if this probe misses and the level goes
 * on to become a `DeltaStep` (see `DeltaStep.probeKey`), so it is built once
 * and passed in rather than rebuilt here.
 */
export function probeDeltaBaseCache(
  ctx: Context,
  registry: PackRegistry,
  key: string,
  targetId: ObjectId,
  maxBytes: number | undefined,
): DeltaBaseCacheEntry | undefined {
  if (!deltaBaseCachingEnabled(ctx)) return undefined;
  const cached = registry.deltaBaseCache.get(key);
  if (cached === undefined) return undefined;
  enforcePackBaseCap(targetId, cached.content.length, maxBytes);
  return cached;
}

/**
 * Fixed per-entry overhead the raw content length alone doesn't account for:
 * the `${packName}:${offset}` key string, the LRU's own node object, and the
 * `{ type, content, chainDepth }` wrapper. Its presence alone keeps the
 * result positive — `LruCache.set` requires a positive `byteSize`, and a
 * genuinely empty reconstructed intermediate (an empty blob mid-chain) is
 * still worth caching — so no separate floor is needed on top of it.
 */
const DELTA_BASE_CACHE_ENTRY_OVERHEAD_BYTES = 200;

export function deltaBaseCacheEntrySize(content: Uint8Array): number {
  return content.length + DELTA_BASE_CACHE_ENTRY_OVERHEAD_BYTES;
}

/**
 * Fraction of the delta-base cache's whole budget one chain read may insert.
 * Reading a single deeply-deltified object would otherwise push one full
 * intermediate per chain level through the cache, evicting entries a
 * shallower, more-repeated read would have kept. Kept as a fraction of
 * `registry.deltaBaseCache.maxSize` — not an absolute — so the chain budget
 * scales with whatever the cache itself is configured to hold. Strictly
 * below 1 so a single insert can never alone reach the whole-cache refusal
 * `LruCache.set` enforces.
 */
export const DELTA_BASE_CHAIN_INSERT_FRACTION = 0.25;

/**
 * Fixed per-entry overhead `ctx.deltaCache`'s own byte accounting adds beyond
 * the raw content length: the `ObjectId` key, the LRU's own node object, and
 * the `{ type, content }` wrapper. Deliberately NOT
 * {@link DELTA_BASE_CACHE_ENTRY_OVERHEAD_BYTES}'s 200 B term —
 * `deltaCacheMaxBytes` is a public dial whose documented capacity consumers
 * already tuned against; charging the delta-base cache's heavier per-entry
 * term here would evict a walk that fits today under a fixture too small to
 * expose the cliff.
 */
export const OBJECT_CACHE_ENTRY_OVERHEAD_BYTES = 32;

/**
 * Populate one delta-chain level's offset-keyed entry, under an
 * already-built key — a `DeltaStep`'s own `probeKey` for a delta level, or a
 * freshly-built one for the base (which was never pushed as a `DeltaStep`
 * and so never had a key built for it before now). Callers skip this
 * entirely for a level with no key at all: one that came from a cache hit
 * (already cached) or a REF_DELTA base (resolved by id, not by this pack's
 * offset).
 */
export function cacheDeltaBase(
  ctx: Context,
  registry: PackRegistry,
  key: string,
  type: PackEntryHeader['type'],
  content: Uint8Array,
  chainDepth: number,
): boolean {
  if (!deltaBaseCachingEnabled(ctx)) return false;
  return registry.deltaBaseCache.set(
    key,
    { type, content, chainDepth },
    deltaBaseCacheEntrySize(content),
  );
}
