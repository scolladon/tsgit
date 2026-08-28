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

/**
 * Entry-count ceiling for the parsed-object memo, mirroring the commit-graph
 * header cache's own cap — a byte cap alone under-defends against a repo of
 * many small commits (short messages, no signature). At the DEFAULT
 * `deltaCacheMaxBytes`, the byte budget itself binds first — it fills at
 * roughly 4,000-5,000 short-message entries, well under this cap — so the
 * entry-count check only becomes the binding constraint once a caller
 * enlarges `deltaCacheMaxBytes` well past the default.
 */
export const PARSED_OBJECT_MEMO_MAX_ENTRIES = 65_536;

export function parsedObjectMemoFor(ctx: Context): LruCache<MemoisedObject> | undefined {
  if (!deltaBaseCachingEnabled(ctx)) return undefined;
  const existing = parsedObjectMemos.get(ctx.session);
  if (existing !== undefined) return existing;
  const created = createLruCache<MemoisedObject>(
    ctx.deltaCache.maxSize * PARSED_OBJECT_MEMO_FRACTION,
    PARSED_OBJECT_MEMO_MAX_ENTRIES,
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
