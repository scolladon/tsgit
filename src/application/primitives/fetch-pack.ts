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
import { httpError } from '../../domain/error.js';
import { bytesToHex, hexToBytes } from '../../domain/objects/encoding.js';
import type { ObjectId } from '../../domain/objects/object-id.js';
import {
  buildUploadPackRequest,
  decodePktStream,
  invalidBaseUrl,
  parseUploadPackResponse,
} from '../../domain/protocol/index.js';
import {
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
}

export interface FetchPackResult {
  readonly packPath: string;
  readonly idxPath: string;
  readonly objectCount: number;
  /** Hex-encoded SHA of the pack trailer; also the on-disk filename stem. */
  readonly packSha: string;
}

export const fetchPack = async (
  ctx: Context,
  transport: HttpTransport,
  input: FetchPackInput,
): Promise<FetchPackResult> => {
  ctx.progress.start(input.progressOp);
  try {
    const packBytes = await downloadPack(ctx, transport, input);
    const packSha = await verifyPackTrailer(packBytes, ctx);
    const entries = await walkPackEntries(ctx, packBytes);
    const idxBytes = await buildIdx(ctx, entries, packSha);
    return writePackArtifacts(ctx, packBytes, idxBytes, packSha, entries.length);
  } finally {
    ctx.progress.end(input.progressOp);
  }
};

const downloadPack = async (
  ctx: Context,
  transport: HttpTransport,
  input: FetchPackInput,
): Promise<Uint8Array> => {
  const requestBody = buildUploadPackRequest({
    wants: input.wants,
    haves: input.haves,
    capabilities: input.capabilities,
    done: true,
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
  });
  return drainPackBody(parsed.packBody);
};

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
        reader.releaseLock();
        return { done: true, value: undefined };
      },
    };
  },
});

const drainPackBody = async (source: AsyncIterable<Uint8Array>): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
};

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

const walkPackEntries = async (
  ctx: Context,
  packBytes: Uint8Array,
): Promise<ReadonlyArray<WalkedEntry>> => {
  const header = parsePackHeader(packBytes);
  const trailerStart = packBytes.length - ctx.hash.digestLength;
  const out: WalkedEntry[] = [];
  let offset = PACK_HEADER_BYTES;
  for (let i = 0; i < header.objectCount; i += 1) {
    const entryHeader = parsePackEntryHeader(packBytes, offset, ctx.hashConfig);
    const inflate = await ctx.compressor.streamInflate(packBytes, entryHeader.dataOffset);
    const entryEnd = entryHeader.dataOffset + inflate.bytesConsumed;
    if (entryEnd > trailerStart) {
      throw invalidPackHeader('entry extends past pack trailer');
    }
    const entryCrc = crc32(packBytes.subarray(offset, entryEnd));
    const id = await resolveEntryId(ctx, entryHeader, inflate.output);
    out.push({ id, crc32: entryCrc, offset });
    offset = entryEnd;
  }
  if (offset !== trailerStart) {
    throw invalidPackHeader('extra bytes between last entry and trailer');
  }
  return out;
};

const resolveEntryId = async (
  ctx: Context,
  header: PackEntryHeader,
  content: Uint8Array,
): Promise<string> => {
  const typeName = baseTypeName(header.type);
  if (typeName === undefined) {
    throw invalidPackHeader(
      `unsupported pack entry type ${header.type}: delta resolution lands in plan-step 3`,
    );
  }
  return computeLooseObjectId(ctx, typeName, content);
};

const baseTypeName = (type: PackEntryHeader['type']): string | undefined => {
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
      return undefined;
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

const writePackArtifacts = async (
  ctx: Context,
  packBytes: Uint8Array,
  idxBytes: Uint8Array,
  packSha: string,
  objectCount: number,
): Promise<FetchPackResult> => {
  const packDir = `${ctx.layout.gitDir}/objects/pack`;
  await ctx.fs.mkdir(packDir);
  const packPath = `${packDir}/pack-${packSha}.pack`;
  const idxPath = `${packDir}/pack-${packSha}.idx`;
  await ctx.fs.writeExclusive(packPath, packBytes);
  await ctx.fs.writeExclusive(idxPath, idxBytes);
  return { packPath, idxPath, objectCount, packSha };
};
