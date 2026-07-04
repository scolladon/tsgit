/**
 * pack-fetch primitive. Shared between clone (12.1) and the
 * forthcoming fetch (12.2) / push (12.3) commands.
 *
 * Performs the `git-upload-pack` POST, drains the side-banded response into
 * an in-memory buffer (bounded by `config.maxResponseBytes`), verifies the
 * pack trailer SHA, walks the entries to compute their crc32/offset/oid, and
 * writes `pack-<sha>.pack` + `pack-<sha>.idx` under `.git/objects/pack/`.
 *
 * Out of scope here (handled by callers): URL validation, capability
 * negotiation, ref-update propagation.
 */
import { TsgitError } from '../../domain/error.js';
import { bytesToHex, hexToBytes } from '../../domain/objects/encoding.js';
import type { ObjectId } from '../../domain/objects/object-id.js';
import {
  applyDelta,
  type BasePackEntryHeader,
  crc32,
  invalidPackHeader,
  PACK_ENTRY_TYPE,
  type PackEntryHeader,
  type PackIndexWriterEntry,
  parsePackEntryHeader,
  parsePackHeader,
  serializePackIndex,
} from '../../domain/storage/index.js';
import type { Context } from '../../ports/context.js';
import { refreshPackRegistry } from './read-object.js';

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

const TEXT_ENCODER = new TextEncoder();
const PACK_HEADER_BYTES = 12;
const SIDE_BAND_CAPS: ReadonlySet<string> = new Set(['side-band-64k', 'side-band']);
const PROGRESS_TICK_BYTES = 65_536;
/**
 * Default cap on the pack body size, applied when `ctx.config?.maxResponseBytes`
 * is not set. Matches the bound documented in.
 */
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024 * 1024;
/**
 * Default cap on the entry count declared in the pack header. The 32-bit
 * field is server-controlled; without an explicit ceiling, a malicious server
 * could declare 2^32 entries and drive `walkPackEntries` into a DoS loop even
 * though the pack body itself is bounded by `maxResponseBytes`. Matches the
 * order of magnitude beyond which canonical git refuses to operate. Callers
 * can tighten the limit via `ctx.config?.maxObjectsPerPack`.
 */
const DEFAULT_MAX_OBJECT_COUNT = 50_000_000;

export interface FetchPackInput {
  /** Advertised refs the caller wants. MUST be non-empty (server-side requirement). */
  readonly wants: ReadonlyArray<ObjectId>;
  /** Objects the caller already has (negotiation). Empty for clone, populated for fetch. */
  readonly haves: ReadonlyArray<ObjectId>;
  /** Negotiated capabilities (intersection of advertised + supported). */
  readonly capabilities: ReadonlyArray<string>;
  /** Progress op label — clone uses 'clone:write-objects', fetch uses 'fetch:write-objects'. */
  readonly progressOp: string;
  /**
   * Shallow clone depth. When set, sends `deepen N` and consumes the
   * accompanying `shallow <oid>` / `unshallow <oid>` response block.
   *
   */
  readonly depth?: number;
  /**
   * Partial-clone object filter — a canonical filter spec. When set, a
   * `filter` line is emitted; the caller must have negotiated the `filter`
   * capability.
   */
  readonly filter?: string;
  /**
   * When true, write an empty `pack-<sha>.promisor` sentinel beside the pack
   * so the objects it references but omits are treated as promised.
   */
  readonly promisor?: boolean;
}

export interface FetchPackResult {
  readonly packPath: string;
  readonly idxPath: string;
  readonly objectCount: number;
  /** Hex-encoded SHA of the pack trailer; also the on-disk filename stem. */
  readonly packSha: string;
  /** Commits the server advertised as new shallow boundaries (empty when depth is unset). */
  readonly shallow: ReadonlyArray<ObjectId>;
  /** Commits the server advertised as no-longer-shallow (empty when depth is unset). */
  readonly unshallow: ReadonlyArray<ObjectId>;
}

export interface PackDownload {
  readonly packBytes: Uint8Array;
  readonly shallow: ReadonlyArray<ObjectId>;
  readonly unshallow: ReadonlyArray<ObjectId>;
}

/**
 * Negotiates and drains the pack body for one `fetchPack` call. Callers bind
 * the wire version and the transport session into this closure — `fetchPack`
 * itself stays version-agnostic, matching every other caller of the shared
 * `PackDownload` shape.
 */
export type NegotiatePackBytes = (ctx: Context, input: FetchPackInput) => Promise<PackDownload>;

export const fetchPack = async (
  ctx: Context,
  negotiatePackBytes: NegotiatePackBytes,
  input: FetchPackInput,
): Promise<FetchPackResult> => {
  ctx.progress.start(input.progressOp);
  try {
    const download = await downloadPack(ctx, negotiatePackBytes, input);
    // git-upload-pack returns a zero-byte body when the client's `have` set
    // already covers every wanted oid. This is a legitimate protocol state
    // (the server has nothing to send), not an error. Surface it as an
    // empty result so the caller can advance refs and return cleanly.
    if (download.packBytes.length === 0) {
      return emptyPackResult(download.shallow, download.unshallow);
    }
    return await materializePack(ctx, download, input);
  } finally {
    ctx.progress.end(input.progressOp);
  }
};

const emptyPackResult = (
  shallow: ReadonlyArray<ObjectId>,
  unshallow: ReadonlyArray<ObjectId>,
): FetchPackResult => ({
  packPath: '',
  idxPath: '',
  objectCount: 0,
  packSha: '',
  shallow,
  unshallow,
});

/**
 * Post-download tail: verify the trailer, walk entries, then either suppress
 * or write the pack/idx artifacts. Split out of `fetchPack` so the negotiated
 * response can be fully verified (trailer + entry walk) before deciding
 * whether it is empty — a malformed pack that merely *looks* empty (bad
 * trailer, truncated entries) must still throw, never be silently dropped.
 */
const materializePack = async (
  ctx: Context,
  download: PackDownload,
  input: FetchPackInput,
): Promise<FetchPackResult> => {
  const packSha = await verifyPackTrailer(download.packBytes, ctx);
  const entries = await walkPackEntries(ctx, download.packBytes);
  // A verified pack can legitimately carry zero entries (e.g. the negotiated
  // response round-tripped a pack rather than a zero-byte body). Suppress
  // writing pack/idx artifacts for it, same as the zero-byte-body guard above.
  if (entries.length === 0) {
    return emptyPackResult(download.shallow, download.unshallow);
  }
  const idxBytes = await buildIdx(ctx, entries, packSha);
  const written = await writePackArtifacts(
    ctx,
    download.packBytes,
    idxBytes,
    packSha,
    entries.length,
    input.promisor === true,
  );
  // Drop the per-Context pack-registry cache so reads through this same
  // handle (e.g. a follow-up merge in `pull`) see the just-written pack.
  refreshPackRegistry(ctx);
  return {
    ...written,
    shallow: download.shallow,
    unshallow: download.unshallow,
  };
};

/**
 * Thin adapter boundary: `fetchPack` stays version-agnostic, the injected
 * `negotiatePackBytes` (bound to a wire version + transport session by the
 * caller) does the actual request/response work.
 */
const downloadPack = async (
  ctx: Context,
  negotiatePackBytes: NegotiatePackBytes,
  input: FetchPackInput,
): Promise<PackDownload> => negotiatePackBytes(ctx, input);

export const drainPackBodyBounded = async (
  ctx: Context,
  input: FetchPackInput,
  source: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> => {
  const cap = ctx.config?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let lastTick = 0;
  for await (const chunk of source) {
    if (total + chunk.byteLength > cap) {
      throw packTooLargeBytes(cap);
    }
    chunks.push(chunk);
    total += chunk.byteLength;
    if (total - lastTick >= PROGRESS_TICK_BYTES) {
      ctx.progress.update(input.progressOp, total);
      lastTick = total;
    }
  }
  // Stryker disable next-line ConditionalExpression: equivalent — when `total === 0` no chunk was consumed so `lastTick` is also 0, making `tailUnticked` false; forcing `sawProgress` true cannot change the AND result.
  const sawProgress = total !== 0;
  const tailUnticked = total !== lastTick;
  if (sawProgress && tailUnticked) {
    ctx.progress.update(input.progressOp, total);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
};

/**
 * Raise `PACK_TOO_LARGE` for a byte-cap overrun. The existing variant carries
 * `objectCount`, which we set to 0 here because the cap is enforced before any
 * entry is parsed — the message text is informational for byte-cap callers;
 * `data.limit` is the byte cap that was exceeded.
 */
const packTooLargeBytes = (limit: number): TsgitError =>
  new TsgitError({ code: 'PACK_TOO_LARGE', objectCount: 0, limit });

export const hasSideBand = (caps: ReadonlyArray<string>): boolean =>
  caps.some((c) => SIDE_BAND_CAPS.has(c));

export const verifyPackTrailer = async (packBytes: Uint8Array, ctx: Context): Promise<string> => {
  const trailerLen = ctx.hash.digestLength;
  if (packBytes.length < PACK_HEADER_BYTES + trailerLen) {
    throw invalidPackHeader('trailer mismatch: pack too short for header + trailer');
  }
  const bodyEnd = packBytes.length - trailerLen;
  const body = packBytes.subarray(0, bodyEnd);
  const trailerBytes = packBytes.subarray(bodyEnd);
  const expectedHex = await ctx.hash.hashHex(body);
  const actualHex = bytesToHex(trailerBytes);
  if (expectedHex !== actualHex) {
    throw invalidPackHeader(`trailer mismatch: expected ${expectedHex}, got ${actualHex}`);
  }
  return expectedHex;
};

interface WalkedEntry {
  readonly id: string;
  readonly crc32: number;
  readonly offset: number;
}

type BaseTypeName = 'commit' | 'tree' | 'blob' | 'tag';

interface PendingEntry {
  readonly offset: number;
  readonly header: PackEntryHeader;
  readonly inflated: Uint8Array;
  readonly crc32: number;
}

interface ResolvedEntry {
  readonly id: string;
  readonly type: BaseTypeName;
  readonly content: Uint8Array;
  readonly crc32: number;
  readonly offset: number;
}

export const walkPackEntries = async (
  ctx: Context,
  packBytes: Uint8Array,
  externalBaseResolver?: ExternalBaseResolver,
): Promise<ReadonlyArray<WalkedEntry>> => {
  const pending = await inflateAllEntries(ctx, packBytes);
  const resolved = await resolveAllEntries(ctx, pending, externalBaseResolver);
  // The sort below only orders the WalkedEntry array; nothing observable
  // depends on that order — `objectCount` reads `.length`, and `buildIdx`
  // feeds `serializePackIndex`, which re-sorts entries by SHA before writing.
  // Stryker disable next-line MethodExpression: equivalent — `resolveAllEntries` is module-internal and never shares the array, so the defensive `.slice()` copy cannot change behaviour.
  const copied = resolved.slice();
  // Stryker disable next-line ArithmeticOperator,MethodExpression: equivalent — the WalkedEntry order is unobservable (objectCount uses `.length`; serializePackIndex re-sorts by SHA), so a broken comparator — or dropping the `.sort()` entirely — changes nothing downstream.
  const ordered = copied.sort((a, b) => a.offset - b.offset);
  return ordered.map((r) => ({ id: r.id, crc32: r.crc32, offset: r.offset }));
};

const inflateAllEntries = async (
  ctx: Context,
  packBytes: Uint8Array,
): Promise<ReadonlyArray<PendingEntry>> => {
  const header = parsePackHeader(packBytes);
  const objectCountCap = ctx.config?.maxObjectsPerPack ?? DEFAULT_MAX_OBJECT_COUNT;
  if (header.objectCount > objectCountCap) {
    throw new TsgitError({
      code: 'PACK_TOO_LARGE',
      objectCount: header.objectCount,
      limit: objectCountCap,
    });
  }
  const trailerStart = packBytes.length - ctx.hash.digestLength;
  const out: PendingEntry[] = [];
  let offset = PACK_HEADER_BYTES;
  for (let i = 0; i < header.objectCount; i += 1) {
    const entryHeader = parsePackEntryHeader(packBytes, offset, ctx.hashConfig);
    const inflate = await ctx.compressor.streamInflate(packBytes, entryHeader.dataOffset);
    const entryEnd = entryHeader.dataOffset + inflate.bytesConsumed;
    // Defence-in-depth guard. `verifyPackTrailer` already ran, so the final
    // `digestLength` bytes are fixed as `sha(body)`; `streamInflate` reports
    // the minimal valid zlib-stream length. An entry whose stream consumed
    // bytes past `trailerStart` would require those SHA bytes to also be a
    // valid zlib continuation — unreachable for any verifiable pack.
    // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent — `entryEnd > trailerStart` is unreachable once `verifyPackTrailer` accepted the trailer; the throw cannot fire.
    if (entryEnd > trailerStart) {
      // Stryker disable next-line StringLiteral: equivalent — the guarded throw is unreachable (see above), so its message is never observed.
      throw invalidPackHeader('entry extends past pack trailer');
    }
    const entryCrc = crc32(packBytes.subarray(offset, entryEnd));
    out.push({ offset, header: entryHeader, inflated: inflate.output, crc32: entryCrc });
    offset = entryEnd;
  }
  if (offset !== trailerStart) {
    throw invalidPackHeader('extra bytes between last entry and trailer');
  }
  return out;
};

const resolveAllEntries = async (
  ctx: Context,
  pending: ReadonlyArray<PendingEntry>,
  externalBaseResolver?: ExternalBaseResolver,
): Promise<ReadonlyArray<ResolvedEntry>> => {
  const byOffset = new Map<number, ResolvedEntry>();
  const byId = new Map<string, ResolvedEntry>();
  let unresolved: ReadonlyArray<PendingEntry> = pending;
  while (unresolved.length > 0) {
    const next: PendingEntry[] = [];
    let progress = false;
    for (const entry of unresolved) {
      const resolved = await tryResolveEntry(ctx, entry, byOffset, byId, externalBaseResolver);
      if (resolved === undefined) {
        next.push(entry);
      } else {
        byOffset.set(resolved.offset, resolved);
        byId.set(resolved.id, resolved);
        progress = true;
      }
    }
    if (!progress) throw firstUnresolvedError(next);
    unresolved = next;
  }
  return [...byOffset.values()];
};

const firstUnresolvedError = (unresolved: ReadonlyArray<PendingEntry>): Error => {
  const first = unresolved[0];
  // equivalent-mutant: `first === undefined` defensive branch is unreachable —
  // `resolveAllEntries` only calls this helper when `unresolved.length > 0`.
  // The branch exists so a future refactor that violates that invariant fails
  // with a clear message instead of throwing on `first.header`; flipping it to
  // always-false would only break that hypothetical future code path.
  if (first === undefined) {
    // Stryker disable next-line StringLiteral: equivalent — this branch is unreachable; `resolveAllEntries` only calls `firstUnresolvedError` with a non-empty `next` queue, so `first` is always defined.
    return invalidPackHeader('unresolved deltas: empty queue (internal invariant violated)');
  }
  const refBaseId = refDeltaBaseId(first.header);
  if (refBaseId !== undefined) {
    return invalidPackHeader(`unresolved REF_DELTA: base ${refBaseId} not in pack`);
  }
  return invalidPackHeader(`unresolved entry at offset ${first.offset}`);
};

const refDeltaBaseId = (header: PackEntryHeader): string | undefined => {
  if (isBaseHeader(header)) return undefined;
  if (header.type === PACK_ENTRY_TYPE.OFS_DELTA) return undefined;
  return header.baseId;
};

const tryResolveEntry = async (
  ctx: Context,
  entry: PendingEntry,
  byOffset: ReadonlyMap<number, ResolvedEntry>,
  byId: ReadonlyMap<string, ResolvedEntry>,
  externalBaseResolver?: ExternalBaseResolver,
): Promise<ResolvedEntry | undefined> => {
  if (isBaseHeader(entry.header)) {
    const type = baseTypeName(entry.header.type);
    const id = await computeLooseObjectId(ctx, type, entry.inflated);
    return { id, type, content: entry.inflated, crc32: entry.crc32, offset: entry.offset };
  }
  if (entry.header.type === PACK_ENTRY_TYPE.OFS_DELTA) {
    const baseOffset = entry.offset - entry.header.baseDistance;
    if (baseOffset < PACK_HEADER_BYTES) {
      throw invalidPackHeader(
        `OFS_DELTA at offset ${entry.offset} points before pack body: distance ${entry.header.baseDistance}`,
      );
    }
    const base = byOffset.get(baseOffset);
    if (base === undefined) return undefined;
    return resolveDelta(ctx, entry, base);
  }
  // REF_DELTA — base may be in-pack or supplied by an external resolver.
  const packBase = byId.get(entry.header.baseId);
  if (packBase !== undefined) return resolveDelta(ctx, entry, packBase);
  if (externalBaseResolver === undefined) return undefined;
  const external = await externalBaseResolver(entry.header.baseId as ObjectId);
  if (external === undefined) return undefined;
  const syntheticBase: ResolvedEntry = {
    id: entry.header.baseId,
    type: external.type,
    content: external.content,
    crc32: 0,
    offset: 0,
  };
  return resolveDelta(ctx, entry, syntheticBase);
};

const resolveDelta = async (
  ctx: Context,
  entry: PendingEntry,
  base: ResolvedEntry,
): Promise<ResolvedEntry> => {
  const content = applyDelta(base.content, entry.inflated);
  const id = await computeLooseObjectId(ctx, base.type, content);
  return { id, type: base.type, content, crc32: entry.crc32, offset: entry.offset };
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

const computeLooseObjectId = async (
  ctx: Context,
  typeName: string,
  content: Uint8Array,
): Promise<string> => {
  const headerBytes = TEXT_ENCODER.encode(`${typeName} ${content.length}\0`);
  const loose = new Uint8Array(headerBytes.length + content.length);
  loose.set(headerBytes, 0);
  loose.set(content, headerBytes.length);
  return ctx.hash.hashHex(loose);
};

const buildIdx = async (
  ctx: Context,
  entries: ReadonlyArray<WalkedEntry>,
  packSha: string,
): Promise<Uint8Array> => {
  const writerEntries: PackIndexWriterEntry[] = entries.map((e) => ({
    id: e.id,
    crc32: e.crc32,
    offset: e.offset,
  }));
  const packShaBytes = hexToBytes(packSha);
  const body = serializePackIndex(writerEntries, packShaBytes);
  // serializePackIndex writes the pack trailer SHA as the file's first checksum
  // (20 bytes at the tail of `body`); parsePackIndex expects a second checksum
  // immediately after — the SHA over the body itself. Real git produces both;
  // we follow suit so subsequent `parsePackIndex` reads round-trip cleanly.
  const idxTrailerHex = await ctx.hash.hashHex(body);
  const idxTrailerBytes = hexToBytes(idxTrailerHex);
  const out = new Uint8Array(body.length + idxTrailerBytes.length);
  out.set(body, 0);
  out.set(idxTrailerBytes, body.length);
  return out;
};

interface WrittenPackArtifacts {
  readonly packPath: string;
  readonly idxPath: string;
  readonly objectCount: number;
  readonly packSha: string;
}

const writePackArtifacts = async (
  ctx: Context,
  packBytes: Uint8Array,
  idxBytes: Uint8Array,
  packSha: string,
  objectCount: number,
  promisor: boolean,
): Promise<WrittenPackArtifacts> => {
  const packDir = `${ctx.layout.gitDir}/objects/pack`;
  await ctx.fs.mkdir(packDir);
  const packPath = `${packDir}/pack-${packSha}.pack`;
  const idxPath = `${packDir}/pack-${packSha}.idx`;
  await ctx.fs.writeExclusive(packPath, packBytes);
  await ctx.fs.writeExclusive(idxPath, idxBytes);
  // A promisor pack vouches for the objects it references but omits; the
  // empty `.promisor` sentinel marks it so missing objects read as promised.
  if (promisor) {
    await ctx.fs.writeExclusive(`${packDir}/pack-${packSha}.promisor`, new Uint8Array(0));
  }
  return { packPath, idxPath, objectCount, packSha };
};
