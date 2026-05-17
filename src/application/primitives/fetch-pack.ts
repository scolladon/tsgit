/**
 * Phase 12.1 — pack-fetch primitive. Shared between clone (12.1) and the
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
import { sanitize } from '../../domain/commands/error.js';
import { httpError, TsgitError } from '../../domain/error.js';
import { bytesToHex, hexToBytes } from '../../domain/objects/encoding.js';
import type { ObjectId } from '../../domain/objects/object-id.js';
import {
  buildUploadPackRequest,
  decodePktStream,
  invalidBaseUrl,
  parseUploadPackResponse,
} from '../../domain/protocol/index.js';
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
import type { HttpTransport } from '../../ports/http-transport.js';

const TEXT_ENCODER = new TextEncoder();
const PACK_HEADER_BYTES = 12;
const SIDE_BAND_CAPS: ReadonlySet<string> = new Set(['side-band-64k', 'side-band']);
const PROGRESS_TICK_BYTES = 65_536;
/**
 * Default cap on the pack body size, applied when `ctx.config?.maxResponseBytes`
 * is not set. Matches the bound documented in ADR-007 (Resume Semantics).
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
  /** Base remote URL (the same URL passed to clone). */
  readonly url: string;
  /** Progress op label — clone uses 'clone:write-objects', fetch uses 'fetch:write-objects'. */
  readonly progressOp: string;
  /**
   * Shallow clone depth. When set, sends `deepen N` and consumes the
   * accompanying `shallow <oid>` / `unshallow <oid>` response block.
   * Phase 12.2; see ADR-009.
   */
  readonly depth?: number;
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

interface PackDownload {
  readonly packBytes: Uint8Array;
  readonly shallow: ReadonlyArray<ObjectId>;
  readonly unshallow: ReadonlyArray<ObjectId>;
}

export const fetchPack = async (
  ctx: Context,
  transport: HttpTransport,
  input: FetchPackInput,
): Promise<FetchPackResult> => {
  ctx.progress.start(input.progressOp);
  try {
    const download = await downloadPack(ctx, transport, input);
    const packSha = await verifyPackTrailer(download.packBytes, ctx);
    const entries = await walkPackEntries(ctx, download.packBytes);
    const idxBytes = await buildIdx(ctx, entries, packSha);
    const written = await writePackArtifacts(
      ctx,
      download.packBytes,
      idxBytes,
      packSha,
      entries.length,
    );
    return {
      ...written,
      shallow: download.shallow,
      unshallow: download.unshallow,
    };
  } finally {
    ctx.progress.end(input.progressOp);
  }
};

const downloadPack = async (
  ctx: Context,
  transport: HttpTransport,
  input: FetchPackInput,
): Promise<PackDownload> => {
  const requestBody = buildUploadPackRequest({
    wants: input.wants,
    haves: input.haves,
    capabilities: input.capabilities,
    done: true,
    ...(input.depth !== undefined ? { depth: input.depth } : {}),
  });
  const uploadUrl = buildUploadPackUrl(input.url);
  const response = await transport.request({
    url: uploadUrl,
    method: 'POST',
    headers: {
      'content-type': 'application/x-git-upload-pack-request',
      accept: 'application/x-git-upload-pack-result',
    },
    body: requestBody,
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });
  if (response.statusCode !== 200) {
    throw httpError(response.statusCode, `git-upload-pack returned ${response.statusCode}`);
  }
  const pktSource = decodePktStream(readableStreamToAsyncIterable(response.body));
  const parsed = await parseUploadPackResponse(pktSource, {
    sideBand: hasSideBand(input.capabilities),
    // Sanitize sideband-2 text BEFORE it crosses the ProgressReporter port:
    // user-supplied reporters are free implementations and the contract does
    // not require sanitization — a logging reporter that forwards the bytes
    // verbatim would be vulnerable to terminal injection from a malicious
    // server. Sanitizing at the boundary leaves no untrusted byte on the
    // reporter call surface.
    onProgress: (text) => ctx.progress.update(input.progressOp, 0, undefined, sanitize(text)),
    expectShallow: input.depth !== undefined,
  });
  const packBytes = await drainPackBodyBounded(ctx, input, parsed.packBody);
  return { packBytes, shallow: parsed.shallow, unshallow: parsed.unshallow };
};

/**
 * Adapt the response body's web `ReadableStream` to an `AsyncIterable`. On
 * early exit (consumer throws or breaks) the iterator's `return` hook calls
 * `cancel()` so the stream + underlying socket close cleanly — `releaseLock`
 * alone leaves the stream open. See clone.ts for the matching helper (kept
 * local to each module per the primitives ↛ commands layering rule).
 */
const readableStreamToAsyncIterable = (
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> => ({
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    const reader = stream.getReader();
    return {
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        const { done, value } = await reader.read();
        return done ? { done: true, value: undefined } : { done: false, value };
      },
      return: async (): Promise<IteratorResult<Uint8Array>> => {
        try {
          await reader.cancel();
        } catch {
          // swallow — adapter closes the underlying socket regardless
        }
        return { done: true, value: undefined };
      },
    };
  },
});

const drainPackBodyBounded = async (
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
  if (total > 0 && total !== lastTick) {
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

const buildUploadPackUrl = (baseUrl: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw invalidBaseUrl('invalid URL');
  }
  if (parsed.hash !== '') throw invalidBaseUrl('fragment must not be set');
  const path = parsed.pathname.endsWith('/') ? parsed.pathname.slice(0, -1) : parsed.pathname;
  return `${parsed.protocol}//${parsed.host}${path}/git-upload-pack${parsed.search}`;
};

const hasSideBand = (caps: ReadonlyArray<string>): boolean =>
  caps.some((c) => SIDE_BAND_CAPS.has(c));

const verifyPackTrailer = async (packBytes: Uint8Array, ctx: Context): Promise<string> => {
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

const walkPackEntries = async (
  ctx: Context,
  packBytes: Uint8Array,
): Promise<ReadonlyArray<WalkedEntry>> => {
  const pending = await inflateAllEntries(ctx, packBytes);
  const resolved = await resolveAllEntries(ctx, pending);
  // equivalent-mutant: `.slice()` here defends against the consumer mutating
  // the array we sort below; `resolveAllEntries` is module-internal and never
  // shares the array, so dropping `.slice()` is observable-equivalent.
  // equivalent-mutant: `a.offset - b.offset` vs `a.offset + b.offset` is
  // equivalent when entries are inserted in offset order (the byOffset Map
  // preserves insertion order and we walk the pack in offset order). Tests
  // that exercise out-of-order REF_DELTAs still see in-order resolution
  // because resolveAllEntries re-inserts on the resolution pass.
  return resolved
    .slice()
    .sort((a, b) => a.offset - b.offset)
    .map((r) => ({ id: r.id, crc32: r.crc32, offset: r.offset }));
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
    if (entryEnd > trailerStart) {
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
): Promise<ReadonlyArray<ResolvedEntry>> => {
  const byOffset = new Map<number, ResolvedEntry>();
  const byId = new Map<string, ResolvedEntry>();
  let unresolved: ReadonlyArray<PendingEntry> = pending;
  while (unresolved.length > 0) {
    const next: PendingEntry[] = [];
    let progress = false;
    for (const entry of unresolved) {
      const resolved = await tryResolveEntry(ctx, entry, byOffset, byId);
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
  // REF_DELTA — discriminated by the header.type union narrowing above.
  const refBase = byId.get(entry.header.baseId);
  if (refBase === undefined) return undefined;
  return resolveDelta(ctx, entry, refBase);
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
): Promise<WrittenPackArtifacts> => {
  const packDir = `${ctx.layout.gitDir}/objects/pack`;
  await ctx.fs.mkdir(packDir);
  const packPath = `${packDir}/pack-${packSha}.pack`;
  const idxPath = `${packDir}/pack-${packSha}.idx`;
  await ctx.fs.writeExclusive(packPath, packBytes);
  await ctx.fs.writeExclusive(idxPath, idxBytes);
  return { packPath, idxPath, objectCount, packSha };
};
