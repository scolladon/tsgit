import { isObjectNotFound, objectNotFound } from '../../domain/objects/error.js';
import type { GitObject, ObjectId, ObjectType } from '../../domain/objects/index.js';
import {
  type OfsPackEntryHeader,
  PACK_ENTRY_TYPE,
  type PackEntryHeader,
  packEntryTypeToObjectType,
  type RefPackEntryHeader,
  readDeltaTargetSize,
} from '../../domain/storage/index.js';
import type { Context } from '../../ports/context.js';
import type { PromisorRemote } from '../../ports/promisor.js';
import { createPromiseMemo, type PromiseMemo } from './internal/promise-memo.js';
import {
  assertRepoSettingsValid,
  repoSettingsVerdictSettled,
} from './internal/repo-settings-gate.js';
import {
  assertChainDepthWithinCap,
  isBase,
  ofsDeltaBaseOffset,
  readEntryHeaderWithChunk,
  resolveObject,
  resolveObjectContentWithDepth,
} from './object-resolver.js';
import {
  createPackRegistry,
  nextOffsetForEntry,
  type PackLookupHit,
  type PackRegistry,
} from './pack-registry.js';
import type { RawObject, ReadObjectOptions } from './types.js';

/**
 * Per-session single-flight registry construction. Keyed by `ctx.session`
 * (not the Context instance itself) so that every Context derived from the
 * same `openRepository()`/`createXContext()` call — a long-running walk
 * (walkCommits, walkTree), or a same-repository derivation such as fsck's
 * audit view — reuses the parsed .idx files across thousands of object reads
 * instead of re-scanning the pack directory each time. `PromiseMemo`, not a
 * plain `WeakMap<Session, PackRegistry>`: `createPackRegistry` now crosses an
 * `await` (it reads `core.deltaBaseCacheLimit`), so two concurrent first
 * reads racing on an empty cache must join the same construction instead of
 * each starting — and finishing — their own registry.
 */
const registryMemos = new WeakMap<Context['session'], PromiseMemo<PackRegistry>>();

/**
 * The settled registry for a session that has already resolved once — the
 * synchronous surface both `refreshPackRegistry` and `peekPackRegistry`
 * read, the latter on every warm object read, so this is a hot-path map and
 * not merely a refresh hook. A registry still under construction has not
 * scanned the pack directory yet, so there is nothing for a concurrent
 * `refresh()` to do and nothing for a peek to serve; both simply miss.
 */
const resolvedRegistries = new WeakMap<Context['session'], PackRegistry>();

/**
 * Per-session in-flight lazy-fetch map. Concurrent reads of the same missing
 * object share a single promisor fetch instead of each issuing its own.
 */
const inflightCache = new WeakMap<Context['session'], Map<string, Promise<boolean>>>();

export const getPackRegistry = async (ctx: Context): Promise<PackRegistry> => {
  if (!repoSettingsVerdictSettled(ctx)) await assertRepoSettingsValid(ctx);
  let memo = registryMemos.get(ctx.session);
  if (memo === undefined) {
    // `resolvedRegistries.set` rides the CONSTRUCTION's own `.then`, not
    // every call: once per registry build, not once per read. A call that
    // joins an already-settled memo returns straight from `memo.get()`
    // without ever re-touching `resolvedRegistries` — `peekPackRegistry`
    // already served the sync case, and this async path pays a `WeakMap.set`
    // it does not need to repeat.
    memo = createPromiseMemo(() =>
      createPackRegistry(ctx).then((registry) => {
        resolvedRegistries.set(ctx.session, registry);
        return registry;
      }),
    );
    registryMemos.set(ctx.session, memo);
  }
  return memo.get();
};

/**
 * The synchronous fast path `getPackRegistry` cannot be: a settled registry
 * for a session whose repo-settings verdict is CURRENT, at zero promise-hop
 * cost. `readObject` and its siblings call `peekPackRegistry(ctx) ?? await
 * getPackRegistry(ctx)` — the settled case pays one `WeakMap.get` (~10ns)
 * instead of the two microtask hops `await`-ing an already-resolved promise
 * costs (~135ns measured on this worktree), the same order of saving
 * `repoSettingsVerdictSettled` already banks for the config check itself.
 *
 * Gated on `repoSettingsVerdictSettled`, never on "a registry merely exists":
 * a registry built against a SUPERSEDED config key must not be served as if
 * still current, which would reopen the stale-verdict hole one call site later.
 * `repoSettingsVerdictSettled` is itself key-aware (see `config-read.ts`), so
 * this peek inherits that protection instead of re-deriving it.
 */
export const peekPackRegistry = (ctx: Context): PackRegistry | undefined =>
  repoSettingsVerdictSettled(ctx) ? resolvedRegistries.get(ctx.session) : undefined;

/**
 * Drop the per-session pack-registry's cached `.idx` scan so the next read
 * re-scans `objects/pack/`. MUST be called after a pack is written into a live
 * Context (e.g. `fetchPack`), otherwise objects delivered by that pack are
 * invisible to subsequent reads through the same handle — the failure `pull`
 * exposed when its `merge` step could not see freshly-fetched commits.
 */
export function refreshPackRegistry(ctx: Context): void {
  resolvedRegistries.get(ctx.session)?.refresh();
}

/**
 * Close every persistent per-pack handle the registry opened for this
 * session. Does NOT create a registry if none exists — a repo that never
 * touched a pack disposes without scanning `objects/pack/`.
 *
 * The in-flight construction this awaits can now REJECT (a repo-settings
 * refusal, or a config read fault) where the old synchronous registry never
 * could — `dispose` is cleanup, not a place to surface a construction
 * failure the caller already has its own path to observe. The rejection is
 * swallowed deliberately and narrowly, at exactly this one `.catch`, not by
 * silencing the underlying promise: a dispose racing a still-failing
 * construction has nothing left to close.
 */
export async function disposePackRegistry(ctx: Context): Promise<void> {
  const pending = registryMemos.get(ctx.session)?.peek();
  const registry = await pending?.catch(() => undefined);
  await registry?.dispose();
}

function getInflight(ctx: Context): Map<string, Promise<boolean>> {
  let inflight = inflightCache.get(ctx.session);
  if (inflight === undefined) {
    inflight = new Map();
    inflightCache.set(ctx.session, inflight);
  }
  return inflight;
}

/**
 * Fetch `id` from the promisor remote, de-duplicating reads of the same
 * missing object whose fetches overlap in time — they share one promisor
 * call. A read that misses *after* an earlier fetch already completed is not
 * a duplicate: the object was genuinely absent for it, so it fetches anew.
 * Returns the promisor's `attempted` flag — false on a non-partial repo.
 */
async function lazyFetchOnce(
  ctx: Context,
  promisor: PromisorRemote,
  id: ObjectId,
): Promise<boolean> {
  const inflight = getInflight(ctx);
  const existing = inflight.get(id);
  if (existing !== undefined) return existing;
  const pending = promisor.fetch([id]).then((outcome) => outcome.attempted);
  inflight.set(id, pending);
  try {
    return await pending;
  } finally {
    inflight.delete(id);
  }
}

/**
 * Runs `run` once; on an `OBJECT_NOT_FOUND` miss with a promisor attached,
 * lazy-fetches the missing object and retries `run` exactly once. Shared by
 * `readObject` and `readRawObject` so a partial clone behaves identically on
 * both — a divergence here would let the raw path see a weaker retry
 * contract than the parsed one.
 */
async function withLazyFetchRetry<T>(
  ctx: Context,
  id: ObjectId,
  registry: PackRegistry,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const promisor = ctx.promisor;
    // tsgit strips thin-pack, so every stored pack is self-contained — a
    // resolver miss always means the requested object itself is absent,
    // never a dangling delta base.
    if (promisor === undefined || !isObjectNotFound(err)) throw err;
    // Partial-clone lazy-fetch: pull the missing object, refresh the pack
    // registry so the new pack is visible, then retry the resolve exactly once.
    const attempted = await lazyFetchOnce(ctx, promisor, id);
    // No fetch happened (non-partial repo): the store is unchanged, so a retry
    // would scan the packs again and throw the identical OBJECT_NOT_FOUND.
    // Surface the original error directly and skip that pointless re-resolve.
    if (!attempted) throw err;
    registry.refresh();
    return run();
  }
}

export async function readObject(
  ctx: Context,
  id: ObjectId,
  options?: ReadObjectOptions,
): Promise<GitObject> {
  const verifyHash = options?.verifyHash ?? false;
  const registry = peekPackRegistry(ctx) ?? (await getPackRegistry(ctx));
  return withLazyFetchRetry(ctx, id, registry, () =>
    resolveObject(ctx, registry, id, verifyHash, options?.maxBytes),
  );
}

export async function readRawObject(
  ctx: Context,
  id: ObjectId,
  options?: ReadObjectOptions,
): Promise<RawObject> {
  const verifyHash = options?.verifyHash ?? false;
  const registry = peekPackRegistry(ctx) ?? (await getPackRegistry(ctx));
  return withLazyFetchRetry(ctx, id, registry, async () => {
    const { type, content } = await resolveObjectContentWithDepth(
      ctx,
      registry,
      id,
      verifyHash,
      options?.maxBytes,
      0,
    );
    return { type, content };
  });
}

/**
 * An object's type and uncompressed content size, without materialising the
 * content. The size is always a property of the object's CONTENT — never of
 * how it is currently stored — so it stays stable across a gc repack that
 * rewrites exactly the packs a stored-size shortcut would depend on.
 */
export interface ObjectMetadata {
  readonly type: ObjectType;
  readonly uncompressedSize: number;
}

/**
 * `ObjectMetadata` plus the content the loose route already inflated to
 * compute `uncompressedSize` — see `readObjectMetadataWithContent`. Every
 * packed route leaves `content` `undefined`: a packed base entry gets its
 * size straight from the pack header (zero inflate) and a packed delta gets
 * it from the delta instruction stream (not the target's own bytes), so
 * neither ever has final content to hand back.
 */
export interface ObjectMetadataWithContent extends ObjectMetadata {
  readonly content?: Uint8Array;
}

type DeltaEntryHeader = OfsPackEntryHeader | RefPackEntryHeader;

/** `isBase`'s own predicate type is an intersection, which TypeScript won't
 *  narrow on the negative branch — this re-expresses the same test against a
 *  plain union so the "still walking a delta" branch narrows cleanly. */
function isDeltaHeader(header: PackEntryHeader): header is DeltaEntryHeader {
  return !isBase(header);
}

export async function readObjectMetadata(ctx: Context, id: ObjectId): Promise<ObjectMetadata> {
  const { type, uncompressedSize } = await readObjectMetadataWithContent(ctx, id);
  return { type, uncompressedSize };
}

/**
 * Like `readObjectMetadata`, but surfaces the loose route's already-inflated
 * content instead of discarding it. A caller that needs both metadata and
 * content for the same object (deltify's emission-order pass) reads a loose
 * object once instead of twice; packed routes are untouched and never carry
 * content (see `ObjectMetadataWithContent`).
 */
export async function readObjectMetadataWithContent(
  ctx: Context,
  id: ObjectId,
): Promise<ObjectMetadataWithContent> {
  const registry = peekPackRegistry(ctx) ?? (await getPackRegistry(ctx));
  return withLazyFetchRetry(ctx, id, registry, () =>
    resolveObjectMetadataWithContent(ctx, registry, id),
  );
}

async function resolveObjectMetadataWithContent(
  ctx: Context,
  registry: PackRegistry,
  id: ObjectId,
): Promise<ObjectMetadataWithContent> {
  const hit = await registry.lookup(id);
  if (hit === undefined) {
    // No pack claims this id: a full inflate is the cheapest route left, and
    // it inherits readRawObject's own partial-clone lazy-fetch retry. Hand
    // the inflated content back too — the loose route already paid for it.
    const raw = await readRawObject(ctx, id);
    return { type: raw.type, uncompressedSize: raw.content.length, content: raw.content };
  }
  return readPackedMetadata(ctx, registry, hit, id);
}

async function readPackedMetadata(
  ctx: Context,
  registry: PackRegistry,
  hit: PackLookupHit,
  targetId: ObjectId,
): Promise<ObjectMetadata> {
  const { header, chunk, headerEndInChunk } = await readEntryHeaderAt(ctx, hit);
  if (!isDeltaHeader(header)) {
    // Packed base entry: the size already sits in the pack header — zero inflate.
    return { type: packEntryTypeToObjectType(header.type), uncompressedSize: header.size };
  }
  // One inflate of the delta INSTRUCTION stream (not the object) — already
  // the smallest representation carrying the target's declared size.
  const instructions = await ctx.compressor.inflate(chunk.subarray(headerEndInChunk));
  const type = await walkDeltaBaseType(ctx, registry, hit, header, targetId);
  return { type, uncompressedSize: readDeltaTargetSize(instructions) };
}

async function readEntryHeaderAt(
  ctx: Context,
  hit: PackLookupHit,
): Promise<{ header: PackEntryHeader; chunk: Uint8Array; headerEndInChunk: number }> {
  const table = await hit.pack.offsetTable();
  const nextOffset = nextOffsetForEntry(table, hit.offset);
  return readEntryHeaderWithChunk(ctx, hit, nextOffset, table.packFileSize);
}

/**
 * Walks base links through entry HEADERS only, never inflating a base — the
 * type comes from the base entry's own header once the walk reaches it.
 * Reuses `ofsDeltaBaseOffset` and `assertChainDepthWithinCap` so this third
 * delta-chain walker cannot drift from the two `collectDeltaChain` already
 * uses to resolve full bytes.
 */
async function walkDeltaBaseType(
  ctx: Context,
  registry: PackRegistry,
  hit: PackLookupHit,
  header: DeltaEntryHeader,
  targetId: ObjectId,
): Promise<ObjectType> {
  let currentHit = hit;
  let currentHeader = header;
  let depth = 1;
  for (;;) {
    const nextHit = await nextDeltaHit(registry, currentHit, currentHeader, targetId);
    const { header: nextHeader } = await readEntryHeaderAt(ctx, nextHit);
    if (!isDeltaHeader(nextHeader)) {
      return packEntryTypeToObjectType(nextHeader.type);
    }
    depth += 1;
    assertChainDepthWithinCap(depth);
    currentHit = nextHit;
    currentHeader = nextHeader;
  }
}

/**
 * One hop down a delta chain by HEADER alone: OFS_DELTA stays in the same
 * pack at a computed offset; REF_DELTA looks its base up by id, which may
 * land in a different pack. A base a pack claims but cannot supply is a
 * corrupt pack — this throws OBJECT_NOT_FOUND for the base id, fail-loud
 * like every other read here, and retried by the same `withLazyFetchRetry`
 * a missing REF_DELTA base already gets via `resolveObject`/`readRawObject`.
 */
async function nextDeltaHit(
  registry: PackRegistry,
  hit: PackLookupHit,
  header: DeltaEntryHeader,
  targetId: ObjectId,
): Promise<PackLookupHit> {
  if (header.type === PACK_ENTRY_TYPE.OFS_DELTA) {
    const baseOffset = ofsDeltaBaseOffset(targetId, hit.offset, header.baseDistance);
    return { pack: hit.pack, offset: baseOffset };
  }
  const baseHit = await registry.lookup(header.baseId);
  if (baseHit === undefined) throw objectNotFound(header.baseId);
  return baseHit;
}
