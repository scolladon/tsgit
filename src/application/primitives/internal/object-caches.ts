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
 * even when `resolveObjectBytesWithDepth` already served the raw bytes from
 * `ctx.deltaCache` — the memo skips that redundant re-parse for the two
 * object types whose parse cost is non-trivial (blob/tree already return
 * near-raw data from `parseObject`). It sits strictly AFTER
 * `resolveObjectBytesWithDepth`, so every verifyHash/maxBytes check that call already
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
 * budget (not a fraction of it), sized so it only ever binds for atypical
 * entries — a signed/mergetag-heavy commit, an octopus merge — never for a
 * typical one. {@link memoMaxEntries} derives the default entry count FROM
 * that valve, which is what keeps the ordering (entries bind, bytes rarely
 * do) structural at every `deltaCacheMaxBytes` dial, not just the default:
 * a 4 MiB browser tab still gets `entries × typicalEntryBytes ≤ valve`.
 */
export const memoByteValve = (ctx: Context): number => ctx.deltaCache.maxSize;

/**
 * Per-entry ceiling {@link memoMaxEntries}'s default derives from: 256 B of
 * {@link PARSED_OBJECT_FIXED_OVERHEAD_BYTES} plus a 256 B typical
 * message/parents allowance. `maxEntries × this` is what the byte valve must
 * admit at every `deltaCacheMaxBytes` dial — the invariant a unit test pins
 * so a future retune that flips the binding constraint fails a test instead
 * of shipping another dead cache.
 */
export const PARSED_OBJECT_TYPICAL_ENTRY_BYTES = 512;

/**
 * Entry-count cap for the parsed-object memo — a caller-supplied
 * `cacheBudgets.parsedObjectMemoMaxEntries` always wins; otherwise derived
 * from {@link memoByteValve} so it tracks `ctx.deltaCache.maxSize` at every
 * dial (32,768 at the 16 MiB default). A second FIXED cap here (as this
 * module used to carry) would either never bind — once the valve moved off
 * the wrong fraction — or silently re-create the exact cliff this sizing
 * exists to remove, so none is layered on top.
 */
export const memoMaxEntries = (ctx: Context): number =>
  ctx.cacheBudgets?.parsedObjectMemoMaxEntries ??
  Math.floor(memoByteValve(ctx) / PARSED_OBJECT_TYPICAL_ENTRY_BYTES);

/**
 * Share of `ctx.deltaCache`'s own byte budget the FlatTree cache gets by
 * default when the caller supplies no explicit `flatTreeCacheMaxBytes` — 8
 * MiB at the 16 MiB default, admitting a ~50,000-tracked-file HEAD (see
 * `FLAT_TREE_TYPICAL_ENTRY_BYTES` in `read-head-tree.ts`, which sizes each
 * cached tree's actual footprint).
 */
const FLAT_TREE_DEFAULT_SHARE = 0.5;

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
  flatTreeCacheMaxBytes:
    ctx.cacheBudgets?.flatTreeCacheMaxBytes ?? ctx.deltaCache.maxSize * FLAT_TREE_DEFAULT_SHARE,
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
 * `TagData` wrapper objects, the entry's own oid and tree/target oid, and
 * two identity blocks worth of name/email/timestamp/timezone (a commit's
 * author+committer; a tag's single tagger fits comfortably inside the same
 * budget). These vary by tens of bytes, not orders of magnitude, so one
 * conservative constant — not per-field measurement — is enough to stop
 * every entry being undercounted regardless of message length, which a
 * message-only sizer did: a short-message, unsigned, parentless commit
 * sized to a handful of bytes despite retaining hundreds.
 */
const PARSED_OBJECT_FIXED_OVERHEAD_BYTES = 256;

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

function deltaBaseCacheEntrySize(content: Uint8Array): number {
  return content.length + DELTA_BASE_CACHE_ENTRY_OVERHEAD_BYTES;
}

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
): void {
  if (!deltaBaseCachingEnabled(ctx)) return;
  registry.deltaBaseCache.set(key, { type, content, chainDepth }, deltaBaseCacheEntrySize(content));
}
