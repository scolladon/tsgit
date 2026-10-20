import { TsgitError } from '../../domain/error.js';
import { indexOf } from '../../domain/objects/encoding.js';
import { isObjectNotFound, objectNotFound } from '../../domain/objects/error.js';
import { parseHeader } from '../../domain/objects/header.js';
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
import { forgetLooseOidPrefix, probeLooseOid } from './internal/loose-oid-cache.js';
import { looseLocationOf, type SourceLocation } from './internal/source-location.js';
import {
  enterRefBase,
  isBase,
  LOOSE_HEADER_WINDOW,
  looseHeaderTooLong,
  ofsDeltaBaseOffset,
  readEntryHeaderWithChunk,
  resolveLooseArm,
  resolveObject,
  resolveObjectContent,
  resolveObjectWithSize,
} from './object-resolver.js';
import {
  disposeObjectStore,
  getObjectStore,
  looseCacheLocation,
  type ObjectSource,
  type ObjectStore,
  peekObjectStore,
  refreshObjectStore,
} from './object-store.js';
import { nextOffsetForEntry, type PackLookupHit, type PackRegistry } from './pack-registry.js';
import { looseObjectPathIn } from './path-layout.js';
import type { RawObject, ReadObjectOptions } from './types.js';

/**
 * Per-session in-flight lazy-fetch map. Concurrent reads of the same missing
 * object share a single promisor fetch instead of each issuing its own.
 */
const inflightCache = new WeakMap<Context['session'], Map<string, Promise<boolean>>>();

export const getPackRegistry = async (ctx: Context): Promise<PackRegistry> =>
  (await getObjectStore(ctx)).primary.registry;

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
  peekObjectStore(ctx)?.primary.registry;

/**
 * Drop the per-session pack-registry's cached `.idx` scan so the next read
 * re-scans `objects/pack/`. MUST be called after a pack is written into a live
 * Context (e.g. `fetchPack`), otherwise objects delivered by that pack are
 * invisible to subsequent reads through the same handle — the failure `pull`
 * exposed when its `merge` step could not see freshly-fetched commits.
 */
export function refreshPackRegistry(ctx: Context): void {
  refreshObjectStore(ctx);
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
  await disposeObjectStore(ctx);
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
 * contract than the parsed one. Exported for `blob-source.ts`'s
 * `verifyStoredObject` (the ref-target verifier), which needs the identical
 * retry contract for a promised object.
 */
export async function withLazyFetchRetry<T>(
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
  const store = peekObjectStore(ctx) ?? (await getObjectStore(ctx));
  return withLazyFetchRetry(ctx, id, store.primary.registry, () =>
    resolveObject(ctx, store, id, verifyHash, options?.maxBytes),
  );
}

/** Like `readObject`, but also surfaces the resolved object's declared size
 *  — `cat-file-batch.ts`'s reader, sharing the same lazy-fetch retry and
 *  parsed memo. git's `cat-file`/`--batch` route blobs to the streaming
 *  tier, so a size-lying blob serves its real bytes here rather than
 *  refusing an overrun. */
export async function readObjectWithSize(
  ctx: Context,
  id: ObjectId,
  options?: ReadObjectOptions,
): Promise<{ readonly object: GitObject; readonly size: number }> {
  const verifyHash = options?.verifyHash ?? false;
  const store = peekObjectStore(ctx) ?? (await getObjectStore(ctx));
  return withLazyFetchRetry(ctx, id, store.primary.registry, () =>
    resolveObjectWithSize(ctx, store, id, verifyHash, options?.maxBytes, 'streamed'),
  );
}

/**
 * `readObject` through git's streaming read tier rather than the buffered
 * default — `show`'s blob target, which serves a size-lying blob's real
 * bytes exactly as `cat-file -p` does. A commit, tree or tag refuses
 * identically in both tiers, so this is never needed for them. INTERNAL:
 * not re-exported from the primitives barrel.
 */
export async function readObjectStreamed(
  ctx: Context,
  id: ObjectId,
  options?: ReadObjectOptions,
): Promise<GitObject> {
  const verifyHash = options?.verifyHash ?? false;
  const store = peekObjectStore(ctx) ?? (await getObjectStore(ctx));
  return withLazyFetchRetry(ctx, id, store.primary.registry, () =>
    resolveObject(ctx, store, id, verifyHash, options?.maxBytes, 'streamed'),
  );
}

export async function readRawObject(
  ctx: Context,
  id: ObjectId,
  options?: ReadObjectOptions,
): Promise<RawObject> {
  const verifyHash = options?.verifyHash ?? false;
  const store = peekObjectStore(ctx) ?? (await getObjectStore(ctx));
  return withLazyFetchRetry(ctx, id, store.primary.registry, async () => {
    const { type, content } = await resolveObjectContent(
      ctx,
      store,
      id,
      verifyHash,
      options?.maxBytes,
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
  const store = peekObjectStore(ctx) ?? (await getObjectStore(ctx));
  return withLazyFetchRetry(ctx, id, store.primary.registry, () =>
    resolveObjectMetadataWithContent(ctx, store, id),
  );
}

/**
 * How many compressed bytes of a loose object the size-only read probes
 * before giving up on finding the header's NUL and falling back to a whole-
 * file inflate. A dynamic-Huffman deflate header can spend more than a few
 * hundred compressed bytes before its first literal, so this is generous
 * headroom for the COMMON case, not a hard structural bound.
 */
const LOOSE_HEADER_PROBE_BYTES = 1024;

/**
 * git's `CHECK_SIZE_ONLY` read: the loose header's declared size CLAIM,
 * never the real content length — the opposite contract from
 * `readObjectMetadata` (content-derived, unchanged) and exactly what the
 * size gate (`detect-similarity-renames.ts`) needs to prefilter candidates
 * without inflating a single blob. A packed entry's size is already
 * header-only via `readPackedMetadata` — reused as-is.
 */
export async function readDeclaredObjectSize(ctx: Context, id: ObjectId): Promise<number> {
  return (await readDeclaredObjectHeader(ctx, id)).declaredSize;
}

/** The type and declared size of an object, read header-only: the loose
 *  header's claim or the pack entry's own header, never an inflate of the
 *  content. Lets a caller pick its read order by type before reading. */
export async function readDeclaredObjectHeader(
  ctx: Context,
  id: ObjectId,
): Promise<DeclaredObjectHeader> {
  const store = peekObjectStore(ctx) ?? (await getObjectStore(ctx));
  return withLazyFetchRetry(ctx, id, store.primary.registry, () =>
    resolveDeclaredHeader(ctx, store, id),
  );
}

export interface DeclaredObjectHeader {
  readonly type: ObjectType;
  readonly declaredSize: number;
}

async function resolveDeclaredHeader(
  ctx: Context,
  store: ObjectStore,
  id: ObjectId,
): Promise<DeclaredObjectHeader> {
  for (const source of store.sources) {
    const hit = await source.registry.lookup(id);
    if (hit !== undefined) {
      const { type, uncompressedSize } = await readPackedMetadata(ctx, source.registry, hit, id);
      return { type, declaredSize: uncompressedSize };
    }
    const looseHeader = await readLooseDeclaredHeader(ctx, id, looseCacheLocation(store, source));
    if (looseHeader !== undefined) return looseHeader;
  }
  throw objectNotFound(id);
}

/**
 * Reads only the first `LOOSE_HEADER_PROBE_BYTES` compressed bytes off disk
 * — never the whole file — mirroring `readLooseCompressed`'s membership-
 * gated miss handling (object-resolver.ts): an external pruner removing the
 * file between the membership probe and this read is a git-faithful MISS,
 * not a refusal.
 */
async function readLooseDeclaredHeader(
  ctx: Context,
  id: ObjectId,
  location?: SourceLocation,
): Promise<DeclaredObjectHeader | undefined> {
  if (!(await probeLooseOid(ctx, id, location))) return undefined;
  let prefix: Uint8Array;
  try {
    const loose = looseLocationOf(ctx, location);
    prefix = await loose.fs.readSlice(
      looseObjectPathIn(loose.objectsDir, id),
      0,
      LOOSE_HEADER_PROBE_BYTES,
    );
  } catch (error) {
    if (error instanceof TsgitError && error.data.code === 'FILE_NOT_FOUND') {
      forgetLooseOidPrefix(ctx, id, location);
      return undefined;
    }
    throw error;
  }
  return resolveDeclaredHeaderFromPrefix(ctx, id, prefix, location);
}

/** One header probe's outcome: the declared size once a NUL is found within
 *  `LOOSE_HEADER_WINDOW`; `tooLong` once the probe's own output fills that
 *  window without one; `incomplete` when the probed bytes ran out first,
 *  still under the window — the only outcome a whole-file fallback can ever
 *  help with. */
type HeaderProbeOutcome =
  | { readonly status: 'found'; readonly header: DeclaredObjectHeader }
  | { readonly status: 'tooLong' }
  | { readonly status: 'incomplete' };

/**
 * Probes `compressed` through the port's own bounded `inflateHead` — never a
 * hand-rolled streaming scan — for the header's NUL, mirroring
 * `inflateLooseBuffered`'s own probe (object-resolver.ts). `inflateHead`
 * never returns more than `LOOSE_HEADER_WINDOW` bytes here, so reaching that
 * many with no NUL means the header could never terminate inside git's own
 * fixed-size buffer, however much more of `compressed` is left unread.
 */
function declaredHeaderOf(headerBytes: Uint8Array): DeclaredObjectHeader {
  const { type, size } = parseHeader(headerBytes);
  return { type, declaredSize: size };
}

async function probeDeclaredSize(
  ctx: Context,
  compressed: Uint8Array,
): Promise<HeaderProbeOutcome> {
  const head = await ctx.compressor.inflateHead(compressed, LOOSE_HEADER_WINDOW);
  const nullPos = indexOf(head, 0x00, 0);
  if (nullPos !== -1)
    return { status: 'found', header: declaredHeaderOf(head.subarray(0, nullPos + 1)) };
  return head.length >= LOOSE_HEADER_WINDOW ? { status: 'tooLong' } : { status: 'incomplete' };
}

/**
 * Resolves the declared size from an on-disk PREFIX read (never necessarily
 * the whole file). The prefix given to `inflateHead` may end mid-block —
 * `readSlice`'s on-disk cutoff, unlike a member's own natural end, is not a
 * boundary the decoder tolerates — so a hard decode fault here is as
 * ambiguous as a clean `incomplete` outcome: only a prefix that already hit
 * the read budget (`LOOSE_HEADER_PROBE_BYTES`; more of the file may exist
 * unread) routes either one to the whole-file fallback. A prefix that IS
 * already the whole file propagates its own fault as-is; a stream that ends,
 * or is cut short, before any NUL is git's `header … too long` — its
 * `git_inflate` takes a starved stream for a clean stop, and an unterminated
 * header for one longer than its buffer. A `tooLong` outcome always throws immediately regardless of
 * how much of the file is left unread — git's own fixed-size header buffer
 * refuses the same way independent of the object's total length, so it is
 * checked BEFORE the fallback decision, never inside the catch a hard fault
 * shares with it.
 */
async function resolveDeclaredHeaderFromPrefix(
  ctx: Context,
  id: ObjectId,
  prefix: Uint8Array,
  location?: SourceLocation,
): Promise<DeclaredObjectHeader> {
  const isPrefixTruncated = prefix.length === LOOSE_HEADER_PROBE_BYTES;
  let outcome: HeaderProbeOutcome;
  try {
    outcome = await probeDeclaredSize(ctx, prefix);
  } catch (error) {
    if (isPrefixTruncated) return readDeclaredHeaderFromWholeFile(ctx, id, location);
    throw error;
  }
  if (outcome.status === 'found') return outcome.header;
  if (outcome.status === 'tooLong') throw looseHeaderTooLong(id);
  if (isPrefixTruncated) return readDeclaredHeaderFromWholeFile(ctx, id, location);
  throw looseHeaderTooLong(id);
}

/** The rare fallback: a header whose NUL never appeared inside the probe
 *  budget. Re-reads the WHOLE compressed file but probes it through the SAME
 *  bounded `inflateHead`, never a one-shot whole-buffer inflate, so a
 *  hostile object whose header never terminates still refuses after
 *  `LOOSE_HEADER_WINDOW` output bytes instead of decompressing without limit. */
async function readDeclaredHeaderFromWholeFile(
  ctx: Context,
  id: ObjectId,
  location?: SourceLocation,
): Promise<DeclaredObjectHeader> {
  const loose = looseLocationOf(ctx, location);
  const compressed = await loose.fs.read(looseObjectPathIn(loose.objectsDir, id));
  const outcome = await probeDeclaredSize(ctx, compressed);
  if (outcome.status === 'found') return outcome.header;
  throw looseHeaderTooLong(id);
}

async function resolveObjectMetadataWithContent(
  ctx: Context,
  store: ObjectStore,
  id: ObjectId,
): Promise<ObjectMetadataWithContent> {
  for (const source of store.sources) {
    const hit = await source.registry.lookup(id);
    if (hit !== undefined) return readPackedMetadata(ctx, source.registry, hit, id);
    const loose = await metadataFromLoose(ctx, store, source, id);
    if (loose !== undefined) return loose;
  }
  return metadataAfterFullMiss(ctx, store, id);
}

/** This metadata stays content-derived, never the header claim a size-lying
 *  blob carries, so the loose read takes the streaming tier — never the
 *  buffered default the public `readRawObject` takes. The loose route already
 *  paid for the inflate, so the content is handed back too. */
async function metadataFromLoose(
  ctx: Context,
  store: ObjectStore,
  source: ObjectSource,
  id: ObjectId,
): Promise<ObjectMetadataWithContent | undefined> {
  const loose = await resolveLooseArm(
    ctx,
    looseCacheLocation(store, source),
    id,
    undefined,
    false,
    'streamed',
  );
  if (loose === undefined) return undefined;
  return { type: loose.type, uncompressedSize: loose.content.length, content: loose.content };
}

/** No source claimed `id`: the full resolver owns the virtual empty tree, the
 *  delta cache and the one rescan retry, and throws the not-found. The outer
 *  `withLazyFetchRetry` already covers the partial-clone retry. */
async function metadataAfterFullMiss(
  ctx: Context,
  store: ObjectStore,
  id: ObjectId,
): Promise<ObjectMetadataWithContent> {
  const { type, content } = await resolveObjectContent(
    ctx,
    store,
    id,
    false,
    undefined,
    'streamed',
  );
  return { type, uncompressedSize: content.length, content };
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
 * Reuses `ofsDeltaBaseOffset` and `enterRefBase` so this third
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
  let walked: Set<ObjectId> | undefined;
  for (;;) {
    if (currentHeader.type === PACK_ENTRY_TYPE.REF_DELTA) {
      walked = enterRefBase(walked, currentHeader.baseId, currentHit.offset);
    }
    const nextHit = await nextDeltaHit(registry, currentHit, currentHeader, targetId);
    const { header: nextHeader } = await readEntryHeaderAt(ctx, nextHit);
    if (!isDeltaHeader(nextHeader)) {
      return packEntryTypeToObjectType(nextHeader.type);
    }
    currentHit = nextHit;
    currentHeader = nextHeader;
  }
}

/**
 * One hop down a delta chain by HEADER alone: OFS_DELTA stays in the same
 * pack at a computed offset; REF_DELTA looks its base up by id, which may
 * land in a different pack. git's own header-only type walk
 * (`packed_to_object_type` in `packfile.c`) resolves a REF_DELTA base with a
 * plain `find_pack_entry` lookup against the packs already known — it never
 * calls `reprepare_packed_git`; only the CONTENT-resolving path
 * (`oid_object_info_extended` / `do_oid_object_info_extended`) retries after
 * a re-scan, which `resolveBaseForRefDelta` (object-resolver.ts) already
 * gets via `resolveObjectContent`. A base the registry cannot find
 * here is a corrupt pack — this throws OBJECT_NOT_FOUND for the base id,
 * fail-loud like every other read here, and retried by the same
 * `withLazyFetchRetry` a missing REF_DELTA base already gets via
 * `resolveObject`/`readRawObject`.
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
