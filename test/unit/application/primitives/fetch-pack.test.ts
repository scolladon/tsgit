import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { negotiatePackBytes } from '../../../../src/application/commands/internal/fetch-negotiation.js';
import { buildPack } from '../../../../src/application/primitives/build-pack.js';
import {
  fetchPack,
  type NegotiatePackBytes,
} from '../../../../src/application/primitives/fetch-pack.js';
import {
  DISK_WALK_WINDOW_BYTES,
  type ExternalBaseResolver,
  INDEX_PASS_BASE_CACHE_MAX_BYTES,
  type IndexPackOptions,
  indexQuarantinedPack,
  walkPackEntries,
} from '../../../../src/application/primitives/internal/index-pack.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import {
  fileExists,
  fileNotFound,
  permissionDenied,
  TsgitError,
} from '../../../../src/domain/index.js';
import { hexToBytes } from '../../../../src/domain/objects/encoding.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import {
  decodePktStream,
  encodePktStream,
  type GitExchange,
} from '../../../../src/domain/protocol/pkt-line.js';
import { crc32 } from '../../../../src/domain/storage/crc32.js';
import { serializeCruftMtimes } from '../../../../src/domain/storage/cruft-pack.js';
import {
  encodePackEntryHeader,
  PACK_ENTRY_TYPE,
  parsePackHeader,
} from '../../../../src/domain/storage/pack-entry.js';
import {
  entryOffsets,
  lookupPackIndex,
  lookupPackIndexPosition,
  objectIdAt,
  parsePackIndex,
} from '../../../../src/domain/storage/pack-index.js';
import { sortPackIndexEntries } from '../../../../src/domain/storage/pack-order.js';
import { serializePackIndex } from '../../../../src/domain/storage/pack-writer.js';
import { serializePackRevIndex } from '../../../../src/domain/storage/rev-index.js';
import { readableStreamToAsyncIterable } from '../../../../src/operators/readable-stream.js';
import type { Context } from '../../../../src/ports/context.js';
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from '../../../../src/ports/http-transport.js';
import { recordingProgress, withProgress } from '../commands/fixtures.js';
import { INDEX_PASS_CORPUS } from './index-pass-corpus.js';
import { buildSyntheticPack, type EntrySpec } from './pack-fixture.js';

// Wraps `createPackRecordStore` in a call-through spy so a test can recover
// the exact `PackRecordStore` a `fetchPack` call built — the only way to
// observe its internal, ordinal-indexed `offsets` array, since the .idx and
// .rev writers both re-derive their own orderings from VALUES (oid-sort,
// offset-sort) and are therefore blind to the order the producer originally
// populated its arrays in. Every other test in this file is unaffected: the
// spy calls straight through to the real implementation.
vi.mock(
  '../../../../src/application/primitives/internal/pack-records.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../../src/application/primitives/internal/pack-records.js')
      >();
    return { ...actual, createPackRecordStore: vi.fn(actual.createPackRecordStore) };
  },
);
const packRecordsModule = await import(
  '../../../../src/application/primitives/internal/pack-records.js'
);
const createPackRecordStoreSpy = vi.mocked(packRecordsModule.createPackRecordStore);

const ENCODER = new TextEncoder();
const REMOTE_URL = 'https://remote.example/r.git';
const UPLOAD_PACK_URL = `${REMOTE_URL}/git-upload-pack`;

interface UploadPackBodyOptions {
  readonly packBytes: Uint8Array;
  readonly sideBand: boolean;
  readonly progressLines?: ReadonlyArray<string>;
}

/** Wrap pack bytes in a NAK pkt + (optional) side-band-1 frames. Matches what a real server emits. */
const buildUploadPackResponseBody = (opts: UploadPackBodyOptions): Uint8Array => {
  const payloads: Uint8Array[] = [ENCODER.encode('NAK\n')];
  if (opts.sideBand) {
    for (const line of opts.progressLines ?? []) {
      const channel2 = new Uint8Array(line.length + 1);
      channel2[0] = 0x02;
      channel2.set(ENCODER.encode(line), 1);
      payloads.push(channel2);
    }
    const channel1 = new Uint8Array(opts.packBytes.length + 1);
    channel1[0] = 0x01;
    channel1.set(opts.packBytes, 1);
    payloads.push(channel1);
  } else if (opts.packBytes.length > 0) {
    payloads.push(opts.packBytes);
  }
  return encodePktStream(payloads);
};

/**
 * Wrap pack bytes in a shallow-response block (one or more shallow/unshallow
 * lines + a flush) followed by the NAK + side-band-1 frames. Matches what a
 * real server emits in response to a `deepen <N>` request.
 */
const buildShallowResponseBody = (opts: {
  readonly packBytes: Uint8Array;
  readonly shallow: ReadonlyArray<string>;
  readonly unshallow?: ReadonlyArray<string>;
}): Uint8Array => {
  const shallowFrames = opts.shallow.map((oid) => ENCODER.encode(`shallow ${oid}\n`));
  const unshallowFrames = (opts.unshallow ?? []).map((oid) => ENCODER.encode(`unshallow ${oid}\n`));
  const shallowSection = encodePktStream([...shallowFrames, ...unshallowFrames]);
  const body = buildUploadPackResponseBody({ packBytes: opts.packBytes, sideBand: true });
  const out = new Uint8Array(shallowSection.length + body.length);
  out.set(shallowSection, 0);
  out.set(body, shallowSection.length);
  return out;
};

/**
 * Build a sideband-1 stream that splits `packBytes` into per-frame chunks of
 * `chunkSize`. Each chunk becomes its own channel-1 pkt-line, which means the
 * downstream `parseUploadPackResponse.packBody` iterator will yield one
 * Uint8Array per chunk — perfect for exercising drainPackBodyBounded's
 * multi-chunk path.
 */
const buildMultiChunkSidebandBody = (packBytes: Uint8Array, chunkSize: number): Uint8Array => {
  const payloads: Uint8Array[] = [ENCODER.encode('NAK\n')];
  for (let off = 0; off < packBytes.length; off += chunkSize) {
    const slice = packBytes.subarray(off, Math.min(off + chunkSize, packBytes.length));
    const framed = new Uint8Array(slice.length + 1);
    framed[0] = 0x01;
    framed.set(slice, 1);
    payloads.push(framed);
  }
  return encodePktStream(payloads);
};

const captureRequests = (
  body: Uint8Array,
): { transport: HttpTransport; requests: HttpRequest[] } => {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = {
    request: async (req): Promise<HttpResponse> => {
      requests.push(req);
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-result' },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body.slice());
            controller.close();
          },
        }),
      };
    },
  };
  return { transport, requests };
};

/**
 * Same as captureRequests but splits the response body into ~8 KiB chunks at
 * the ReadableStream layer. Forces the pkt-line decoder buffer to drain
 * incrementally — required for any test that wants to exercise the
 * drainPackBodyBounded multi-chunk path while sending a payload that exceeds
 * the pkt-line buffer capacity (~64 KiB).
 */
const captureRequestsChunked = (
  body: Uint8Array,
  chunkSize = 8192,
): { transport: HttpTransport; requests: HttpRequest[] } => {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = {
    request: async (req): Promise<HttpResponse> => {
      requests.push(req);
      const copy = body.slice();
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-result' },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            for (let off = 0; off < copy.length; off += chunkSize) {
              controller.enqueue(copy.subarray(off, Math.min(off + chunkSize, copy.length)));
            }
            controller.close();
          },
        }),
      };
    },
  };
  return { transport, requests };
};

/**
 * Adapt a fake `HttpTransport` fixture into the `GitExchange` shape `fetchPack`
 * now takes directly — URL/method/header building is the session's job (see
 * `git-service-session.test.ts`), this only bridges the request/response wire.
 */
const toExchange =
  (transport: HttpTransport): GitExchange =>
  async (requestBytes) => {
    const response = await transport.request({
      url: UPLOAD_PACK_URL,
      method: 'POST',
      headers: {
        'content-type': 'application/x-git-upload-pack-request',
        accept: 'application/x-git-upload-pack-result',
      },
      body: requestBytes,
    });
    return decodePktStream(readableStreamToAsyncIterable(response.body));
  };

// `fetchPack` now takes a version-bound negotiator rather than a raw
// exchange; wrapping the transport through the real v1 negotiator keeps
// every existing wire-level scenario below byte-identical to pre-change.
const toNegotiator =
  (transport: HttpTransport): NegotiatePackBytes =>
  (ctx, input) =>
    negotiatePackBytes(ctx, { exchange: toExchange(transport) }, 1, input);

type MemCtx = ReturnType<typeof createMemoryContext>;

const withConfig = (ctx: MemCtx, patch: Partial<NonNullable<MemCtx['config']>>): MemCtx =>
  ({ ...ctx, config: { ...(ctx.config ?? {}), ...patch } }) as MemCtx;

const withMaxResponseBytes = (ctx: MemCtx, max: number): MemCtx =>
  withConfig(ctx, { maxResponseBytes: max });

const withFsPatch = (ctx: MemCtx, patch: Partial<MemCtx['fs']>): MemCtx =>
  ({ ...ctx, fs: { ...ctx.fs, ...patch } }) as MemCtx;

/** Reframes a Context onto an `fs` that omits `atomicRename` — the browser
 *  adapter's own shape — while sharing the same underlying memory
 *  filesystem instance. */
const withoutAtomicRename = (ctx: MemCtx): MemCtx => {
  const { atomicRename: _atomicRename, ...rest } = ctx.fs;
  return { ...ctx, fs: rest } as MemCtx;
};

const packDir = (ctx: MemCtx): string => `${ctx.layout.gitDir}/objects/pack`;

const tmpPackNames = async (ctx: MemCtx): Promise<ReadonlyArray<string>> => {
  const dir = packDir(ctx);
  // A cap failure can reject before the pack directory is ever created —
  // no directory trivially means no leftover tmp file.
  if (!(await ctx.fs.exists(dir))) return [];
  const entries = await ctx.fs.readdir(dir);
  return entries.filter((e) => e.name.startsWith('tmp_pack_')).map((e) => e.name);
};

const computeBlobId = async (
  ctx: ReturnType<typeof createMemoryContext>,
  content: Uint8Array,
): Promise<string> => {
  const header = ENCODER.encode(`blob ${content.length}\0`);
  const loose = new Uint8Array(header.length + content.length);
  loose.set(header, 0);
  loose.set(content, header.length);
  return ctx.hash.hashHex(loose);
};

/**
 * Re-emit `packBytes` with its entries in the order specified by `newOrder`
 * (indices into the original entry table). Recomputes the trailer.
 * Used to test out-of-order REF_DELTA resolution.
 */
const reorderPackEntries = async (
  ctx: ReturnType<typeof createMemoryContext>,
  packBytes: Uint8Array,
  newOrder: ReadonlyArray<number>,
): Promise<Uint8Array> => {
  const { parsePackEntryHeader: parseEntry, parsePackHeader: parseHdr } = await import(
    '../../../../src/domain/storage/pack-entry.js'
  );
  const trailerLen = ctx.hash.digestLength;
  const header = parseHdr(packBytes);
  const trailerStart = packBytes.length - trailerLen;
  const entrySlices: Uint8Array[] = [];
  let off = 12;
  for (let i = 0; i < header.objectCount; i += 1) {
    const entryHeader = parseEntry(packBytes, off, ctx.hashConfig);
    const inflate = await ctx.compressor.streamInflate(packBytes, entryHeader.dataOffset);
    const end = entryHeader.dataOffset + inflate.bytesConsumed;
    entrySlices.push(packBytes.subarray(off, end));
    off = end;
  }
  if (off !== trailerStart) {
    throw new Error('reorderPackEntries: leftover bytes between entries and trailer');
  }
  const newHeader = packBytes.subarray(0, 12).slice();
  // header has objectCount at offset 8 — unchanged because we're permuting, not adding/removing.
  const chunks: Uint8Array[] = [newHeader];
  for (const idx of newOrder) {
    const slice = entrySlices[idx];
    if (slice === undefined) throw new Error(`reorderPackEntries: bad index ${idx}`);
    chunks.push(slice);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const body = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    body.set(c, pos);
    pos += c.length;
  }
  const trailerHex = await ctx.hash.hashHex(body);
  const trailerBytes = new Uint8Array(trailerLen);
  for (let i = 0; i < trailerLen; i += 1) {
    trailerBytes[i] = Number.parseInt(trailerHex.slice(i * 2, i * 2 + 2), 16);
  }
  const out = new Uint8Array(body.length + trailerBytes.length);
  out.set(body, 0);
  out.set(trailerBytes, body.length);
  return out;
};

/**
 * Deterministic pseudo-random bytes (xorshift32) — deflate cannot meaningfully
 * compress this, so a blob built from it produces a compressed pack entry
 * whose size tracks `length` almost 1:1. Used to force an entry's compressed
 * span past `DISK_WALK_WINDOW_BYTES` without depending on `Math.random`
 * (deterministic, reproducible test fixtures).
 */
const pseudoRandomBytes = (length: number, seed: number): Uint8Array => {
  let state = seed >>> 0 || 1;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 0xff;
  }
  return out;
};

/**
 * A pack that spans several `DISK_WALK_WINDOW_BYTES` windows without any
 * single entry coming anywhere near one window's size — used by the
 * multi-window flat-peak and window-reuse pins below. 12 entries at ~60 KB
 * each land comfortably past the second window boundary, so the walk both
 * crosses windows (proving the peak stays flat) and reuses a held window
 * across several entries per crossing (proving reuse, not one read per
 * entry).
 */
const MULTI_WINDOW_ENTRY_COUNT = 12;
const MULTI_WINDOW_ENTRY_BYTES = 60_000;

const buildMultiWindowPack = (
  ctx: ReturnType<typeof createMemoryContext>,
): Promise<Awaited<ReturnType<typeof buildSyntheticPack>>> => {
  const entries: EntrySpec[] = Array.from({ length: MULTI_WINDOW_ENTRY_COUNT }, (_, i) => ({
    kind: 'base',
    type: 'blob',
    content: pseudoRandomBytes(MULTI_WINDOW_ENTRY_BYTES, 2000 + i),
  }));
  return buildSyntheticPack(ctx, entries);
};

const buildSingleBlobPack = async (
  ctx: ReturnType<typeof createMemoryContext>,
  content: string,
): Promise<{ packBytes: Uint8Array; blobId: ObjectId; idxBytes: Uint8Array }> => {
  const entries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: ENCODER.encode(content) }];
  const built = await buildSyntheticPack(ctx, entries);
  return {
    packBytes: built.packBytes,
    blobId: built.ids[0] as ObjectId,
    idxBytes: built.idxBytes,
  };
};

describe('fetchPack', () => {
  describe('happy path', () => {
    describe('Given a single-blob side-band-1 pack', () => {
      describe('When fetchPack runs', () => {
        it('Then writes pack-<sha>.pack and.idx', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(`${ctx.layout.gitDir}/objects/pack`);
          const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'hello\n');
          const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const { transport, requests } = captureRequests(body);

          // Act
          const result = await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k', 'ofs-delta'],
            progressOp: 'test:write-objects',
          });

          // Assert
          const expectedTrailerHex = await ctx.hash.hashHex(packBytes.subarray(0, -20));
          expect(result.packSha).toBe(expectedTrailerHex);
          expect(result.objectCount).toBe(1);
          expect(result.packPath).toBe(
            `${ctx.layout.gitDir}/objects/pack/pack-${expectedTrailerHex}.pack`,
          );
          expect(result.idxPath).toBe(
            `${ctx.layout.gitDir}/objects/pack/pack-${expectedTrailerHex}.idx`,
          );
          const writtenPack = await ctx.fs.read(result.packPath);
          expect(writtenPack).toEqual(packBytes);
          const writtenIdx = await ctx.fs.read(result.idxPath);
          const parsedIdx = parsePackIndex(writtenIdx, 20);
          expect(parsedIdx.objectCount).toBe(1);
          expect(lookupPackIndex(parsedIdx, blobId)).toBeGreaterThanOrEqual(12);
          const parsedHeader = parsePackHeader(writtenPack);
          expect(parsedHeader.objectCount).toBe(1);
          expect(requests).toHaveLength(1);
          expect(requests[0]?.url).toBe(UPLOAD_PACK_URL);
          expect(requests[0]?.method).toBe('POST');
        });
      });
    });

    describe('Given a Context whose pack-registry was populated before the fetch', () => {
      describe('When fetchPack writes a pack and the object is read back', () => {
        it('Then the freshly-written object is readable (registry refreshed)', async () => {
          // Arrange — a prior failed read caches an empty pack-registry scan for
          // this Context. Without the post-write refresh, the just-fetched pack
          // would stay invisible (the failure `pull`'s merge step hit).
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(`${ctx.layout.gitDir}/objects/pack`);
          const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'fresh after fetch\n');
          let pre: unknown;
          try {
            await readObject(ctx, blobId);
          } catch (err) {
            pre = err;
          }
          expect((pre as { data?: { code?: string } })?.data?.code).toBe('OBJECT_NOT_FOUND');
          const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k', 'ofs-delta'],
            progressOp: 'test:write-objects',
          });
          const result = await readObject(ctx, blobId);

          // Assert
          expect(result.type).toBe('blob');
          expect(result.id).toBe(blobId);
        });
      });
    });
  });

  describe('partial clone', () => {
    describe('Given a filter', () => {
      describe('When fetchPack runs', () => {
        it('Then the request body carries a filter line', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(`${ctx.layout.gitDir}/objects/pack`);
          const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'hello\n');
          const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const { transport, requests } = captureRequests(body);

          // Act
          await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k', 'ofs-delta', 'filter'],
            progressOp: 'test:write-objects',
            filter: 'blob:none',
          });

          // Assert
          const sentBody = new TextDecoder().decode(requests[0]?.body);
          expect(sentBody).toContain('filter blob:none\n');
        });
      });
    });

    describe('Given promisor=true', () => {
      describe('When fetchPack runs', () => {
        it('Then an empty pack-<sha>.promisor sentinel is written', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(`${ctx.layout.gitDir}/objects/pack`);
          const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'promised\n');
          const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          const result = await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k', 'ofs-delta'],
            progressOp: 'test:write-objects',
            promisor: true,
          });

          // Assert
          const promisorPath = `${ctx.layout.gitDir}/objects/pack/pack-${result.packSha}.promisor`;
          expect(await ctx.fs.exists(promisorPath)).toBe(true);
          expect(await ctx.fs.read(promisorPath)).toEqual(new Uint8Array(0));
        });
      });
    });

    describe('Given promisor unset', () => {
      describe('When fetchPack runs', () => {
        it('Then no .promisor sentinel is written', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(`${ctx.layout.gitDir}/objects/pack`);
          const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'plain\n');
          const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          const result = await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k', 'ofs-delta'],
            progressOp: 'test:write-objects',
          });

          // Assert
          const promisorPath = `${ctx.layout.gitDir}/objects/pack/pack-${result.packSha}.promisor`;
          expect(await ctx.fs.exists(promisorPath)).toBe(false);
        });
      });
    });

    describe('Given an empty pack body and promisor=true', () => {
      describe('When fetchPack runs', () => {
        it('Then no .promisor sentinel is written', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(`${ctx.layout.gitDir}/objects/pack`);
          const { transport } = captureRequests(new Uint8Array(0));

          // Act
          const result = await fetchPack(ctx, toNegotiator(transport), {
            wants: ['a'.repeat(40) as ObjectId],
            haves: [],
            capabilities: ['side-band-64k', 'ofs-delta'],
            progressOp: 'test:write-objects',
            promisor: true,
          });

          // Assert — a zero-entry pack suppresses the whole artefact set
          // before reaching the writer, so no `.idx` means no `.rev` either.
          expect(result.packPath).toBe('');
          const packDir = await ctx.fs.readdir(`${ctx.layout.gitDir}/objects/pack`);
          expect(packDir.some((e) => e.name.endsWith('.promisor'))).toBe(false);
          expect(packDir.some((e) => e.name.endsWith('.rev'))).toBe(false);
        });
      });
    });
  });

  describe('delta resolution', () => {
    describe('Given a base + OFS_DELTA pack', () => {
      describe('When fetchPack runs', () => {
        it('Then both ids appear in the.idx', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const baseContent = ENCODER.encode('base content\n');
          const targetContent = ENCODER.encode('target content\n');
          const entries: EntrySpec[] = [
            { kind: 'base', type: 'blob', content: baseContent },
            { kind: 'ofs-delta', baseIndex: 0, targetContent },
          ];
          const built = await buildSyntheticPack(ctx, entries);
          const body = buildUploadPackResponseBody({ packBytes: built.packBytes, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          const result = await fetchPack(ctx, toNegotiator(transport), {
            wants: [built.ids[0] as ObjectId],
            haves: [],
            capabilities: ['side-band-64k', 'ofs-delta'],
            progressOp: 'test:write-objects',
          });

          // Assert
          expect(result.objectCount).toBe(2);
          const idxBytes = await ctx.fs.read(result.idxPath);
          const idx = parsePackIndex(idxBytes, 20);
          expect(idx.objectCount).toBe(2);
          expect(lookupPackIndex(idx, built.ids[0] as ObjectId)).toBeGreaterThanOrEqual(12);
          expect(lookupPackIndex(idx, built.ids[1] as ObjectId)).toBeGreaterThanOrEqual(12);
        });
      });
    });

    describe('Given a base + REF_DELTA pack (base first)', () => {
      describe('When fetchPack runs', () => {
        it('Then resolves the delta in first pass', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const baseContent = ENCODER.encode('ref delta base\n');
          const targetContent = ENCODER.encode('ref delta target\n');
          const baseId = await computeBlobId(ctx, baseContent);
          const entries: EntrySpec[] = [
            { kind: 'base', type: 'blob', content: baseContent },
            { kind: 'ref-delta', baseId, baseUncompressed: baseContent, targetContent },
          ];
          const built = await buildSyntheticPack(ctx, entries);
          const body = buildUploadPackResponseBody({ packBytes: built.packBytes, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          const result = await fetchPack(ctx, toNegotiator(transport), {
            wants: [built.ids[0] as ObjectId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });

          // Assert
          expect(result.objectCount).toBe(2);
          const idx = parsePackIndex(await ctx.fs.read(result.idxPath), 20);
          expect(idx.objectCount).toBe(2);
          expect(lookupPackIndex(idx, built.ids[1] as ObjectId)).toBeGreaterThanOrEqual(12);
        });
      });
    });

    describe('Given a REF_DELTA before its base (out-of-order)', () => {
      describe('When fetchPack runs', () => {
        it('Then resolves via the deferred pass', async () => {
          // Arrange — manually compose a pack where REF_DELTA appears at offset 12 and its base after.
          const ctx = createMemoryContext();
          const baseContent = ENCODER.encode('out-of-order base\n');
          const targetContent = ENCODER.encode('out-of-order target\n');
          const baseId = await computeBlobId(ctx, baseContent);
          // Build in normal order to compute the base id, then re-assemble the pack with REF_DELTA first.
          const normal = await buildSyntheticPack(ctx, [
            { kind: 'base', type: 'blob', content: baseContent },
            { kind: 'ref-delta', baseId, baseUncompressed: baseContent, targetContent },
          ]);
          const reordered = await reorderPackEntries(ctx, normal.packBytes, [1, 0]);
          const body = buildUploadPackResponseBody({ packBytes: reordered, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          const result = await fetchPack(ctx, toNegotiator(transport), {
            wants: [normal.ids[0] as ObjectId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });

          // Assert
          expect(result.objectCount).toBe(2);
          const idx = parsePackIndex(await ctx.fs.read(result.idxPath), 20);
          expect(lookupPackIndex(idx, normal.ids[0] as ObjectId)).toBeGreaterThanOrEqual(12);
          expect(lookupPackIndex(idx, normal.ids[1] as ObjectId)).toBeGreaterThanOrEqual(12);
        });
      });
    });

    describe('Given an OFS_DELTA pointing before the pack body', () => {
      describe('When fetchPack runs', () => {
        it("Then throws INVALID_PACK_ENTRY naming the offset and git's out-of-bound reason", async () => {
          // Arrange — synthesize a pack with one entry whose OFS_DELTA distance is
          // larger than its own offset minus the 12-byte header. Real packs cannot
          // produce such an entry; we craft it directly to exercise the
          // out-of-bound base-offset guard the record store applies while
          // scanning. The entry header is hand-built:
          // type-byte sets OFS_DELTA(=6) with a 1-byte declared size of 2 (matching
          // the 2-byte delta payload below), the distance varint encodes 100, then
          // a 2-byte zlib stream for an empty target.
          const ctx = createMemoryContext();
          // Pack header (12 bytes) — version 2, 1 entry.
          const header = new Uint8Array(12);
          const dv = new DataView(header.buffer);
          dv.setUint32(0, 0x5041434b);
          dv.setUint32(4, 2);
          dv.setUint32(8, 1);
          // Entry header: type=6 (OFS_DELTA), size=2 → byte = (6 << 4) | 2 = 0x62.
          // Distance = 100, encoded as a single byte 0x64 (no continuation).
          const entryHeader = new Uint8Array([0x62, 0x64]);
          // zlib-compressed body for an empty delta payload (sourceLength=0, targetLength=0).
          const emptyDelta = new Uint8Array([0x00, 0x00]);
          const zlibBody = await ctx.compressor.deflate(emptyDelta);
          // Build the full pack: header + entry + trailer.
          const bodyBytes = new Uint8Array(header.length + entryHeader.length + zlibBody.length);
          bodyBytes.set(header, 0);
          bodyBytes.set(entryHeader, header.length);
          bodyBytes.set(zlibBody, header.length + entryHeader.length);
          const trailerHex = await ctx.hash.hashHex(bodyBytes);
          const packBytes = new Uint8Array(bodyBytes.length + 20);
          packBytes.set(bodyBytes, 0);
          packBytes.set(hexToBytes(trailerHex), bodyBytes.length);
          const dummyId = (await computeBlobId(ctx, ENCODER.encode('ofs-back\n'))) as ObjectId;
          const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          let caught: unknown;
          try {
            await fetchPack(ctx, toNegotiator(transport), {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert — the OFS guard is now the same widened, git-faithful
          // out-of-bound check for every out-of-range distance (negative,
          // self-referential, or forward of the entry's own offset), so the
          // offset is no longer named in the reason.
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string; reason?: string };
          expect(data.code).toBe('INVALID_PACK_ENTRY');
          expect(data.reason).toBe('delta base offset is out of bound');
        });
      });
    });

    describe('Given a REF_DELTA whose base is not in the pack', () => {
      describe('When fetchPack runs', () => {
        it('Then throws "pack has 1 unresolved delta"', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const baseContent = ENCODER.encode('orphan base\n');
          const targetContent = ENCODER.encode('orphan target\n');
          const unknownBaseId = await computeBlobId(ctx, ENCODER.encode('not in pack\n'));
          // The pack contains only the REF_DELTA — no base. uncompressed base content
          // is only used by the fixture's delta-encoder to declare sourceLength.
          const built = await buildSyntheticPack(ctx, [
            {
              kind: 'ref-delta',
              baseId: unknownBaseId,
              baseUncompressed: baseContent,
              targetContent,
            },
          ]);
          const body = buildUploadPackResponseBody({ packBytes: built.packBytes, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          let caught: unknown;
          try {
            await fetchPack(ctx, toNegotiator(transport), {
              wants: [unknownBaseId as ObjectId],
              haves: [],
              capabilities: ['side-band-64k'],
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert — git's own count, singular at one; the base id is no
          // longer named (a root-down walk discovers unresolved entries as
          // a set, not in queue order, so naming "the first" would be an
          // arbitrary choice this design does not make).
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string; reason?: string };
          expect(data.code).toBe('INVALID_PACK_HEADER');
          expect(data.reason).toBe('pack has 1 unresolved delta');
        });
      });
    });

    describe("Given a REF_DELTA cycle with no base entry (two deltas naming each other's target oid)", () => {
      describe('When fetchPack runs', () => {
        it('Then throws "pack has 2 unresolved deltas"', async () => {
          // Arrange — neither entry has a base entry to resolve from, so
          // pass 2's root loop finds zero roots and neither delta is ever
          // reached, regardless of what oid each declares as its base. This
          // pins the plural template arm against a genuinely two-unresolved
          // input, not a doubled one-unresolved case.
          const ctx = createMemoryContext();
          const targetA = ENCODER.encode('ref-cycle target A');
          const targetB = ENCODER.encode('ref-cycle target B');
          const idOfA = await computeBlobId(ctx, targetA);
          const idOfB = await computeBlobId(ctx, targetB);
          const built = await buildSyntheticPack(ctx, [
            {
              kind: 'ref-delta',
              baseId: idOfB,
              baseUncompressed: new Uint8Array(0),
              targetContent: targetA,
            },
            {
              kind: 'ref-delta',
              baseId: idOfA,
              baseUncompressed: new Uint8Array(0),
              targetContent: targetB,
            },
          ]);
          const body = buildUploadPackResponseBody({ packBytes: built.packBytes, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          let caught: unknown;
          try {
            await fetchPack(ctx, toNegotiator(transport), {
              wants: [idOfA as ObjectId],
              haves: [],
              capabilities: ['side-band-64k'],
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string; reason?: string };
          expect(data.code).toBe('INVALID_PACK_HEADER');
          expect(data.reason).toBe('pack has 2 unresolved deltas');
        });
      });
    });

    describe('Given an OFS_DELTA whose base offset lands strictly inside another entry, not at its start', () => {
      describe('When fetchPack runs', () => {
        it('Then throws "pack has 1 unresolved delta" — mid-entry landing is a count, not the out-of-bound guard', async () => {
          // Arrange — two independent base entries, then an OFS_DELTA whose
          // declared distance is computed from a probe build so it targets
          // one byte INSIDE entry B rather than at any real entry's start.
          // That base offset passes `recordOfsDelta`'s range guard (it is
          // >= PACK_HEADER_SIZE and < the delta's own offset) but never
          // matches a real entry's stored offset, so it can only ever
          // surface through the unresolved-delta count.
          const ctx = createMemoryContext();
          const midEntrySpecs: EntrySpec[] = [
            { kind: 'base', type: 'blob', content: ENCODER.encode('mid-entry base A') },
            { kind: 'base', type: 'blob', content: ENCODER.encode('mid-entry base B') },
          ];
          const probe = await buildSyntheticPack(ctx, [
            ...midEntrySpecs,
            {
              kind: 'ofs-delta',
              baseIndex: 0,
              targetContent: ENCODER.encode('mid-entry delta target'),
            },
          ]);
          const entryBOffset = probe.offsets[1] as number;
          const deltaOffset = probe.offsets[2] as number;
          const midEntryDistance = deltaOffset - (entryBOffset + 1);
          const built = await buildSyntheticPack(ctx, [
            ...midEntrySpecs,
            {
              kind: 'ofs-delta',
              baseIndex: 0,
              targetContent: ENCODER.encode('mid-entry delta target'),
              distanceOverride: midEntryDistance,
            },
          ]);
          const body = buildUploadPackResponseBody({ packBytes: built.packBytes, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          let caught: unknown;
          try {
            await fetchPack(ctx, toNegotiator(transport), {
              wants: [built.ids[0] as ObjectId],
              haves: [],
              capabilities: ['side-band-64k'],
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string; reason?: string };
          expect(data.code).toBe('INVALID_PACK_HEADER');
          expect(data.reason).toBe('pack has 1 unresolved delta');
        });
      });
    });

    describe('Given two base entries sharing the same oid, with one REF_DELTA child of that shared oid', () => {
      describe('When fetchPack indexes the quarantined pack from disk', () => {
        it('Then the shared child is applied exactly once — resolvedCount never overshoots objectCount', async () => {
          // Arrange — two identical-content base blobs (same oid by
          // construction) followed by a REF_DELTA whose declared base is
          // that shared oid. Pass 2 discovers this delta as a child of BOTH
          // duplicate roots — `refChildren` is keyed on oid VALUE, not on
          // which root asked — so the `isResolved` guard is the only thing
          // stopping the second discovery from re-applying it.
          const ctx = createMemoryContext();
          const sharedContent = ENCODER.encode('duplicate-oid shared base content');
          const sharedId = await computeBlobId(ctx, sharedContent);
          const entries: EntrySpec[] = [
            { kind: 'base', type: 'blob', content: sharedContent },
            { kind: 'base', type: 'blob', content: sharedContent },
            {
              kind: 'ref-delta',
              baseId: sharedId,
              baseUncompressed: sharedContent,
              targetContent: ENCODER.encode('duplicate-oid shared child target'),
            },
          ];
          const built = await buildSyntheticPack(ctx, entries);
          const body = buildMultiChunkSidebandBody(built.packBytes, 32_768);
          const { transport } = captureRequests(body);
          createPackRecordStoreSpy.mockClear();

          // Act
          const result = await fetchPack(ctx, toNegotiator(transport), {
            wants: [built.ids[0] as ObjectId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });

          // Assert
          expect(result.objectCount).toBe(3);
          expect(createPackRecordStoreSpy).toHaveBeenCalledTimes(1);
          const store = createPackRecordStoreSpy.mock.results[0]?.value as ReturnType<
            typeof packRecordsModule.createPackRecordStore
          >;
          expect(store.resolvedCount).toBe(3);
        });
      });
    });
  });

  describe('failure modes', () => {
    describe('Given no wants', () => {
      describe('When fetchPack runs', () => {
        it('Then throws EMPTY_WANTS and never reaches the transport', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const { transport, requests } = captureRequests(new Uint8Array(0));

          // Act
          let caught: unknown;
          try {
            await fetchPack(ctx, toNegotiator(transport), {
              wants: [],
              haves: [],
              capabilities: [],
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('EMPTY_WANTS');
          // The wants check lives in `buildUploadPackRequest`; it must fire BEFORE
          // any transport request is issued.
          expect(requests).toHaveLength(0);
        });
      });
    });

    describe('Given a pack shorter than header + trailer', () => {
      describe('When fetchPack runs', () => {
        it('Then throws INVALID_PACK_HEADER (too short)', async () => {
          // Arrange — 31 bytes is one byte short of the SHA-1 minimum (12-byte header + 20-byte trailer).
          const ctx = createMemoryContext();
          const blobId = (await computeBlobId(ctx, ENCODER.encode('short\n'))) as ObjectId;
          const tooShort = new Uint8Array(31);
          const dv = new DataView(tooShort.buffer);
          dv.setUint32(0, 0x5041434b);
          dv.setUint32(4, 2);
          dv.setUint32(8, 0);
          const body = buildUploadPackResponseBody({ packBytes: tooShort, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          let caught: unknown;
          try {
            await fetchPack(ctx, toNegotiator(transport), {
              wants: [blobId],
              haves: [],
              capabilities: ['side-band-64k'],
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string; reason?: string };
          expect(data.code).toBe('INVALID_PACK_HEADER');
          expect(data.reason).toContain('trailer');
          expect(data.reason).toContain('too short');
        });
      });
    });

    describe('Given a pack exactly 32 bytes (empty pack canonical minimum)', () => {
      describe('When fetchPack runs', () => {
        it('Then accepts it', async () => {
          // Arrange — boundary: 12-byte header + 20-byte trailer = 32 bytes. One byte
          // longer than the short test above. Together these pin the `<` vs `<=`
          // mutant on the trailer-length guard.
          const ctx = createMemoryContext();
          const dummyId = (await computeBlobId(ctx, ENCODER.encode('dummy\n'))) as ObjectId;
          const header = new Uint8Array(12);
          const dv = new DataView(header.buffer);
          dv.setUint32(0, 0x5041434b);
          dv.setUint32(4, 2);
          dv.setUint32(8, 0);
          const trailerBytes = hexToBytes(await ctx.hash.hashHex(header));
          const packBytes = new Uint8Array(32);
          packBytes.set(header, 0);
          packBytes.set(trailerBytes, 12);
          const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          const result = await fetchPack(ctx, toNegotiator(transport), {
            wants: [dummyId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });

          // Assert
          expect(result.objectCount).toBe(0);
        });
      });
    });

    describe('Given objectCount > default cap', () => {
      describe('When fetchPack runs', () => {
        it('Then throws PACK_TOO_LARGE before iterating entries', async () => {
          // Arrange — craft a pack header that lies about the entry count.
          const ctx = createMemoryContext();
          const dummyId = (await computeBlobId(ctx, ENCODER.encode('lie\n'))) as ObjectId;
          const header = new Uint8Array(12);
          const dv = new DataView(header.buffer);
          dv.setUint32(0, 0x5041434b);
          dv.setUint32(4, 2);
          dv.setUint32(8, 60_000_000); // beyond the 50_000_000 default
          const trailerBytes = hexToBytes(await ctx.hash.hashHex(header));
          const packBytes = new Uint8Array(32);
          packBytes.set(header, 0);
          packBytes.set(trailerBytes, 12);
          const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          let caught: unknown;
          try {
            await fetchPack(ctx, toNegotiator(transport), {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as {
            code: string;
            objectCount?: number;
            limit?: number;
          };
          expect(data.code).toBe('PACK_TOO_LARGE');
          expect(data.objectCount).toBe(60_000_000);
          expect(data.limit).toBe(50_000_000);
        });
      });
    });

    describe('Given pack count exactly equal to cap', () => {
      describe('When fetchPack runs', () => {
        it('Then does NOT throw (boundary: > vs >=)', async () => {
          // Arrange — declare exactly `maxObjectsPerPack` entries. The cap guard is
          // `objectCount > cap`, so equality must NOT trigger the throw. The pack
          // is otherwise empty so the walker will error on missing entries, but it
          // must error *past* the cap check — proving the boundary lives on `>`,
          // not `>=`.
          const baseCtx = createMemoryContext();
          const dummyId = (await computeBlobId(baseCtx, ENCODER.encode('boundary\n'))) as ObjectId;
          const header = new Uint8Array(12);
          const dv = new DataView(header.buffer);
          dv.setUint32(0, 0x5041434b);
          dv.setUint32(4, 2);
          dv.setUint32(8, 7); // exactly the cap
          const trailerBytes = hexToBytes(await baseCtx.hash.hashHex(header));
          const packBytes = new Uint8Array(32);
          packBytes.set(header, 0);
          packBytes.set(trailerBytes, 12);
          const ctx = withConfig(baseCtx, { maxObjectsPerPack: 7 });
          const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          let caught: unknown;
          try {
            await fetchPack(ctx, toNegotiator(transport), {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert — error must be a later-stage failure, NOT PACK_TOO_LARGE.
          expect(caught).toBeInstanceOf(TsgitError);
          const code = (caught as TsgitError).data.code;
          expect(code).not.toBe('PACK_TOO_LARGE');
        });
      });
    });

    describe('Given pack count exactly cap + 1', () => {
      describe('When fetchPack runs', () => {
        it('Then throws PACK_TOO_LARGE (boundary: pinpoint the > side)', async () => {
          // Arrange — counterpart to the previous test: cap+1 must throw.
          const baseCtx = createMemoryContext();
          const dummyId = (await computeBlobId(
            baseCtx,
            ENCODER.encode('boundary+1\n'),
          )) as ObjectId;
          const header = new Uint8Array(12);
          const dv = new DataView(header.buffer);
          dv.setUint32(0, 0x5041434b);
          dv.setUint32(4, 2);
          dv.setUint32(8, 8); // cap + 1
          const trailerBytes = hexToBytes(await baseCtx.hash.hashHex(header));
          const packBytes = new Uint8Array(32);
          packBytes.set(header, 0);
          packBytes.set(trailerBytes, 12);
          const ctx = withConfig(baseCtx, { maxObjectsPerPack: 7 });
          const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          let caught: unknown;
          try {
            await fetchPack(ctx, toNegotiator(transport), {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect((caught as TsgitError).data.code).toBe('PACK_TOO_LARGE');
          expect((caught as TsgitError).data).toMatchObject({ objectCount: 8, limit: 7 });
        });
      });
    });

    describe('Given config.maxObjectsPerPack < pack count', () => {
      describe('When fetchPack runs', () => {
        it('Then enforces the caller cap', async () => {
          // Arrange — pack lies about having 100 entries; caller caps at 10.
          const baseCtx = createMemoryContext();
          const dummyId = (await computeBlobId(baseCtx, ENCODER.encode('hardened\n'))) as ObjectId;
          const header = new Uint8Array(12);
          const dv = new DataView(header.buffer);
          dv.setUint32(0, 0x5041434b);
          dv.setUint32(4, 2);
          dv.setUint32(8, 100);
          const trailerBytes = hexToBytes(await baseCtx.hash.hashHex(header));
          const packBytes = new Uint8Array(32);
          packBytes.set(header, 0);
          packBytes.set(trailerBytes, 12);
          const ctx = withConfig(baseCtx, { maxObjectsPerPack: 10 });
          const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          let caught: unknown;
          try {
            await fetchPack(ctx, toNegotiator(transport), {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as {
            code: string;
            objectCount?: number;
            limit?: number;
          };
          expect(data.code).toBe('PACK_TOO_LARGE');
          expect(data.objectCount).toBe(100);
          expect(data.limit).toBe(10);
        });
      });
    });

    describe('Given a pack declaring 50,000,000 entries but containing only 3 real ones', () => {
      describe('When fetchPack indexes the quarantined pack from disk', () => {
        it('Then the record store is sized from the pack bytes, not the declared count', async () => {
          // Arrange — 3 real base entries, then the header's declared count
          // is overwritten to a huge, server-controlled lie and the trailer
          // recomputed so the pack still verifies. `maxObjectsPerPack` is
          // raised well above the lie so PACK_TOO_LARGE never fires — this
          // pins that nothing downstream of THAT gate ever sizes an
          // allocation from `header.objectCount` either.
          const baseCtx = createMemoryContext();
          const entries: EntrySpec[] = [
            { kind: 'base', type: 'blob', content: ENCODER.encode('r3 entry one') },
            { kind: 'base', type: 'blob', content: ENCODER.encode('r3 entry two') },
            { kind: 'base', type: 'blob', content: ENCODER.encode('r3 entry three') },
          ];
          const built = await buildSyntheticPack(baseCtx, entries);
          const mutated = built.packBytes.slice();
          new DataView(mutated.buffer).setUint32(8, 50_000_000);
          const trailerLength = baseCtx.hash.digestLength;
          const bodyLength = mutated.length - trailerLength;
          const trailerHex = await baseCtx.hash.hashHex(mutated.subarray(0, bodyLength));
          mutated.set(hexToBytes(trailerHex), bodyLength);
          const ctx = withConfig(baseCtx, { maxObjectsPerPack: 60_000_000 });
          const body = buildMultiChunkSidebandBody(mutated, 32_768);
          const { transport } = captureRequests(body);
          createPackRecordStoreSpy.mockClear();

          // Act
          let caught: unknown;
          try {
            await fetchPack(ctx, toNegotiator(transport), {
              wants: [built.ids[0] as ObjectId],
              haves: [],
              capabilities: ['side-band-64k'],
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert — the walk refuses once it runs past the 3 real entries
          // into the trailer bytes (the exact refusal shape is incidental;
          // the load-bearing assertion is the capacity spy below)...
          expect(caught).toBeInstanceOf(TsgitError);
          // ...and the record store's own capacity was never sized from the
          // declared 50,000,000 — its second constructor argument (the
          // structural clamp) is proportional to the pack's real byte
          // length instead.
          expect(createPackRecordStoreSpy).toHaveBeenCalledTimes(1);
          const [, structuralMax] = createPackRecordStoreSpy.mock.calls[0] as [number, number];
          // The exact clamp, recomputed here rather than bounded loosely: a
          // slack bound survives a wrong minimum-entry size and survives
          // dropping either subtracted term.
          const PACK_HEADER_BYTES = 12;
          const MIN_ENTRY_BYTES = 9;
          expect(structuralMax).toBe(
            Math.floor((mutated.length - PACK_HEADER_BYTES - trailerLength) / MIN_ENTRY_BYTES),
          );
        });
      });
    });

    describe('Given a corrupted trailer', () => {
      describe('When fetchPack runs', () => {
        it('Then throws INVALID_PACK_HEADER with trailer in reason', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'corrupt me\n');
          const corrupted = packBytes.slice();
          corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 0xff;
          const body = buildUploadPackResponseBody({ packBytes: corrupted, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          let caught: unknown;
          try {
            await fetchPack(ctx, toNegotiator(transport), {
              wants: [blobId],
              haves: [],
              capabilities: ['side-band-64k'],
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string; reason?: string };
          expect(data.code).toBe('INVALID_PACK_HEADER');
          expect(data.reason).toContain('trailer');
        });
      });
    });

    describe('Given an empty pack (0 objects)', () => {
      describe('When fetchPack runs', () => {
        it('Then suppresses the pack/idx artifacts', async () => {
          // Arrange — assemble a 12-byte header with objectCount=0 + 20-byte trailer.
          const ctx = createMemoryContext();
          await ctx.fs.mkdir(`${ctx.layout.gitDir}/objects/pack`);
          const dummyId = (await computeBlobId(ctx, ENCODER.encode('dummy\n'))) as ObjectId;
          const header = new Uint8Array(12);
          const dv = new DataView(header.buffer);
          dv.setUint32(0, 0x5041434b);
          dv.setUint32(4, 2);
          dv.setUint32(8, 0);
          const trailerHex = await ctx.hash.hashHex(header);
          const trailerBytes = hexToBytes(trailerHex);
          const packBytes = new Uint8Array(header.length + trailerBytes.length);
          packBytes.set(header, 0);
          packBytes.set(trailerBytes, header.length);
          const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          const result = await fetchPack(ctx, toNegotiator(transport), {
            wants: [dummyId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });

          // Assert
          expect(result.objectCount).toBe(0);
          expect(result.packPath).toBe('');
          expect(result.idxPath).toBe('');
          const packDir = await ctx.fs.readdir(`${ctx.layout.gitDir}/objects/pack`);
          expect(packDir).toHaveLength(0);
        });
      });
    });

    describe('Given a pack whose header declares 0 objects but the trailer does not match', () => {
      describe('When fetchPack runs', () => {
        it('Then throws INVALID_PACK_HEADER instead of silently suppressing it', async () => {
          // Arrange — objectCount=0 makes this look like a legitimate empty pack,
          // but the trailer is garbage. Pins that verification runs BEFORE the
          // empty-pack suppression check, not instead of it.
          const ctx = createMemoryContext();
          const dummyId = (await computeBlobId(ctx, ENCODER.encode('dummy\n'))) as ObjectId;
          const header = new Uint8Array(12);
          const dv = new DataView(header.buffer);
          dv.setUint32(0, 0x5041434b);
          dv.setUint32(4, 2);
          dv.setUint32(8, 0);
          const trailerBytes = new Uint8Array(20).fill(0xff);
          const packBytes = new Uint8Array(header.length + trailerBytes.length);
          packBytes.set(header, 0);
          packBytes.set(trailerBytes, header.length);
          const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          let caught: unknown;
          try {
            await fetchPack(ctx, toNegotiator(transport), {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string; reason?: string };
          expect(data.code).toBe('INVALID_PACK_HEADER');
          expect(data.reason).toContain('trailer mismatch');
        });
      });
    });

    describe('Given maxResponseBytes one byte over the pack size', () => {
      describe('When fetchPack runs', () => {
        it('Then succeeds', async () => {
          // Arrange
          const baseCtx = createMemoryContext();
          const { packBytes, blobId } = await buildSingleBlobPack(baseCtx, 'tight cap\n');
          const tightCtx = withMaxResponseBytes(baseCtx, packBytes.length + 1);
          const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          const result = await fetchPack(tightCtx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });

          // Assert
          expect(result.objectCount).toBe(1);
        });
      });
    });

    describe('Given maxResponseBytes equal to the pack size', () => {
      describe('When fetchPack runs', () => {
        it('Then succeeds (boundary)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'exact cap\n');
          const exactCtx = withMaxResponseBytes(ctx, packBytes.length);
          const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          const result = await fetchPack(exactCtx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });

          // Assert
          expect(result.objectCount).toBe(1);
        });
      });
    });

    describe('Given maxResponseBytes one byte under the pack size', () => {
      describe('When fetchPack runs', () => {
        it('Then throws PACK_TOO_LARGE', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'over cap\n');
          const overCtx = withMaxResponseBytes(ctx, packBytes.length - 1);
          const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          let caught: unknown;
          try {
            await fetchPack(overCtx, toNegotiator(transport), {
              wants: [blobId],
              haves: [],
              capabilities: ['side-band-64k'],
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as {
            code: string;
            objectCount?: number;
            limit?: number;
          };
          expect(data.code).toBe('PACK_TOO_LARGE');
          expect(data.limit).toBe(packBytes.length - 1);
          // Byte-cap path sets objectCount=0 (no entries parsed yet) so the count
          // is unambiguous when consumers distinguish byte-cap from entry-cap.
          expect(data.objectCount).toBe(0);
        });
      });
    });

    describe('Given no side-band capability', () => {
      describe('When fetchPack runs', () => {
        it('Then drains the raw pack body and writes both files', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'no sideband\n');
          const body = buildUploadPackResponseBody({ packBytes, sideBand: false });
          const { transport } = captureRequests(body);

          // Act
          const result = await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: [], // no side-band advertised
            progressOp: 'test:write-objects',
          });

          // Assert
          expect(result.objectCount).toBe(1);
          const written = await ctx.fs.read(result.packPath);
          expect(written).toEqual(packBytes);
        });
      });
    });
  });

  describe('HTTP request shape', () => {
    describe('Given a successful clone', () => {
      describe('When fetchPack runs', () => {
        it('Then issues POST with smart-HTTP headers and a `done` body', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'request shape\n');
          const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const { transport, requests } = captureRequests(body);

          // Act
          await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });

          // Assert
          expect(requests).toHaveLength(1);
          const req = requests[0];
          expect(req?.method).toBe('POST');
          expect(req?.url).toBe(UPLOAD_PACK_URL);
          expect(req?.headers['content-type']).toBe('application/x-git-upload-pack-request');
          expect(req?.headers.accept).toBe('application/x-git-upload-pack-result');
          const decoded = new TextDecoder().decode(req?.body);
          // `done: true` adds the literal "done\n" pkt-line at the end.
          expect(decoded).toContain('done\n');
          // The first want line is the blob id.
          expect(decoded).toContain(`want ${blobId}`);
        });
      });
    });

    describe('Given a pack split across two sideband-1 frames', () => {
      describe('When fetchPack runs', () => {
        it('Then the concatenated bytes match the original', async () => {
          // Arrange — split a valid 1-blob pack into two sideband-1 frames so the
          // drain loop runs the concat path with multiple chunks. Pins the
          // `off += c.byteLength` accumulator: a `-=` mutant would write the
          // second chunk at a negative offset and throw RangeError, OR (if it
          // somehow succeeds) corrupt the output bytes.
          const ctx = createMemoryContext();
          const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'multi-chunk concat\n');
          const halfPoint = Math.floor(packBytes.length / 2);
          const frame1 = packBytes.subarray(0, halfPoint);
          const frame2 = packBytes.subarray(halfPoint);
          const wrap = (bytes: Uint8Array): Uint8Array => {
            const out = new Uint8Array(bytes.length + 1);
            out[0] = 0x01;
            out.set(bytes, 1);
            return out;
          };
          const body = encodePktStream([ENCODER.encode('NAK\n'), wrap(frame1), wrap(frame2)]);
          const { transport } = captureRequests(body);

          // Act
          const result = await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });

          // Assert — verifies the post-drain concat (off +=...) is correct.
          const written = await ctx.fs.read(result.packPath);
          expect(written).toEqual(packBytes);
          expect(result.objectCount).toBe(1);
        });
      });
    });
  });

  describe('base entry type coverage', () => {
    describe('Given a base entry of type %s', () => {
      describe('When fetchPack runs', () => {
        it.each([
          [
            'commit',
            `tree ${'0'.repeat(40)}\nauthor a <a@a> 0 +0000\ncommitter a <a@a> 0 +0000\n\nmsg\n`,
          ],
          ['tree', ''],
          ['tag', `object ${'0'.repeat(40)}\ntype commit\ntag t\ntagger a <a@a> 0 +0000\n\nm\n`],
        ] as const)('Then the .idx surfaces its id', async (type, content) => {
          // Arrange — synthesize a pack containing one entry of `type`.
          const ctx = createMemoryContext();
          const built = await buildSyntheticPack(ctx, [
            { kind: 'base', type, content: ENCODER.encode(content) },
          ]);
          const body = buildUploadPackResponseBody({ packBytes: built.packBytes, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          const result = await fetchPack(ctx, toNegotiator(transport), {
            wants: [built.ids[0] as ObjectId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });

          // Assert
          const idx = parsePackIndex(await ctx.fs.read(result.idxPath), 20);
          expect(idx.objectCount).toBe(1);
          expect(lookupPackIndex(idx, built.ids[0] as ObjectId)).toBeGreaterThanOrEqual(12);
        });
      });
    });
  });

  describe('progress reporting', () => {
    describe('Given a pack split into multi-chunks >= the tick threshold', () => {
      describe('When fetchPack runs', () => {
        it('Then byte-count update events fire mid-stream', async () => {
          // Arrange — build a synthetic empty pack (objectCount=0). Stream it via
          // sideband-1 frames sized just under the 64 KiB progress tick. With 3
          // such frames the cumulative byte count crosses the tick boundary at
          // least once mid-drain, then once more at flush. Pack stays at 32 bytes
          // (header + trailer) so the entry walker doesn't care about content; the
          // drain loop is what we're probing.
          //
          // Memory-adapter caveat: the streamInflate cap (64 KiB on the input
          // slice) means we can't run a real multi-entry pack > 64 KiB through
          // this path. Padding the empty pack is the lever we have available.
          const { reporter, events } = recordingProgress();
          const ctx = withProgress(createMemoryContext(), reporter);
          const dummyId = (await computeBlobId(ctx, ENCODER.encode('chunked\n'))) as ObjectId;
          // Build a "stretched" header — 12-byte header + 200_000 zero bytes of
          // pseudo-content + 20-byte trailer. The walker will reject this (extra
          // bytes), but drainPackBodyBounded runs first and emits ticks. We catch
          // the throw and assert on the recorded events.
          const stretched = new Uint8Array(12 + 200_000 + 20);
          const dv = new DataView(stretched.buffer);
          dv.setUint32(0, 0x5041434b);
          dv.setUint32(4, 2);
          dv.setUint32(8, 0);
          const trailerBytes = hexToBytes(await ctx.hash.hashHex(stretched.subarray(0, -20)));
          stretched.set(trailerBytes, stretched.length - 20);
          const body = buildMultiChunkSidebandBody(stretched, 50_000);
          const { transport } = captureRequestsChunked(body);

          // Act
          let caught: unknown;
          try {
            await fetchPack(ctx, toNegotiator(transport), {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert — the walker must reject the stretched-no-entry pack with the
          // "extra bytes" reason. Skipping this check would let the
          // `if (offset !== trailerStart)` guard mutate away.
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string; reason?: string };
          expect(data.code).toBe('INVALID_PACK_HEADER');
          expect(data.reason).toContain('extra bytes');
          const numericUpdates = events.filter(
            (e): e is { kind: 'update'; op: string; current: number } =>
              e.kind === 'update' && typeof e.current === 'number' && e.current > 0,
          );
          // At least one mid-stream tick must fire (50_000 bytes is below the
          // 65_536 tick threshold but the cumulative 100_000 crosses it).
          expect(numericUpdates.length).toBeGreaterThanOrEqual(1);
          // Every cumulative tick is non-decreasing.
          let prev = 0;
          for (const u of numericUpdates) {
            expect(u.current).toBeGreaterThanOrEqual(prev);
            prev = u.current;
          }
          // Final cumulative count equals the full pack size.
          const last = numericUpdates[numericUpdates.length - 1];
          expect(last?.current).toBe(stretched.length);
        });
      });
    });

    describe('Given chunks that hit the 65 536-byte tick boundary exactly', () => {
      describe('When fetchPack runs', () => {
        it('Then ticks fire at the threshold (kills >= vs >)', async () => {
          // Arrange — three 32_768-byte chunks. Cumulative:
          //  chunk1 → 32_768 (no tick, diff < 65_536)
          //  chunk2 → 65_536 (TICK with `>=`, no tick with `>`)
          //  chunk3 → 98_304 (no tick with `>=`, TICK with `>`)
          //  flush → fires only if total !== lastTick.
          // Original: 1 mid + 1 flush = 2 updates.
          // `>` mutant: 1 mid (at 98_304) + 0 flush = 1 update.
          // The count differs ⇒ the `>` mutant dies.
          const { reporter, events } = recordingProgress();
          const ctx = withProgress(createMemoryContext(), reporter);
          const dummyId = (await computeBlobId(ctx, ENCODER.encode('tick-boundary\n'))) as ObjectId;
          const stretched = new Uint8Array(12 + 98_304 + 20);
          const dv = new DataView(stretched.buffer);
          dv.setUint32(0, 0x5041434b);
          dv.setUint32(4, 2);
          dv.setUint32(8, 0);
          const trailerBytes = hexToBytes(await ctx.hash.hashHex(stretched.subarray(0, -20)));
          stretched.set(trailerBytes, stretched.length - 20);
          const body = buildMultiChunkSidebandBody(stretched, 32_768);
          const { transport } = captureRequestsChunked(body);

          // Act
          let caught: unknown;
          try {
            await fetchPack(ctx, toNegotiator(transport), {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert — walker rejects the stretched-empty pack.
          expect((caught as TsgitError).data.code).toBe('INVALID_PACK_HEADER');
          // Exactly two numeric updates: mid-stream at 65_536 and flush.
          const numericUpdates = events.filter(
            (e): e is { kind: 'update'; op: string; current: number } =>
              e.kind === 'update' && typeof e.current === 'number' && e.current > 0,
          );
          const counts = numericUpdates.map((u) => u.current);
          expect(counts).toContain(65_536);
          expect(counts[counts.length - 1]).toBe(stretched.length);
          expect(numericUpdates.length).toBe(2);
        });
      });
    });

    describe('Given a single sub-tick chunk', () => {
      describe('When fetchPack runs', () => {
        it('Then ONLY a final flush tick fires (no mid-stream tick)', async () => {
          // Arrange — single ~30 KiB chunk via one sideband-1 frame. Total
          // bytes < PROGRESS_TICK_BYTES, so the mid-stream guard `>= 64 KiB` must
          // NOT fire; only the post-loop `total > 0 && total !== lastTick` flush
          // fires once. Pins the `>=` vs `>` mutant on line 178.
          const { reporter, events } = recordingProgress();
          const ctx = withProgress(createMemoryContext(), reporter);
          const dummyId = (await computeBlobId(ctx, ENCODER.encode('sub-tick\n'))) as ObjectId;
          const stretched = new Uint8Array(12 + 30_000 + 20);
          const dv = new DataView(stretched.buffer);
          dv.setUint32(0, 0x5041434b);
          dv.setUint32(4, 2);
          dv.setUint32(8, 0);
          const trailerBytes = hexToBytes(await ctx.hash.hashHex(stretched.subarray(0, -20)));
          stretched.set(trailerBytes, stretched.length - 20);
          const body = buildMultiChunkSidebandBody(stretched, stretched.length);
          const { transport } = captureRequests(body);

          // Act
          let caught: unknown;
          try {
            await fetchPack(ctx, toNegotiator(transport), {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert — walker rejects the stretched bytes with "extra bytes" reason.
          expect((caught as TsgitError).data.code).toBe('INVALID_PACK_HEADER');
          // Exactly one numeric update (the flush), equal to total size.
          const numericUpdates = events.filter(
            (e): e is { kind: 'update'; op: string; current: number } =>
              e.kind === 'update' && typeof e.current === 'number' && e.current > 0,
          );
          expect(numericUpdates).toHaveLength(1);
          expect(numericUpdates[0]?.current).toBe(stretched.length);
        });
      });
    });

    describe('Given a pack body whose final byte lands exactly on a tick boundary', () => {
      describe('When fetchPack runs', () => {
        it('Then NO extra flush tick fires (kills && / total !== lastTick mutants)', async () => {
          // Arrange — four 32 768-byte drain chunks. Cumulative:
          //  chunk1 → 32 768  (no tick)
          //  chunk2 → 65 536  (TICK, lastTick = 65 536)
          //  chunk3 → 98 304  (no tick)
          //  chunk4 → 131 072 (TICK, lastTick = 131 072)
          // After the loop `total === lastTick === 131 072`, so the post-loop
          // flush guard `sawProgress && tailUnticked` is `true && false` → NO
          // flush. Exactly two numeric updates fire.
          //  `&&` → `||`     : `true || false` → flush → 3 updates.
          //  `tailUnticked` forced `true`        → flush → 3 updates.
          //  `total !== lastTick` → `total === lastTick` → `true` → flush → 3.
          // The count differs ⇒ every one of those mutants dies.
          const { reporter, events } = recordingProgress();
          const ctx = withProgress(createMemoryContext(), reporter);
          const dummyId = (await computeBlobId(ctx, ENCODER.encode('tick-exact\n'))) as ObjectId;
          const stretched = new Uint8Array(12 + 131_040 + 20);
          const dv = new DataView(stretched.buffer);
          dv.setUint32(0, 0x5041434b);
          dv.setUint32(4, 2);
          dv.setUint32(8, 0);
          const trailerBytes = hexToBytes(await ctx.hash.hashHex(stretched.subarray(0, -20)));
          stretched.set(trailerBytes, stretched.length - 20);
          expect(stretched.length).toBe(131_072);
          const body = buildMultiChunkSidebandBody(stretched, 32_768);
          const { transport } = captureRequestsChunked(body);

          // Act
          let caught: unknown;
          try {
            await fetchPack(ctx, toNegotiator(transport), {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert — walker rejects the stretched-empty pack.
          expect((caught as TsgitError).data.code).toBe('INVALID_PACK_HEADER');
          // Exactly two ticks: both mid-stream (65 536 and 131 072), no flush.
          const numericUpdates = events.filter(
            (e): e is { kind: 'update'; op: string; current: number } =>
              e.kind === 'update' && typeof e.current === 'number' && e.current > 0,
          );
          const counts = numericUpdates.map((u) => u.current);
          expect(counts).toEqual([65_536, 131_072]);
          expect(numericUpdates.length).toBe(2);
        });
      });
    });

    describe('Given a pack with an OFS_DELTA whose base offset is itself (distance 0)', () => {
      describe('When fetchPack runs', () => {
        it("Then throws INVALID_PACK_ENTRY naming the offset and git's out-of-bound reason (the defect fix)", async () => {
          // Arrange — a single OFS_DELTA at offset 12 with a distance-0
          // varint. `scanEntries` computes `baseOffset = 12 - 0 = 12`, which
          // IS `>= entryOffset` (12), so the widened guard in
          // `recordOfsDelta` refuses here, at the entry — a self-referential
          // delta is caught as out-of-bound rather than falling through to
          // the unresolved-delta count.
          const ctx = createMemoryContext();
          // Pack header (12 bytes) — magic 'PACK', version 2, 1 entry.
          const header = new Uint8Array(12);
          const hdv = new DataView(header.buffer);
          hdv.setUint32(0, 0x5041434b);
          hdv.setUint32(4, 2);
          hdv.setUint32(8, 1);
          // Entry header: type=6 (OFS_DELTA), size=2 (matching the 2-byte delta
          // payload below) → byte (6 << 4) | 2 = 0x62.
          // Distance = 0, encoded as a single 0x00 byte (no continuation).
          const entryHeader = new Uint8Array([0x62, 0x00]);
          // zlib-compressed empty delta payload (sourceLength=0, targetLength=0).
          const zlibBody = await ctx.compressor.deflate(new Uint8Array([0x00, 0x00]));
          const bodyBytes = new Uint8Array(header.length + entryHeader.length + zlibBody.length);
          bodyBytes.set(header, 0);
          bodyBytes.set(entryHeader, header.length);
          bodyBytes.set(zlibBody, header.length + entryHeader.length);
          const trailerHex = await ctx.hash.hashHex(bodyBytes);
          const packBytes = new Uint8Array(bodyBytes.length + 20);
          packBytes.set(bodyBytes, 0);
          packBytes.set(hexToBytes(trailerHex), bodyBytes.length);
          const dummyId = (await computeBlobId(ctx, ENCODER.encode('ofs-self\n'))) as ObjectId;
          const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          let caught: unknown;
          try {
            await fetchPack(ctx, toNegotiator(transport), {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string; reason?: string };
          expect(data.code).toBe('INVALID_PACK_ENTRY');
          expect(data.reason).toBe('delta base offset is out of bound');
        });
      });
    });

    describe('Given an empty pack body', () => {
      describe('When fetchPack runs', () => {
        it('Then returns a synthetic empty result (no error, no update tick)', async () => {
          // Arrange — server returns NAK + no sideband frames (zero pack bytes).
          // this is a legitimate protocol state when the client's
          // `have` set already covers every wanted oid (e.g., re-fetching a
          // fully up-to-date remote). fetchPack returns objectCount=0 with empty
          // path strings and emits NO progress tick.
          const { reporter, events } = recordingProgress();
          const ctx = withProgress(createMemoryContext(), reporter);
          const dummyId = (await computeBlobId(ctx, ENCODER.encode('empty body\n'))) as ObjectId;
          const body = encodePktStream([ENCODER.encode('NAK\n')]);
          const { transport } = captureRequests(body);

          // Act
          const result = await fetchPack(ctx, toNegotiator(transport), {
            wants: [dummyId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });

          // Assert — synthetic empty result.
          expect(result.objectCount).toBe(0);
          expect(result.packSha).toBe('');
          expect(result.packPath).toBe('');
          expect(result.idxPath).toBe('');
          // No update events whatsoever (the drain loop never runs).
          const allUpdates = events.filter((e) => e.kind === 'update');
          expect(allUpdates).toHaveLength(0);
        });
      });
    });

    describe('Given a successful fetchPack', () => {
      describe('When run', () => {
        it('Then start fires before end with the configured op', async () => {
          // Arrange
          const { reporter, events } = recordingProgress();
          const ctx = withProgress(createMemoryContext(), reporter);
          const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'progress probe\n');
          const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'clone:write-objects',
          });

          // Assert
          expect(events[0]).toEqual({ kind: 'start', op: 'clone:write-objects' });
          expect(events[events.length - 1]).toEqual({ kind: 'end', op: 'clone:write-objects' });
        });
      });
    });

    describe('Given a failing fetchPack', () => {
      describe('When run', () => {
        it('Then end still fires after start', async () => {
          // Arrange
          const { reporter, events } = recordingProgress();
          const ctx = withProgress(createMemoryContext(), reporter);
          const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'broken trailer\n');
          const corrupted = packBytes.slice();
          corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 0xff;
          const body = buildUploadPackResponseBody({ packBytes: corrupted, sideBand: true });
          const { transport } = captureRequests(body);

          // Act
          try {
            await fetchPack(ctx, toNegotiator(transport), {
              wants: [blobId],
              haves: [],
              capabilities: ['side-band-64k'],
              progressOp: 'clone:write-objects',
            });
          } catch {
            // expected
          }

          // Assert
          const starts = events.filter((e) => e.kind === 'start').length;
          const ends = events.filter((e) => e.kind === 'end').length;
          expect(starts).toBe(1);
          expect(ends).toBe(1);
        });
      });
    });

    describe('Given channel-2 sideband text', () => {
      describe('When fetchPack runs', () => {
        it('Then the reporter receives the sanitized text', async () => {
          // Arrange
          const { reporter, events } = recordingProgress();
          const ctx = withProgress(createMemoryContext(), reporter);
          const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'with progress\n');
          const body = buildUploadPackResponseBody({
            packBytes,
            sideBand: true,
            progressLines: ['Counting objects: 1, done.\n'],
          });
          const { transport } = captureRequests(body);

          // Act
          await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'clone:write-objects',
          });

          // Assert
          const textUpdates = events.filter(
            (e): e is { kind: 'update'; op: string; current: number; text?: string } =>
              e.kind === 'update' && typeof e.text === 'string' && e.text.length > 0,
          );
          expect(textUpdates.length).toBeGreaterThanOrEqual(1);
          const first = textUpdates[0];
          expect(first?.text).toContain('Counting objects');
        });
      });
    });
  });

  describe('depth + shallow', () => {
    describe('Given depth unset', () => {
      describe('When fetchPack runs', () => {
        it('Then request body has no `deepen` and shallow/unshallow are empty', async () => {
          // Arrange — regression guard for the prior path.
          const ctx = createMemoryContext();
          const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'no depth\n');
          const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const { transport, requests } = captureRequests(body);

          // Act
          const result = await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });

          // Assert
          expect(result.shallow).toEqual([]);
          expect(result.unshallow).toEqual([]);
          const decoded = new TextDecoder().decode(requests[0]?.body);
          expect(decoded.includes('deepen')).toBe(false);
        });
      });
    });

    describe('Given depth = 1 and a server shallow block with one oid', () => {
      describe('When fetchPack runs', () => {
        it('Then result.shallow contains the oid', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'depth\n');
          const shallowOid = 'a'.repeat(40);
          const body = buildShallowResponseBody({ packBytes, shallow: [shallowOid] });
          const { transport, requests } = captureRequests(body);

          // Act
          const result = await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
            depth: 1,
          });

          // Assert — `deepen 1\n` in the request body.
          expect(result.shallow).toEqual([shallowOid]);
          expect(result.unshallow).toEqual([]);
          const decoded = new TextDecoder().decode(requests[0]?.body);
          expect(decoded).toContain('deepen 1\n');
        });
      });
    });

    describe('Given depth = 1 and a server that omits the shallow block (immediate flush)', () => {
      describe('When fetchPack runs', () => {
        it('Then shallow/unshallow are empty arrays', async () => {
          // Arrange — server ignores deepen; emits only the NAK + pack.
          const ctx = createMemoryContext();
          const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'omit shallow\n');
          // The server still emits a flush at the start of the shallow section.
          const shallowSection = encodePktStream([]);
          const tail = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const body = new Uint8Array(shallowSection.length + tail.length);
          body.set(shallowSection, 0);
          body.set(tail, shallowSection.length);
          const { transport } = captureRequests(body);

          // Act
          const result = await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
            depth: 1,
          });

          // Assert
          expect(result.shallow).toEqual([]);
          expect(result.unshallow).toEqual([]);
        });
      });
    });

    describe('Given depth set and a malformed shallow oid', () => {
      describe('When fetchPack runs', () => {
        it('Then INVALID_REF_LINE propagates', async () => {
          // Arrange — protocol error inside the shallow block surfaces as
          // INVALID_REF_LINE (parseShallowResponse).
          const ctx = createMemoryContext();
          const dummyId = (await computeBlobId(ctx, ENCODER.encode('bad shallow\n'))) as ObjectId;
          const shallowSection = encodePktStream([ENCODER.encode('shallow not-an-oid\n')]);
          const tail = buildUploadPackResponseBody({
            packBytes: new Uint8Array(0),
            sideBand: true,
          });
          const body = new Uint8Array(shallowSection.length + tail.length);
          body.set(shallowSection, 0);
          body.set(tail, shallowSection.length);
          const { transport } = captureRequests(body);

          // Act
          let caught: unknown;
          try {
            await fetchPack(ctx, toNegotiator(transport), {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              progressOp: 'test:write-objects',
              depth: 1,
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('INVALID_REF_LINE');
        });
      });
    });

    describe('Given depth set and a server returning shallow + unshallow lines', () => {
      describe('When fetchPack runs', () => {
        it('Then both arrays surface', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'mix\n');
          const shallowOid = 'a'.repeat(40);
          const unshallowOid = 'b'.repeat(40);
          const body = buildShallowResponseBody({
            packBytes,
            shallow: [shallowOid],
            unshallow: [unshallowOid],
          });
          const { transport } = captureRequests(body);

          // Act
          const result = await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
            depth: 3,
          });

          // Assert
          expect(result.shallow).toEqual([shallowOid]);
          expect(result.unshallow).toEqual([unshallowOid]);
        });
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pack quarantine — streamed receive, incremental trailer hash, verify-then-
// rename, best-effort cleanup on a handled failure
// ─────────────────────────────────────────────────────────────────────────────

describe('pack quarantine', () => {
  describe('Given a pack split into several sideband-1 frames', () => {
    describe('When fetchPack drains it into quarantine', () => {
      it('Then bytes reach the quarantine file as they arrive, not after full buffering', async () => {
        // Arrange
        const baseCtx = createMemoryContext();
        const { packBytes, blobId } = await buildSingleBlobPack(baseCtx, 'x'.repeat(20_000));
        const chunkSizes: number[] = [];
        const ctx = withFsPatch(baseCtx, {
          writeStream: async (path: string, source: AsyncIterable<Uint8Array>): Promise<void> => {
            async function* tap(): AsyncGenerator<Uint8Array> {
              for await (const chunk of source) {
                chunkSizes.push(chunk.byteLength);
                yield chunk;
              }
            }
            await baseCtx.fs.writeStream(path, tap());
          },
        });
        // Highly repetitive content deflates to far fewer bytes than its
        // source length, so the frame size is derived from the ACTUAL
        // compressed pack size (never a fixed guess) to guarantee several
        // frames regardless of the compression ratio.
        const body = buildMultiChunkSidebandBody(
          packBytes,
          Math.max(8, Math.floor(packBytes.length / 5)),
        );
        const { transport } = captureRequests(body);

        // Act
        const result = await fetchPack(ctx, toNegotiator(transport), {
          wants: [blobId],
          haves: [],
          capabilities: ['side-band-64k'],
          progressOp: 'test:write-objects',
        });

        // Assert — several chunks pulled through the SAME writeStream call,
        // never one pre-materialised whole-pack buffer.
        expect(result.objectCount).toBe(1);
        expect(chunkSizes.length).toBeGreaterThan(1);
      });
    });
  });

  describe('Given a stream whose trailer does not match', () => {
    describe('When fetchPack drains it into quarantine', () => {
      it('Then it refuses and no pack-<sha>.pack (or leftover tmp file) exists afterward', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'corrupt me\n');
        const corrupted = packBytes.slice();
        corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 0xff;
        const body = buildUploadPackResponseBody({ packBytes: corrupted, sideBand: true });
        const { transport } = captureRequests(body);

        // Act
        let caught: unknown;
        try {
          await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });
        } catch (err) {
          caught = err;
        }

        // Assert — verify-before-rename: the quarantine file never got promoted.
        expect(caught).toBeInstanceOf(TsgitError);
        const entries = await ctx.fs.readdir(packDir(ctx));
        expect(entries).toHaveLength(0);
      });
    });
  });

  describe('Given a successful stream', () => {
    describe('When fetchPack drains it into quarantine', () => {
      it('Then the temp file is renamed to pack-<sha>.pack and the .idx and .rev siblings are written', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'rename me\n');
        const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
        const { transport } = captureRequests(body);

        // Act
        const result = await fetchPack(ctx, toNegotiator(transport), {
          wants: [blobId],
          haves: [],
          capabilities: ['side-band-64k'],
          progressOp: 'test:write-objects',
        });

        // Assert
        expect(result.packPath).toBe(`${packDir(ctx)}/pack-${result.packSha}.pack`);
        expect(await ctx.fs.exists(result.packPath)).toBe(true);
        expect(await tmpPackNames(ctx)).toHaveLength(0);
        const entries = await ctx.fs.readdir(packDir(ctx));
        expect(entries.some((e) => e.name === `pack-${result.packSha}.rev`)).toBe(true);
      });
    });
  });

  describe('Given an adapter without atomicRename', () => {
    describe('When fetchPack promotes the quarantined pack', () => {
      it('Then the plain rename path is used', async () => {
        // Arrange
        const baseCtx = createMemoryContext();
        const ctx = withoutAtomicRename(baseCtx);
        const renameSpy = vi.spyOn(ctx.fs, 'rename');
        const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'no atomic rename\n');
        const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
        const { transport } = captureRequests(body);

        // Act
        const result = await fetchPack(ctx, toNegotiator(transport), {
          wants: [blobId],
          haves: [],
          capabilities: ['side-band-64k'],
          progressOp: 'test:write-objects',
        });

        // Assert
        expect(renameSpy).toHaveBeenCalledOnce();
        expect(renameSpy).toHaveBeenCalledWith(
          expect.stringContaining('tmp_pack_'),
          result.packPath,
        );
      });
    });
  });

  describe('Given a handled failure mid-stream (the response exceeds maxResponseBytes)', () => {
    describe('When fetchPack drains it into quarantine', () => {
      it('Then the temp file is removed', async () => {
        // Arrange
        const baseCtx = createMemoryContext();
        const { packBytes, blobId } = await buildSingleBlobPack(baseCtx, 'too big for the cap\n');
        const ctx = withMaxResponseBytes(baseCtx, packBytes.length - 1);
        const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
        const { transport } = captureRequests(body);

        // Act
        let caught: unknown;
        try {
          await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('PACK_TOO_LARGE');
        expect(await tmpPackNames(ctx)).toHaveLength(0);
      });
    });
  });

  describe('Given the quarantine file is already gone when cleanup runs', () => {
    describe('When fetchPack fails on a corrupted trailer', () => {
      it('Then FILE_NOT_FOUND from the cleanup is swallowed and the original error surfaces', async () => {
        // Arrange
        const baseCtx = createMemoryContext();
        const { packBytes, blobId } = await buildSingleBlobPack(baseCtx, 'gone already\n');
        const corrupted = packBytes.slice();
        corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 0xff;
        const ctx = withFsPatch(baseCtx, {
          rm: async (path: string) => {
            throw fileNotFound(path);
          },
        });
        const body = buildUploadPackResponseBody({ packBytes: corrupted, sideBand: true });
        const { transport } = captureRequests(body);

        // Act
        let caught: unknown;
        try {
          await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });
        } catch (err) {
          caught = err;
        }

        // Assert — the ORIGINAL trailer-mismatch error surfaces, not a
        // secondary error from the cleanup's own FILE_NOT_FOUND.
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; reason?: string };
        expect(data.code).toBe('INVALID_PACK_HEADER');
        expect(data.reason).toContain('trailer');
      });
    });
  });

  describe('Given cleanup fails with something other than FILE_NOT_FOUND', () => {
    describe('When fetchPack fails on a corrupted trailer', () => {
      it('Then the ORIGINAL trailer-mismatch error still surfaces — the cleanup failure is swallowed, not masking it', async () => {
        // Arrange — a cleanup failure on a handled-failure path must never
        // REPLACE the diagnosis it was cleaning up after: the trailer
        // mismatch is the refusal that matters here, not the unrelated
        // PERMISSION_DENIED unlinking the doomed quarantine file.
        const baseCtx = createMemoryContext();
        const { packBytes, blobId } = await buildSingleBlobPack(baseCtx, 'permission trouble\n');
        const corrupted = packBytes.slice();
        corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 0xff;
        const ctx = withFsPatch(baseCtx, {
          rm: async (path: string) => {
            throw permissionDenied(path);
          },
        });
        const body = buildUploadPackResponseBody({ packBytes: corrupted, sideBand: true });
        const { transport } = captureRequests(body);

        // Act
        let caught: unknown;
        try {
          await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; reason?: string };
        expect(data.code).toBe('INVALID_PACK_HEADER');
        expect(data.reason).toContain('trailer');
      });
    });
  });

  describe('Given the quarantined pack cannot be read back off disk', () => {
    describe('When fetchPack walks the quarantined entries', () => {
      it('Then the temp file is removed instead of leaking', async () => {
        // Arrange — the read-back (not the walk) is what fails here: it
        // must be covered by the SAME cleanup as a malformed-body failure,
        // not skipped because it happens before the walk even starts.
        const baseCtx = createMemoryContext();
        const { packBytes, blobId } = await buildSingleBlobPack(baseCtx, 'read-back fails\n');
        const ctx = withFsPatch(baseCtx, {
          readSlice: async (): Promise<Uint8Array> => {
            throw permissionDenied('quarantine read-back');
          },
        });
        const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
        const { transport } = captureRequests(body);

        // Act
        let caught: unknown;
        try {
          await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
        expect(await tmpPackNames(ctx)).toHaveLength(0);
      });
    });
  });

  describe('Given the rename into place fails after the pack is verified', () => {
    describe('When fetchPack promotes the quarantined pack', () => {
      it('Then the quarantine temp file is removed instead of orphaned', async () => {
        // Arrange
        const baseCtx = createMemoryContext();
        const { packBytes, blobId } = await buildSingleBlobPack(baseCtx, 'rename fails\n');
        const ctx = withFsPatch(baseCtx, {
          rename: async (): Promise<void> => {
            throw permissionDenied('final pack path');
          },
        });
        const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
        const { transport } = captureRequests(body);

        // Act
        let caught: unknown;
        try {
          await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
        expect(await tmpPackNames(ctx)).toHaveLength(0);
      });
    });
  });

  describe('Given a quarantine name collision with another in-flight write', () => {
    describe('When fetchPack drains a pack into quarantine', () => {
      it('Then it claims a distinct name instead of silently clobbering the colliding file', async () => {
        // Arrange — force the FIRST drawn suffix ("AAAAAA") to collide with
        // an existing file, then a different one ("ffffff") to succeed —
        // proves claimQuarantinePath retries on FILE_EXISTS rather than
        // writing straight through the collision.
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'my content\n');
        await ctx.fs.mkdir(packDir(ctx));
        const collidingPath = `${packDir(ctx)}/tmp_pack_AAAAAA`;
        const sentinel = 'this must survive untouched';
        await ctx.fs.writeUtf8(collidingPath, sentinel);
        const randomSpy = vi.spyOn(Math, 'random');
        for (let i = 0; i < 6; i += 1) randomSpy.mockReturnValueOnce(0);
        randomSpy.mockReturnValue(0.5);
        const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
        const { transport } = captureRequests(body);

        // Act
        let result: Awaited<ReturnType<typeof fetchPack>>;
        try {
          result = await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });
        } finally {
          randomSpy.mockRestore();
        }

        // Assert — the pre-existing colliding file is untouched and the
        // fetch still completed against a distinct claimed name.
        expect(result.objectCount).toBe(1);
        const bytes = await ctx.fs.read(collidingPath);
        expect(new TextDecoder().decode(bytes)).toBe(sentinel);
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// quarantine disk-backed entry walk — bounded readSlice windows instead of
// one whole-pack buffer, exercised through the public fetchPack surface.
// ─────────────────────────────────────────────────────────────────────────────

describe('quarantine disk-backed entry walk', () => {
  describe('Given a pack with base + OFS_DELTA + REF_DELTA entries', () => {
    describe('When fetchPack walks the quarantined pack from disk', () => {
      it('Then the resulting id/crc32/offset set matches the in-memory walk exactly', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const baseContent = ENCODER.encode('disk-walk differential base content\n');
        const baseId = await computeBlobId(ctx, baseContent);
        const entries: EntrySpec[] = [
          { kind: 'base', type: 'blob', content: baseContent },
          { kind: 'ofs-delta', baseIndex: 0, targetContent: ENCODER.encode('ofs target\n') },
          {
            kind: 'ref-delta',
            baseId,
            baseUncompressed: baseContent,
            targetContent: ENCODER.encode('ref target\n'),
          },
        ];
        const built = await buildSyntheticPack(ctx, entries);
        const inMemory = await walkPackEntries(ctx, built.packBytes);
        const body = buildUploadPackResponseBody({ packBytes: built.packBytes, sideBand: true });
        const { transport } = captureRequests(body);

        // Act
        const result = await fetchPack(ctx, toNegotiator(transport), {
          wants: [built.ids[0] as ObjectId],
          haves: [],
          capabilities: ['side-band-64k', 'ofs-delta'],
          progressOp: 'test:write-objects',
        });

        // Assert — every entry the in-memory walk found is present in the
        // disk-walk-produced .idx at the same offset and crc32.
        expect(inMemory).toHaveLength(3);
        const idx = parsePackIndex(await ctx.fs.read(result.idxPath), 20);
        expect(idx.objectCount).toBe(inMemory.length);
        for (const entry of inMemory) {
          const position = lookupPackIndexPosition(idx, entry.id as ObjectId);
          expect(position).toBeDefined();
          expect(lookupPackIndex(idx, entry.id as ObjectId)).toBe(entry.offset);
          const crc32AtPosition = idx._view.getUint32(
            idx.crc32TableOffset + (position as number) * 4,
          );
          expect(crc32AtPosition).toBe(entry.crc32);
        }
      });
    });
  });

  describe('Given a pack larger than one read window (several entries, none individually bigger than the window)', () => {
    describe('When fetchPack walks the quarantined pack from disk', () => {
      it('Then no readSlice call requests the whole pack, and the documented window bound is the one actually enforced', async () => {
        // Arrange — six 60 KB entries (360 KB total, no single entry anywhere
        // near the window) so the pack is bigger than one window but no entry
        // ever forces growth; this isolates the initial-window cap itself
        // from the doubling-growth path (covered separately below).
        const baseCtx = createMemoryContext();
        const entries: EntrySpec[] = Array.from({ length: 6 }, (_, i) => ({
          kind: 'base',
          type: 'blob',
          content: pseudoRandomBytes(60_000, 1000 + i),
        }));
        const built = await buildSyntheticPack(baseCtx, entries);
        const requestedLengths: number[] = [];
        const ctx = withFsPatch(baseCtx, {
          readSlice: async (path: string, offset: number, length: number): Promise<Uint8Array> => {
            requestedLengths.push(length);
            return baseCtx.fs.readSlice(path, offset, length);
          },
        });
        const body = buildMultiChunkSidebandBody(built.packBytes, 32_768);
        const { transport } = captureRequests(body);

        // Act
        const result = await fetchPack(ctx, toNegotiator(transport), {
          wants: [built.ids[0] as ObjectId],
          haves: [],
          capabilities: ['side-band-64k'],
          progressOp: 'test:write-objects',
        });

        // Assert — the walk never asks for `totalBytes` in one call; the
        // documented constant itself shows up as an actual request (proving
        // the cap is the term that wins, not merely "whatever bytes remained"),
        // and no request ever exceeds it since no entry needed to grow.
        expect(result.objectCount).toBe(6);
        expect(requestedLengths.length).toBeGreaterThan(0);
        expect(requestedLengths).not.toContain(built.packBytes.length);
        expect(requestedLengths).toContain(DISK_WALK_WINDOW_BYTES);
        expect(Math.max(...requestedLengths)).toBeLessThanOrEqual(DISK_WALK_WINDOW_BYTES);
      });
    });
  });

  describe('Given an entry whose zlib stream straddles a window boundary', () => {
    describe('When fetchPack walks the quarantined pack from disk', () => {
      it('Then it still inflates correctly by growing the window', async () => {
        // Arrange — content sized off the production constant itself, so the
        // split point tracks `DISK_WALK_WINDOW_BYTES` rather than a fixed number.
        const baseCtx = createMemoryContext();
        const bigContent = pseudoRandomBytes(DISK_WALK_WINDOW_BYTES + 40_000, 424_242);
        const entries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: bigContent }];
        const built = await buildSyntheticPack(baseCtx, entries);
        const requestedLengths: number[] = [];
        const ctx = withFsPatch(baseCtx, {
          readSlice: async (path: string, offset: number, length: number): Promise<Uint8Array> => {
            requestedLengths.push(length);
            return baseCtx.fs.readSlice(path, offset, length);
          },
        });
        // A single sideband pkt-line payload caps at 65 516 bytes, well under
        // this fixture's compressed size — split across frames like a real
        // server would.
        const body = buildMultiChunkSidebandBody(built.packBytes, 32_768);
        const { transport } = captureRequests(body);

        // Act
        const result = await fetchPack(ctx, toNegotiator(transport), {
          wants: [built.ids[0] as ObjectId],
          haves: [],
          capabilities: ['side-band-64k'],
          progressOp: 'test:write-objects',
        });

        // Assert — the object round-trips correctly even though its
        // compressed span crossed a window boundary...
        expect(result.objectCount).toBe(1);
        const readBack = await readObject(ctx, built.ids[0] as ObjectId);
        if (readBack.type !== 'blob') throw new Error('expected a blob');
        expect(readBack.content).toEqual(bigContent);
        // ...proven to be an actual GROWTH, not a lucky single unbounded read:
        // an initial attempt at exactly the documented window size is present,
        // followed by a larger retry that still stops short of the whole pack.
        expect(requestedLengths).toContain(DISK_WALK_WINDOW_BYTES);
        expect(Math.max(...requestedLengths)).toBeGreaterThan(DISK_WALK_WINDOW_BYTES);
        expect(Math.max(...requestedLengths)).toBeLessThan(built.packBytes.length);
      });
    });
  });

  describe('Given a base entry larger than one window, several windows before a delta chained onto it', () => {
    describe('When fetchPack walks the quarantined pack from disk', () => {
      it('Then pass 2 re-anchors backward to re-read the base, regrowing its own window from scratch', async () => {
        // Arrange — pass 1's forward scan walks past two large filler
        // entries after the base, so by the time it finishes, the held
        // window sits far past the base's own (small) offset. Resolving
        // the delta in pass 2 then requires re-inflating that same base as
        // a forest root — a read whose anchor is BEHIND the window pass 1
        // left held, not merely a fresh one past it.
        const baseCtx = createMemoryContext();
        const bigContent = pseudoRandomBytes(DISK_WALK_WINDOW_BYTES + 40_000, 909);
        const fillerOne = pseudoRandomBytes(DISK_WALK_WINDOW_BYTES + 40_000, 910);
        const fillerTwo = pseudoRandomBytes(DISK_WALK_WINDOW_BYTES + 40_000, 911);
        const entries: EntrySpec[] = [
          { kind: 'base', type: 'blob', content: bigContent },
          { kind: 'base', type: 'blob', content: fillerOne },
          { kind: 'base', type: 'blob', content: fillerTwo },
          {
            kind: 'ofs-delta',
            baseIndex: 0,
            targetContent: ENCODER.encode('backward-anchor delta target'),
          },
        ];
        const built = await buildSyntheticPack(baseCtx, entries);
        const calls: Array<{ offset: number; length: number }> = [];
        const ctx = withFsPatch(baseCtx, {
          readSlice: async (path: string, offset: number, length: number): Promise<Uint8Array> => {
            calls.push({ offset, length });
            return baseCtx.fs.readSlice(path, offset, length);
          },
        });
        const body = buildMultiChunkSidebandBody(built.packBytes, 32_768);
        const { transport } = captureRequests(body);

        // Act
        const result = await fetchPack(ctx, toNegotiator(transport), {
          wants: [built.ids[0] as ObjectId],
          haves: [],
          capabilities: ['side-band-64k'],
          progressOp: 'test:write-objects',
        });

        // Assert — every entry resolved correctly...
        expect(result.objectCount).toBe(4);
        const readBack = await readObject(ctx, built.ids[0] as ObjectId);
        if (readBack.type !== 'blob') throw new Error('expected a blob');
        expect(readBack.content).toEqual(bigContent);
        // ...and the read-offset sequence proves a genuine backward jump:
        // some later call's offset is LOWER than an earlier call's, which
        // only happens once pass 2 re-anchors at the base's own (small)
        // offset after pass 1 has already walked forward past it.
        const offsets = calls.map((c) => c.offset);
        const backwardJumpIndex = offsets.findIndex(
          (o, i) => i > 0 && o < (offsets[i - 1] as number),
        );
        expect(backwardJumpIndex).toBeGreaterThan(0);
        // The base's own offset (right after the pack header) is read at
        // least twice — once by pass 1's forward scan, once by pass 2's
        // backward re-anchor — and every read anchored there regrows from
        // the documented window rather than requesting the whole pack.
        const baseOffset = built.offsets[0] as number;
        const atBaseOffset = calls.filter((c) => c.offset === baseOffset);
        expect(atBaseOffset.length).toBeGreaterThanOrEqual(2);
        for (const call of atBaseOffset) {
          expect(call.length).toBeLessThan(built.packBytes.length);
        }
      });
    });
  });

  describe('Given a readSlice failure on a later window fetch (after the header and first window already succeeded)', () => {
    describe('When fetchPack walks the quarantined entries', () => {
      it('Then the temp file is still removed', async () => {
        // Arrange — an entry too big for one window forces a THIRD readSlice
        // call (header, initial window, grown window); failing exactly that
        // one call proves cleanup fires from deep inside the growth retry
        // loop, not only on the very first read (already covered above).
        const baseCtx = createMemoryContext();
        const bigContent = pseudoRandomBytes(DISK_WALK_WINDOW_BYTES + 40_000, 777);
        const entries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: bigContent }];
        const built = await buildSyntheticPack(baseCtx, entries);
        let callCount = 0;
        const ctx = withFsPatch(baseCtx, {
          readSlice: async (path: string, offset: number, length: number): Promise<Uint8Array> => {
            callCount += 1;
            if (callCount > 2) throw permissionDenied('windowed read-back');
            return baseCtx.fs.readSlice(path, offset, length);
          },
        });
        const body = buildMultiChunkSidebandBody(built.packBytes, 32_768);
        const { transport } = captureRequests(body);

        // Act
        let caught: unknown;
        try {
          await fetchPack(ctx, toNegotiator(transport), {
            wants: [built.ids[0] as ObjectId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(callCount).toBeGreaterThan(2);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
        expect(await tmpPackNames(ctx)).toHaveLength(0);
      });
    });
  });

  describe('Given a filesystem whose readSlice caps every delivery at a fixed length below the requested growth', () => {
    describe('When fetchPack walks the quarantined pack from disk', () => {
      it('Then growth bails on non-progress instead of re-requesting identical bytes forever', async () => {
        // Arrange — content forces the entry's compressed span well past a
        // single capped window, so the first inflate attempt fails with a
        // retryable reason. A short-read filesystem (NFS/SMB/FUSE-shaped —
        // NodeFileSystem.readSlice issues a single non-looping handle.read)
        // never delivers more than CAP bytes no matter how large the next
        // window asks for, so a growth fetch that repeats the SAME delivered
        // size must bail rather than loop. The call-count poison past
        // POISON_AFTER_CALLS is a safety net bounding this test's own
        // runtime if the non-progress guard is ever missing — it is not the
        // behaviour under test, only insurance against an actual hang.
        const baseCtx = createMemoryContext();
        const bigContent = pseudoRandomBytes(DISK_WALK_WINDOW_BYTES + 40_000, 55_555);
        const entries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: bigContent }];
        const built = await buildSyntheticPack(baseCtx, entries);
        const CAP = 20_000;
        const POISON_AFTER_CALLS = 8;
        let readSliceCalls = 0;
        const ctx = withFsPatch(baseCtx, {
          readSlice: async (path: string, offset: number, length: number): Promise<Uint8Array> => {
            readSliceCalls += 1;
            if (readSliceCalls > POISON_AFTER_CALLS) {
              throw permissionDenied('short-read filesystem exhausted');
            }
            const real = await baseCtx.fs.readSlice(path, offset, length);
            return real.subarray(0, Math.min(real.length, CAP));
          },
        });
        const body = buildMultiChunkSidebandBody(built.packBytes, 32_768);
        const { transport } = captureRequests(body);
        const sut = fetchPack;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, toNegotiator(transport), {
            wants: [built.ids[0] as ObjectId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });
        } catch (err) {
          caught = err;
        }

        // Assert — the pending DECOMPRESS_FAILED surfaces well before the
        // poison call, proving growth bailed on non-progress rather than
        // spinning until an unrelated failure eventually stopped it.
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; reason?: string };
        expect(data.code).toBe('DECOMPRESS_FAILED');
        expect(data.reason).toBe('unexpected end of deflate stream');
        expect(readSliceCalls).toBeLessThan(POISON_AFTER_CALLS);
      });
    });
  });

  describe('Given a pack spanning several windows with entries that never individually need growth (12 x 60 KB)', () => {
    describe('When fetchPack walks the quarantined pack from disk', () => {
      it('Then no readSlice call exceeds the documented window even though the walk crosses more than two window boundaries', async () => {
        // Arrange — each boundary crossing that reuses an already-grown
        // window is exactly where the ratchet bug used to compound: growth
        // doubled from whatever window happened to be held, not from the
        // documented window size for the entry actually being read.
        const baseCtx = createMemoryContext();
        const built = await buildMultiWindowPack(baseCtx);
        const requestedLengths: number[] = [];
        const ctx = withFsPatch(baseCtx, {
          readSlice: async (path: string, offset: number, length: number): Promise<Uint8Array> => {
            requestedLengths.push(length);
            return baseCtx.fs.readSlice(path, offset, length);
          },
        });
        const body = buildMultiChunkSidebandBody(built.packBytes, 32_768);
        const { transport } = captureRequests(body);
        const sut = fetchPack;

        // Act
        const result = await sut(ctx, toNegotiator(transport), {
          wants: [built.ids[0] as ObjectId],
          haves: [],
          capabilities: ['side-band-64k'],
          progressOp: 'test:write-objects',
        });

        // Assert
        expect(result.objectCount).toBe(MULTI_WINDOW_ENTRY_COUNT);
        expect(Math.max(...requestedLengths)).toBeLessThanOrEqual(DISK_WALK_WINDOW_BYTES);
        // Exclude the 12-byte header read: each remaining call is a window
        // fetch, and this pack is bigger than two windows.
        const windowFetches = requestedLengths.length - 1;
        expect(windowFetches).toBeGreaterThan(2);
      });
    });
  });

  describe('Given the same multi-window pack', () => {
    describe('When fetchPack walks the quarantined pack from disk', () => {
      it('Then the readSlice call shape proves windows are reused across entries, not fetched again per entry', async () => {
        // Arrange
        const baseCtx = createMemoryContext();
        const built = await buildMultiWindowPack(baseCtx);
        const calls: Array<{ offset: number; length: number }> = [];
        const ctx = withFsPatch(baseCtx, {
          readSlice: async (path: string, offset: number, length: number): Promise<Uint8Array> => {
            calls.push({ offset, length });
            return baseCtx.fs.readSlice(path, offset, length);
          },
        });
        const body = buildMultiChunkSidebandBody(built.packBytes, 32_768);
        const { transport } = captureRequests(body);
        const sut = fetchPack;

        // Act
        const result = await sut(ctx, toNegotiator(transport), {
          wants: [built.ids[0] as ObjectId],
          haves: [],
          capabilities: ['side-band-64k'],
          progressOp: 'test:write-objects',
        });

        // Assert — first call is the bare 12-byte header read; a mutant that
        // broke reuse (e.g. always refetching at the entry's own offset)
        // would drive one readSlice per entry (12, plus the header), far
        // above the window-count-shaped ceiling below.
        expect(result.objectCount).toBe(MULTI_WINDOW_ENTRY_COUNT);
        expect(calls[0]).toEqual({ offset: 0, length: 12 });
        const packBodyBytes = built.packBytes.length - 12 - 20;
        const maxExpectedCalls = Math.ceil(packBodyBytes / DISK_WALK_WINDOW_BYTES) + 2;
        expect(calls.length).toBeLessThanOrEqual(maxExpectedCalls);
        expect(calls.length).toBeLessThan(MULTI_WINDOW_ENTRY_COUNT);
      });
    });
  });

  describe('Given a quarantined pack with a genuinely corrupt entry header (reserved type 5) and a correct trailer', () => {
    describe('When fetchPack walks the quarantined pack from disk', () => {
      it('Then the error surfaces without growing the window, reports the absolute offset, and reaps the quarantine file', async () => {
        // Arrange — a single byte of entry header (type=5 << 4 | size=0 =>
        // 0x50) is enough to trip `validateEntryType`'s reserved-type guard
        // before any delta-specific or zlib byte is ever read. Padding well
        // past one window between the corrupt byte and the trailer gives a
        // blind retry room to actually happen — without it, `trailerStart`
        // proximity alone would cap growth after one window regardless of
        // whether the failure was ever classified as retryable.
        const ctx = createMemoryContext();
        const dummyId = (await computeBlobId(ctx, ENCODER.encode('reserved-type\n'))) as ObjectId;
        const header = new Uint8Array(12);
        const dv = new DataView(header.buffer);
        dv.setUint32(0, 0x5041434b);
        dv.setUint32(4, 2);
        dv.setUint32(8, 1);
        const entryByte = new Uint8Array([0x50]);
        const padding = new Uint8Array(DISK_WALK_WINDOW_BYTES + 40_000);
        const bodyBytes = new Uint8Array(header.length + entryByte.length + padding.length);
        bodyBytes.set(header, 0);
        bodyBytes.set(entryByte, header.length);
        bodyBytes.set(padding, header.length + entryByte.length);
        const trailerHex = await ctx.hash.hashHex(bodyBytes);
        const packBytes = new Uint8Array(bodyBytes.length + 20);
        packBytes.set(bodyBytes, 0);
        packBytes.set(hexToBytes(trailerHex), bodyBytes.length);
        let readSliceCalls = 0;
        const spiedCtx = withFsPatch(ctx, {
          readSlice: async (path: string, offset: number, length: number): Promise<Uint8Array> => {
            readSliceCalls += 1;
            return ctx.fs.readSlice(path, offset, length);
          },
        });
        const body = buildMultiChunkSidebandBody(packBytes, 32_768);
        const { transport } = captureRequests(body);
        const sut = fetchPack;

        // Act
        let caught: unknown;
        try {
          await sut(spiedCtx, toNegotiator(transport), {
            wants: [dummyId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as {
          code: string;
          offset?: number;
          reason?: string;
        };
        expect(data.code).toBe('INVALID_PACK_ENTRY');
        expect(data.reason).toContain('reserved type 5');
        // Fails fast: the corrupt header is read once (the entry's initial
        // window) and never triggers a growth retry, even though the pack
        // has plenty of room past that window for a blind retry to grow into.
        expect(readSliceCalls).toBe(2); // pack header (12 bytes) + one entry window
        // Absolute pack offset, not window-relative (the entry starts right
        // after the 12-byte pack header).
        expect(data.offset).toBe(12);
        expect(await tmpPackNames(spiedCtx)).toHaveLength(0);
      });
    });
  });

  describe('Given a quarantined pack entry whose zlib stream inflates past its declared header size', () => {
    describe('When fetchPack walks the quarantined pack from disk', () => {
      it('Then the disk walk refuses instead of inflating past the declared size, and reaps the quarantine file', async () => {
        // Arrange — declared size 5, but the zlib stream is a valid, complete
        // encoding of 10 bytes: bounding `streamInflate` to the declared size
        // trips the output-safety-cap refusal instead of silently accepting a
        // stream larger than its own header claims.
        const ctx = createMemoryContext();
        const dummyId = (await computeBlobId(
          ctx,
          ENCODER.encode('oversize-declare\n'),
        )) as ObjectId;
        const header = new Uint8Array(12);
        const dv = new DataView(header.buffer);
        dv.setUint32(0, 0x5041434b);
        dv.setUint32(4, 2);
        dv.setUint32(8, 1);
        const declaredSize = 5;
        const actualPayload = ENCODER.encode('AAAAAAAAAA'); // 10 bytes, > declaredSize
        const entryHeaderByte = encodePackEntryHeader(PACK_ENTRY_TYPE.BLOB, declaredSize);
        const zlibStream = await ctx.compressor.deflate(actualPayload);
        const bodyBytes = new Uint8Array(
          header.length + entryHeaderByte.length + zlibStream.length,
        );
        bodyBytes.set(header, 0);
        bodyBytes.set(entryHeaderByte, header.length);
        bodyBytes.set(zlibStream, header.length + entryHeaderByte.length);
        const trailerHex = await ctx.hash.hashHex(bodyBytes);
        const packBytes = new Uint8Array(bodyBytes.length + 20);
        packBytes.set(bodyBytes, 0);
        packBytes.set(hexToBytes(trailerHex), bodyBytes.length);
        const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
        const { transport } = captureRequests(body);
        const sut = fetchPack;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, toNegotiator(transport), {
            wants: [dummyId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; reason?: string };
        expect(data.code).toBe('DECOMPRESS_FAILED');
        expect(data.reason).toContain('safety cap');
        expect(await tmpPackNames(ctx)).toHaveLength(0);
      });
    });
  });

  describe('Given a quarantined pack entry with declared size 0 (an empty blob)', () => {
    describe('When fetchPack walks the quarantined pack from disk', () => {
      it('Then the entry resolves cleanly — the declared-size bound holds at its zero case, not merely by construction', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { packBytes, blobId } = await buildSingleBlobPack(ctx, '');
        const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
        const { transport } = captureRequests(body);
        const sut = fetchPack;

        // Act
        const result = await sut(ctx, toNegotiator(transport), {
          wants: [blobId],
          haves: [],
          capabilities: ['side-band-64k'],
          progressOp: 'test:write-objects',
        });

        // Assert
        expect(result.objectCount).toBe(1);
        const readBack = await readObject(ctx, blobId);
        if (readBack.type !== 'blob') throw new Error('expected a blob');
        expect(readBack.content).toEqual(new Uint8Array(0));
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// index pass equivalence — the regression net every later part of the
// streaming-index-pass change is measured against. Each corpus case's
// (id, crc32, offset) set is asserted against an oracle the indexer had no
// hand in producing: `buildSyntheticPack`'s own independently-computed
// `ids`/`offsets`, plus a crc32 recomputed fresh from the packed bytes —
// never a snapshot of what today's code returns.
// ─────────────────────────────────────────────────────────────────────────────

interface OracleEntry {
  readonly id: string;
  readonly crc32: number;
  readonly offset: number;
}

/**
 * The oracle: `built.ids[i]`/`built.offsets[i]` are the fixture builder's
 * own independently-computed values (never derived from the indexer under
 * test), and each entry's crc32 is recomputed fresh over the raw bytes
 * `[offsets[i], offsets[i + 1])` — the same span `buildSyntheticPack`
 * computed its own (unexposed) `crc32Values` over, but read back through
 * the exported `crc32` function rather than trusted from the builder.
 */
const oracleWalkedEntries = (
  built: Awaited<ReturnType<typeof buildSyntheticPack>>,
  digestLength: number,
): OracleEntry[] =>
  built.ids.map((id, i) => {
    const start = built.offsets[i] as number;
    const end = built.offsets[i + 1] ?? built.packBytes.length - digestLength;
    return { id, crc32: crc32(built.packBytes.subarray(start, end)), offset: start };
  });

/** Every offset is unique per entry, so sorting by offset gives a canonical
 *  order for a set comparison — including the `duplicate-oid` corpus case,
 *  where several entries share an id but never an offset. */
const byOffsetAscending = <T extends { readonly offset: number }>(items: ReadonlyArray<T>): T[] =>
  [...items].sort((a, b) => a.offset - b.offset);

/** Reads every `.idx` position's `(id, crc32, offset)` triple directly,
 *  rather than looking entries up by id — `lookupPackIndex`/
 *  `lookupPackIndexPosition` assume a unique oid per index, which the
 *  `duplicate-oid` corpus case deliberately violates. */
const idxEntries = (idx: ReturnType<typeof parsePackIndex>): OracleEntry[] =>
  entryOffsets(idx).map((offset, position) => ({
    id: objectIdAt(idx, position) as string,
    crc32: idx._view.getUint32(idx.crc32TableOffset + position * 4),
    offset,
  }));

describe('index pass equivalence', () => {
  const OFS_CHAIN_1000_TIMEOUT_MS = 30_000;

  for (const corpusCase of INDEX_PASS_CORPUS) {
    describe(`Given the "${corpusCase.name}" corpus case`, () => {
      describe('When walkPackEntries walks the in-memory pack', () => {
        it(
          "Then the resulting (id, crc32, offset) set matches the fixture builder's own oracle",
          async () => {
            // Arrange
            const ctx = createMemoryContext();
            const entries = await corpusCase.entries(ctx);
            const built = await buildSyntheticPack(ctx, entries);
            const expected = byOffsetAscending(oracleWalkedEntries(built, ctx.hash.digestLength));

            // Act
            const result = await walkPackEntries(ctx, built.packBytes);

            // Assert
            expect(byOffsetAscending(result)).toEqual(expected);
          },
          corpusCase.name === 'ofs-chain-depth-1000' ? OFS_CHAIN_1000_TIMEOUT_MS : undefined,
        );
      });

      describe('When fetchPack walks the quarantined pack from disk', () => {
        it(
          corpusCase.name === 'empty-pack'
            ? 'Then it reaches the zero-entry suppression path: objectCount 0 and no .idx written'
            : "Then the resulting .idx entries match the fixture builder's own oracle",
          async () => {
            // Arrange
            const ctx = createMemoryContext();
            const entries = await corpusCase.entries(ctx);
            const built = await buildSyntheticPack(ctx, entries);
            // Chunked, not `buildUploadPackResponseBody`'s single frame: a
            // few corpus cases (multi-window, deep chains) produce packs
            // past the 65 516-byte pkt-line payload cap.
            const body = buildMultiChunkSidebandBody(built.packBytes, 32_768);
            const { transport } = captureRequests(body);
            const wants = [(built.ids[0] ?? 'a'.repeat(40)) as ObjectId];

            // Act
            const result = await fetchPack(ctx, toNegotiator(transport), {
              wants,
              haves: [],
              capabilities: ['side-band-64k', 'ofs-delta'],
              progressOp: 'test:write-objects',
            });

            // Assert
            if (corpusCase.name === 'empty-pack') {
              expect(result.objectCount).toBe(0);
              expect(result.idxPath).toBe('');
              return;
            }
            const expected = byOffsetAscending(oracleWalkedEntries(built, ctx.hash.digestLength));
            const idx = parsePackIndex(
              await ctx.fs.read(result.idxPath),
              ctx.hash.digestLength as 20 | 32,
            );
            expect(idx.objectCount).toBe(expected.length);
            expect(byOffsetAscending(idxEntries(idx))).toEqual(expected);
          },
          corpusCase.name === 'ofs-chain-depth-1000' ? OFS_CHAIN_1000_TIMEOUT_MS : undefined,
        );
      });
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// index pass equivalence — the record store's offsets stay strictly
// ascending even when resolution order does not match offset order.
// `scanEntries` (pass 1) appends every record in strictly increasing pack
// offset, so the store's documented strictly-ascending-`offsets` invariant
// holds by construction, not by a sort — pinned here against a future
// refactor that walked entries in a different order (e.g. resolution order,
// which pass 2's root-down walk does not follow either).
// ─────────────────────────────────────────────────────────────────────────────

describe('index pass equivalence — record-store offset ordering', () => {
  const RESOLUTION_ORDER_CASES = ['ref-delta-before-base', 'branching-forest'] as const;

  const assertStrictlyAscending = (offsets: ReadonlyArray<number>): void => {
    expect(offsets.length).toBeGreaterThan(1);
    for (let i = 1; i < offsets.length; i += 1) {
      expect(offsets[i]!).toBeGreaterThan(offsets[i - 1]!);
    }
  };

  for (const caseName of RESOLUTION_ORDER_CASES) {
    const corpusCase = INDEX_PASS_CORPUS.find((c) => c.name === caseName);
    if (corpusCase === undefined) {
      throw new Error(`corpus case "${caseName}" not found`);
    }

    // `PackIndexEntries` documents emission order — ascending pack offset — as
    // its contract, and the walk resolves in dependency order, not offset
    // order. Both entry points expose the producer's own order directly:
    // `walkPackEntries` materialises the slab positionally, and
    // `indexQuarantinedPack` returns the slab itself. Neither needs the record
    // store mocked to see it, and the `.idx`/`.rev` bytes cannot show it —
    // both re-derive their own ordering from the values.
    describe(`Given the "${caseName}" corpus case, whose resolution order differs from its offset order`, () => {
      describe('When it is walked from memory', () => {
        it('Then the returned entries are in strictly ascending offset order', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const built = await buildSyntheticPack(ctx, await corpusCase.entries(ctx));

          // Act
          const result = await walkPackEntries(ctx, built.packBytes);

          // Assert
          assertStrictlyAscending(result.map((entry) => entry.offset));
        });
      });

      describe('When it is indexed from a quarantined file on disk', () => {
        it('Then the handed-over PackIndexEntries.offsets is strictly ascending', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const built = await buildSyntheticPack(ctx, await corpusCase.entries(ctx));
          const tmpPath = `${ctx.layout.gitDir}/objects/pack/tmp_pack_order_${caseName}`;
          await ctx.fs.write(tmpPath, built.packBytes);

          // Act
          const view = await indexQuarantinedPack(
            ctx,
            tmpPath,
            built.packBytes.length,
            async () => {
              await ctx.fs.rmRecursive(tmpPath);
            },
          );

          // Assert
          assertStrictlyAscending(Array.from(view.offsets.subarray(0, view.count)));
        });
      });
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// index pass equivalence — the anti-producer-fork oracle. `buildPack`
// (locally built packs) and `indexQuarantinedPack` (received packs) are the
// two producers of a `PackIndexEntries` slab; feeding the SAME physical
// bytes through both must yield the same `.idx`/`.rev`/`.mtimes` output, or
// the two producers have silently forked on stride, digest width, or
// emission order.
// ─────────────────────────────────────────────────────────────────────────────

describe('index pass equivalence — anti-producer-fork oracle', () => {
  describe('Given a pack built by buildPack, then re-indexed via indexQuarantinedPack, When both producers write their sibling artifacts', () => {
    it('Then both producers agree byte-for-byte on the .idx, .rev and .mtimes bytes', async () => {
      // Arrange — two similar blobs so buildPack's delta path has a real
      // chance to emit an OFS_DELTA, exercising both producers' delta
      // handling alongside the base-entry case.
      const ctx = createMemoryContext();
      const idA = await writeObject(ctx, {
        type: 'blob',
        content: ENCODER.encode('anti-producer-fork base content'),
        id: '' as ObjectId,
      });
      const idB = await writeObject(ctx, {
        type: 'blob',
        content: ENCODER.encode('anti-producer-fork base content, extended a little'),
        id: '' as ObjectId,
      });
      const built = await buildPack(ctx, { oids: [idA, idB], delta: true });
      const tmpPath = `${ctx.layout.gitDir}/objects/pack/tmp_pack_s3_oracle`;
      await ctx.fs.write(tmpPath, built.bytes);

      // Act — index the EXACT SAME bytes buildPack produced, through the
      // OTHER producer.
      const reindexed = await indexQuarantinedPack(ctx, tmpPath, built.bytes.length, async () => {
        await ctx.fs.rmRecursive(tmpPath);
      });
      const packChecksum = hexToBytes(built.sha);
      const mtimeOf = (): number => 0;
      const fromBuild = sortPackIndexEntries(built.entries);
      const fromReindex = sortPackIndexEntries(reindexed);

      // Assert
      expect(serializePackIndex(fromReindex, packChecksum)).toEqual(
        serializePackIndex(fromBuild, packChecksum),
      );
      expect(serializePackRevIndex(fromReindex, packChecksum)).toEqual(
        serializePackRevIndex(fromBuild, packChecksum),
      );
      expect(serializeCruftMtimes(fromReindex, packChecksum, mtimeOf)).toEqual(
        serializeCruftMtimes(fromBuild, packChecksum, mtimeOf),
      );
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// index pass equivalence — the base cache budget sweep. The base
// cache is an optimisation over an already-correct walk: every corpus case
// runs TWICE, at baseCacheMaxBytes 0 and at the shipped default, and the two
// runs must agree on everything except latency. `budget 0` is not a special
// case in the implementation (createLruCache(0, …)'s `byteSize > maxSizeBytes`
// guard simply never admits an entry), so this sweep is what proves that
// degenerate path stays correct rather than merely "never crashes".
// ─────────────────────────────────────────────────────────────────────────────

const BASE_CACHE_BUDGET_SWEEP: ReadonlyArray<number> = [0, INDEX_PASS_BASE_CACHE_MAX_BYTES];

describe('index pass equivalence — base cache budget sweep', () => {
  const DEEP_CHAIN_TIMEOUT_MS = 30_000;

  for (const corpusCase of INDEX_PASS_CORPUS) {
    describe(`Given the "${corpusCase.name}" corpus case`, () => {
      describe('When walkPackEntries walks it at baseCacheMaxBytes 0 and at the default', () => {
        it(
          'Then both runs produce the identical (id, crc32, offset) set',
          async () => {
            // Arrange
            const results: ReadonlyArray<
              ReadonlyArray<{
                readonly id: string;
                readonly crc32: number;
                readonly offset: number;
              }>
            > = await Promise.all(
              BASE_CACHE_BUDGET_SWEEP.map(async (baseCacheMaxBytes) => {
                const ctx = createMemoryContext();
                const entries = await corpusCase.entries(ctx);
                const built = await buildSyntheticPack(ctx, entries);
                const options: IndexPackOptions = { baseCacheMaxBytes };

                // Act
                const result = await walkPackEntries(ctx, built.packBytes, undefined, options);
                return byOffsetAscending(result);
              }),
            );

            // Assert
            expect(results[1]).toEqual(results[0]);
          },
          corpusCase.name === 'ofs-chain-depth-1000' ? DEEP_CHAIN_TIMEOUT_MS : undefined,
        );
      });

      describe('When indexQuarantinedPack indexes it at baseCacheMaxBytes 0 and at the default', () => {
        it(
          'Then both runs produce byte-identical .idx and .rev output',
          async () => {
            // Arrange
            const serialized = await Promise.all(
              BASE_CACHE_BUDGET_SWEEP.map(async (baseCacheMaxBytes, i) => {
                const ctx = createMemoryContext();
                const entries = await corpusCase.entries(ctx);
                const built = await buildSyntheticPack(ctx, entries);
                const tmpPath = `${ctx.layout.gitDir}/objects/pack/tmp_pack_budget_sweep_${i}`;
                await ctx.fs.write(tmpPath, built.packBytes);
                const options: IndexPackOptions = { baseCacheMaxBytes };

                // Act
                const view = await indexQuarantinedPack(
                  ctx,
                  tmpPath,
                  built.packBytes.length,
                  async () => {
                    await ctx.fs.rmRecursive(tmpPath);
                  },
                  options,
                );
                const packChecksum = built.packBytes.slice(-ctx.hash.digestLength);
                const sorted = sortPackIndexEntries(view);
                return {
                  idx: serializePackIndex(sorted, packChecksum),
                  rev: serializePackRevIndex(sorted, packChecksum),
                };
              }),
            );

            // Assert
            expect(serialized[1]?.idx).toEqual(serialized[0]?.idx);
            expect(serialized[1]?.rev).toEqual(serialized[0]?.rev);
          },
          corpusCase.name === 'ofs-chain-depth-1000' ? DEEP_CHAIN_TIMEOUT_MS : undefined,
        );
      });
    });
  }
});

describe('Given one session walked twice, the second walk asking for a different cache budget', () => {
  describe('When the second walk would hit the cache the first walk filled', () => {
    it('Then it gets the budget it asked for, not the budget the session was first opened with', async () => {
      // Arrange — one base with one child, so the root is cached in pass 1 and
      // re-read in pass 2 only on a miss. The session is shared deliberately:
      // the slot is keyed on it, and a slot that ignored the later budget would
      // serve the first walk's cache to the second.
      const ctx = createMemoryContext();
      const base = new Uint8Array(4096).fill(7);
      const target = new Uint8Array(4097).fill(7);
      const { packBytes } = await buildSyntheticPack(ctx, [
        { kind: 'base', type: 'blob', content: base },
        { kind: 'ofs-delta', baseIndex: 0, targetContent: target },
      ]);
      const inflateCallsFor = async (baseCacheMaxBytes: number): Promise<number> => {
        const spy = vi.fn(ctx.compressor.streamInflate);
        const spyCtx: Context = {
          ...ctx,
          compressor: { ...ctx.compressor, streamInflate: spy },
        };
        await walkPackEntries(spyCtx, packBytes, undefined, { baseCacheMaxBytes });
        return spy.mock.calls.length;
      };

      // Act — a generous budget first, then none at all, over the same session.
      const withCache = await inflateCallsFor(1024 * 1024);
      const withoutCache = await inflateCallsFor(0);

      // Assert — disabling the cache costs the root's second read. If the slot
      // ignored the second budget, both numbers would be equal.
      expect(withoutCache).toBe(withCache + 1);
    });
  });
});

describe('Given two REF deltas naming one base the external resolver cannot find', () => {
  describe('When the pack is walked', () => {
    it('Then the resolver is consulted once for that oid, not once per delta', async () => {
      // Arrange — a not-found answer is cached too, which is the whole reason
      // the indexer records `{ found: false }`. Without it the refusal is
      // identical, so only the call count can observe the memoisation.
      const ctx = createMemoryContext();
      const baseContent = ENCODER.encode('absent shared base');
      const baseHeader = ENCODER.encode(`blob ${baseContent.length}\0`);
      const baseRaw = new Uint8Array(baseHeader.length + baseContent.length);
      baseRaw.set(baseHeader, 0);
      baseRaw.set(baseContent, baseHeader.length);
      const baseId = await ctx.hash.hashHex(baseRaw);
      const { packBytes } = await buildSyntheticPack(ctx, [
        {
          kind: 'ref-delta',
          baseId,
          baseUncompressed: baseContent,
          targetContent: ENCODER.encode('absent shared base, first derivation'),
        } as EntrySpec,
        {
          kind: 'ref-delta',
          baseId,
          baseUncompressed: baseContent,
          targetContent: ENCODER.encode('absent shared base, second derivation'),
        } as EntrySpec,
      ]);
      const resolve = vi.fn<ExternalBaseResolver>(async () => undefined);

      // Act
      let caught: unknown;
      try {
        await walkPackEntries(ctx, packBytes, resolve);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect((caught as TsgitError).data).toEqual(
        expect.objectContaining({
          code: 'INVALID_PACK_HEADER',
          reason: expect.stringContaining('unresolved delta'),
        }),
      );
      expect(resolve).toHaveBeenCalledTimes(1);
    });
  });
});

describe('index pass equivalence — base cache budget sweep, thin-pack half', () => {
  const buildThinPackForBudgetSweep = async (ctx: ReturnType<typeof createMemoryContext>) => {
    const baseContent = ENCODER.encode('budget-sweep thin-pack base content');
    const baseHeader = ENCODER.encode(`blob ${baseContent.length}\0`);
    const baseRaw = new Uint8Array(baseHeader.length + baseContent.length);
    baseRaw.set(baseHeader, 0);
    baseRaw.set(baseContent, baseHeader.length);
    const baseId = await ctx.hash.hashHex(baseRaw);
    const targetContent = ENCODER.encode('budget-sweep thin-pack derived content');
    const { packBytes } = await buildSyntheticPack(ctx, [
      { kind: 'ref-delta', baseId, baseUncompressed: baseContent, targetContent } as EntrySpec,
    ]);
    return { packBytes, baseId, baseContent };
  };

  describe('Given a thin pack whose external base resolver finds the base, When it is walked at base cache budget 0 and at the default', () => {
    it('Then both budgets resolve the delta to the identical entry set', async () => {
      // Arrange
      const results = await Promise.all(
        BASE_CACHE_BUDGET_SWEEP.map(async (baseCacheMaxBytes) => {
          const ctx = createMemoryContext();
          const { packBytes, baseId, baseContent } = await buildThinPackForBudgetSweep(ctx);
          const resolveBase: ExternalBaseResolver = async (oid) =>
            oid === baseId ? { type: 'blob', content: baseContent } : undefined;
          const options: IndexPackOptions = { baseCacheMaxBytes };

          // Act
          return walkPackEntries(ctx, packBytes, resolveBase, options);
        }),
      );

      // Assert
      expect(results[1]).toEqual(results[0]);
    });
  });

  describe('Given a thin pack whose external base resolver never finds the base, When it is walked at base cache budget 0 and at the default', () => {
    it('Then both budgets refuse with the identical error data', async () => {
      // Arrange
      const caught = await Promise.all(
        BASE_CACHE_BUDGET_SWEEP.map(async (baseCacheMaxBytes) => {
          const ctx = createMemoryContext();
          const { packBytes } = await buildThinPackForBudgetSweep(ctx);
          const resolveBase: ExternalBaseResolver = async () => undefined;
          const options: IndexPackOptions = { baseCacheMaxBytes };

          // Act
          try {
            await walkPackEntries(ctx, packBytes, resolveBase, options);
            return undefined;
          } catch (err) {
            return (err as TsgitError).data;
          }
        }),
      );

      // Assert
      expect(caught[1]).toEqual(caught[0]);
      expect(caught[0]).toEqual({
        code: 'INVALID_PACK_HEADER',
        reason: 'pack has 1 unresolved delta',
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// the base cache's own invariants: bounded, keyed so two passes on one
// session never collide, cleared on both the success and the failure exit.
// ─────────────────────────────────────────────────────────────────────────────

describe('index pass base cache — invariants', () => {
  describe('Given two packs each carrying a filler base-with-child ahead of a second base-with-child at the identical offset but with different content, When both are walked CONCURRENTLY over one session', () => {
    it("Then each pack's own result matches its own oracle — pass B's write never leaks into pass A's read of the same offset", async () => {
      // Arrange — the filler pair is byte-identical in both packs, so the
      // second (colliding) base lands at the SAME offset in both — the only
      // way to construct a genuine collision on `o:<passId>:<offset>`
      // without control over internal timing. Concurrency (not two
      // sequential calls) is essential: a single call's own pass-1 write for
      // an offset always precedes that SAME call's pass-2 read of it, so a
      // collision is unobservable unless a DIFFERENT, still-in-flight pass
      // writes the identical key in between — which requires the two
      // `walkPackEntries` calls to genuinely overlap. Confirmed against a
      // deliberately-broken build (passId forced to a constant): this exact
      // construction reproduces cross-pack corruption (an `INVALID_DELTA`
      // from a delta applied against the wrong pack's cached base) under
      // `Promise.all`, and stays green as written here.
      const ctx = createMemoryContext();
      const fillerBase = ENCODER.encode('shared filler base content, identical in both packs');
      const fillerTarget = ENCODER.encode('shared filler derived content, identical in both packs');
      const packAEntries: EntrySpec[] = [
        { kind: 'base', type: 'blob', content: fillerBase },
        { kind: 'ofs-delta', baseIndex: 0, targetContent: fillerTarget },
        { kind: 'base', type: 'blob', content: ENCODER.encode('pack A colliding base content') },
        {
          kind: 'ofs-delta',
          baseIndex: 2,
          targetContent: ENCODER.encode('pack A colliding derived'),
        },
      ];
      const packBEntries: EntrySpec[] = [
        { kind: 'base', type: 'blob', content: fillerBase },
        { kind: 'ofs-delta', baseIndex: 0, targetContent: fillerTarget },
        {
          kind: 'base',
          type: 'blob',
          content: ENCODER.encode('pack B colliding — DIFFERENT!!'),
        },
        {
          kind: 'ofs-delta',
          baseIndex: 2,
          targetContent: ENCODER.encode('pack B colliding derived'),
        },
      ];
      const builtA = await buildSyntheticPack(ctx, packAEntries);
      const builtB = await buildSyntheticPack(ctx, packBEntries);
      expect(builtA.offsets[2]).toBe(builtB.offsets[2]);
      const expectedA = byOffsetAscending(oracleWalkedEntries(builtA, ctx.hash.digestLength));
      const expectedB = byOffsetAscending(oracleWalkedEntries(builtB, ctx.hash.digestLength));

      // Act
      const [resultA, resultB] = await Promise.all([
        walkPackEntries(ctx, builtA.packBytes),
        walkPackEntries(ctx, builtB.packBytes),
      ]);

      // Assert
      expect(byOffsetAscending(resultA)).toEqual(expectedA);
      expect(byOffsetAscending(resultB)).toEqual(expectedB);
    });
  });

  describe('Given a thin pack whose external base resolver is spied, When it is walked twice over one session', () => {
    it('Then the resolver is invoked once per walk — the cache is cleared, not reused, across passes', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const baseContent = ENCODER.encode('clear-on-success base content');
      const baseHeader = ENCODER.encode(`blob ${baseContent.length}\0`);
      const baseRaw = new Uint8Array(baseHeader.length + baseContent.length);
      baseRaw.set(baseHeader, 0);
      baseRaw.set(baseContent, baseHeader.length);
      const baseId = await ctx.hash.hashHex(baseRaw);
      const buildPack = async (label: string) => {
        const { packBytes } = await buildSyntheticPack(ctx, [
          {
            kind: 'ref-delta',
            baseId,
            baseUncompressed: baseContent,
            targetContent: ENCODER.encode(`clear-on-success derived ${label}`),
          } as EntrySpec,
        ]);
        return packBytes;
      };
      const resolveBase = vi.fn<ExternalBaseResolver>(async (oid) =>
        oid === baseId ? { type: 'blob', content: baseContent } : undefined,
      );

      // Act
      await walkPackEntries(ctx, await buildPack('first'), resolveBase);
      await walkPackEntries(ctx, await buildPack('second'), resolveBase);

      // Assert — a leaked cache entry from the first pass would serve the
      // second pass's identical base oid without ever calling the resolver.
      expect(resolveBase).toHaveBeenCalledTimes(2);
    });
  });

  describe('Given a first pack that resolves one external base then refuses on an unrelated unresolved delta, When a second pack needing that same external base is walked over the same session', () => {
    it('Then the second pack still calls the resolver — the cache is cleared on the failure exit, not only the success one', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const baseContent = ENCODER.encode('clear-on-failure base content');
      const baseHeader = ENCODER.encode(`blob ${baseContent.length}\0`);
      const baseRaw = new Uint8Array(baseHeader.length + baseContent.length);
      baseRaw.set(baseHeader, 0);
      baseRaw.set(baseContent, baseHeader.length);
      const baseId = await ctx.hash.hashHex(baseRaw);
      const unresolvableBaseId = 'f'.repeat(40);
      const resolveBase = vi.fn<ExternalBaseResolver>(async (oid) =>
        oid === baseId ? { type: 'blob', content: baseContent } : undefined,
      );
      const { packBytes: firstPackBytes } = await buildSyntheticPack(ctx, [
        {
          kind: 'ref-delta',
          baseId,
          baseUncompressed: baseContent,
          targetContent: ENCODER.encode('clear-on-failure resolvable derived'),
        },
        {
          kind: 'ref-delta',
          baseId: unresolvableBaseId,
          baseUncompressed: ENCODER.encode('never present'),
          targetContent: ENCODER.encode('clear-on-failure unresolvable derived'),
        },
      ] as EntrySpec[]);
      const { packBytes: secondPackBytes } = await buildSyntheticPack(ctx, [
        {
          kind: 'ref-delta',
          baseId,
          baseUncompressed: baseContent,
          targetContent: ENCODER.encode('clear-on-failure second-pack derived'),
        } as EntrySpec,
      ]);

      // Act
      let firstCallThrew = false;
      try {
        await walkPackEntries(ctx, firstPackBytes, resolveBase);
      } catch {
        firstCallThrew = true;
      }
      await walkPackEntries(ctx, secondPackBytes, resolveBase);

      // Assert
      expect(firstCallThrew).toBe(true);
      expect(resolveBase).toHaveBeenCalledWith(baseId);
      const callsForBase = resolveBase.mock.calls.filter(([oid]) => oid === baseId);
      expect(callsForBase).toHaveLength(2);
    });
  });

  describe('Given a pack with more base-with-children roots than the base cache holds entries for, every base tiny enough that the byte budget alone would never evict, When it is walked', () => {
    it('Then the entry cap evicts the earliest roots independently of the byte budget', async () => {
      // Arrange — one base blob + one ofs-delta child per pair, so pass 1
      // inflates 2 entries and pass 2 inflates the child (always) plus the
      // root (only on a cache miss) per pair. `ENTRY_CAP_OVERFLOW` pairs
      // exceed the cache's entry cap while their combined bytes stay a tiny
      // fraction of the byte budget explicitly forced generous below — an
      // isolated entry-count guard, never the byte guard `createLruCache`
      // already proves independently (at the default budget, this many
      // entries' own per-entry overhead alone would exceed it, conflating
      // the two guards).
      const ENTRY_CAP_OVERFLOW = 2;
      const FORCED_ENTRY_CAP = 4;
      const pairCount = FORCED_ENTRY_CAP + ENTRY_CAP_OVERFLOW;
      const GENEROUS_BYTE_BUDGET = 64 * 1024 * 1024;
      const ctx = createMemoryContext();
      const entries: EntrySpec[] = [];
      for (let i = 0; i < pairCount; i += 1) {
        entries.push({ kind: 'base', type: 'blob', content: new Uint8Array([i & 0xff]) });
        entries.push({
          kind: 'ofs-delta',
          baseIndex: entries.length - 1,
          targetContent: new Uint8Array([i & 0xff, 1]),
        });
      }
      const built = await buildSyntheticPack(ctx, entries);
      const streamInflateSpy = vi.fn(ctx.compressor.streamInflate);
      const spyCtx: Context = {
        ...ctx,
        compressor: { ...ctx.compressor, streamInflate: streamInflateSpy },
      };
      const options: IndexPackOptions = {
        baseCacheMaxBytes: GENEROUS_BYTE_BUDGET,
        baseCacheMaxEntries: FORCED_ENTRY_CAP,
      };

      // Act
      await walkPackEntries(spyCtx, built.packBytes, undefined, options);

      // Assert — pass 1: 2 inflates per pair (base + delta). pass 2: 1
      // inflate per pair for the child (always) plus 1 more for every root
      // NOT served from cache. If the entry cap bound correctly, exactly
      // `ENTRY_CAP_OVERFLOW` of the earliest roots were evicted and missed;
      // fewer misses would mean the entry cap let the pack overflow it.
      const expectedCalls = 3 * pairCount + ENTRY_CAP_OVERFLOW;
      expect(streamInflateSpy).toHaveBeenCalledTimes(expectedCalls);
    });
  });

  describe('Given a zero-length base entry with one child, When the child is resolved through the base cache', () => {
    it('Then it is cached and served without the sizer ever needing a non-positive byteSize', async () => {
      // Arrange — the fixed per-entry overhead is what keeps the sizer's
      // result positive for a zero-length base's content; if a future edit
      // dropped that overhead, `LruCache.set`'s `byteSize must be positive`
      // guard would throw synchronously out of pass 1, uncaught by any
      // `TsgitError` refusal path.
      const ctx = createMemoryContext();
      const entries: EntrySpec[] = [
        { kind: 'base', type: 'blob', content: new Uint8Array(0) },
        { kind: 'ofs-delta', baseIndex: 0, targetContent: ENCODER.encode('derived from empty') },
      ];
      const built = await buildSyntheticPack(ctx, entries);
      const expected = byOffsetAscending(oracleWalkedEntries(built, ctx.hash.digestLength));

      // Act
      const result = await walkPackEntries(ctx, built.packBytes);

      // Assert
      expect(byOffsetAscending(result)).toEqual(expected);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// walkPackEntries — declared-size cap parity between the in-memory and disk
// byte sources
// ─────────────────────────────────────────────────────────────────────────────

describe('walkPackEntries', () => {
  describe('Given a pack entry whose zlib stream inflates past its declared header size', () => {
    describe('When walkPackEntries walks it from an in-memory buffer', () => {
      it('Then it refuses instead of inflating past the declared size — mirrors the disk-source refusal', async () => {
        // Arrange — same construction as the disk-source "oversize-declare"
        // pin in `quarantine disk-backed entry walk` above: declared size 5,
        // but the zlib stream is a valid, complete encoding of 10 bytes. The
        // in-memory source must bound `streamInflate` to the declared size
        // exactly like the disk source does, or identical bytes are refused
        // from disk and silently accepted in memory.
        const ctx = createMemoryContext();
        const header = new Uint8Array(12);
        const dv = new DataView(header.buffer);
        dv.setUint32(0, 0x5041434b);
        dv.setUint32(4, 2);
        dv.setUint32(8, 1);
        const declaredSize = 5;
        const actualPayload = ENCODER.encode('AAAAAAAAAA'); // 10 bytes, > declaredSize
        const entryHeaderByte = encodePackEntryHeader(PACK_ENTRY_TYPE.BLOB, declaredSize);
        const zlibStream = await ctx.compressor.deflate(actualPayload);
        const bodyBytes = new Uint8Array(
          header.length + entryHeaderByte.length + zlibStream.length,
        );
        bodyBytes.set(header, 0);
        bodyBytes.set(entryHeaderByte, header.length);
        bodyBytes.set(zlibStream, header.length + entryHeaderByte.length);
        const trailerHex = await ctx.hash.hashHex(bodyBytes);
        const packBytes = new Uint8Array(bodyBytes.length + 20);
        packBytes.set(bodyBytes, 0);
        packBytes.set(hexToBytes(trailerHex), bodyBytes.length);
        const sut = walkPackEntries;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, packBytes);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; reason?: string };
        expect(data.code).toBe('DECOMPRESS_FAILED');
        expect(data.reason).toContain('safety cap');
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// walkPackEntries — external base resolver (thin-pack completion)
// ─────────────────────────────────────────────────────────────────────────────

describe('walkPackEntries', () => {
  describe('Given a pack with a REF_DELTA whose base object is absent from the pack', () => {
    const buildThinPack = async (ctx: ReturnType<typeof createMemoryContext>) => {
      const baseContent = ENCODER.encode('base object content for thin-pack test');
      const baseHeader = ENCODER.encode(`blob ${baseContent.length}\0`);
      const baseRaw = new Uint8Array(baseHeader.length + baseContent.length);
      baseRaw.set(baseHeader, 0);
      baseRaw.set(baseContent, baseHeader.length);
      const baseId = await ctx.hash.hashHex(baseRaw);
      const targetContent = ENCODER.encode('derived content for thin-pack test');
      const { packBytes } = await buildSyntheticPack(ctx, [
        {
          kind: 'ref-delta',
          baseId,
          baseUncompressed: baseContent,
          targetContent,
        } as EntrySpec,
      ]);
      return { packBytes, baseId, baseContent, targetContent };
    };

    describe('When walkPackEntries is called without an external resolver', () => {
      it('Then throws "pack has 1 unresolved delta"', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { packBytes } = await buildThinPack(ctx);

        // Act
        let caught: unknown;
        try {
          await walkPackEntries(ctx, packBytes);
        } catch (err) {
          caught = err;
        }

        // Assert — git's own count, singular at one; the base id is no
        // longer named.
        expect(caught).toBeInstanceOf(TsgitError);
        const tsErr = caught as TsgitError;
        expect(tsErr.data.code).toBe('INVALID_PACK_HEADER');
        expect((tsErr.data as { reason: string }).reason).toBe('pack has 1 unresolved delta');
      });
    });

    describe('When walkPackEntries is called with a resolver that returns the base', () => {
      it('Then resolves the delta and returns the derived entry with its computed oid', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { packBytes, baseId, baseContent, targetContent } = await buildThinPack(ctx);

        const resolveBase: ExternalBaseResolver = async (oid) => {
          if (oid !== baseId) return undefined;
          return { type: 'blob', content: baseContent };
        };

        // Act
        const result = await walkPackEntries(ctx, packBytes, resolveBase);

        // Assert — one derived entry, id matches the target blob sha
        expect(result).toHaveLength(1);
        const targetHeader = ENCODER.encode(`blob ${targetContent.length}\0`);
        const targetRaw = new Uint8Array(targetHeader.length + targetContent.length);
        targetRaw.set(targetHeader, 0);
        targetRaw.set(targetContent, targetHeader.length);
        const expectedId = await ctx.hash.hashHex(targetRaw);
        expect(result[0]?.id).toBe(expectedId);
      });
    });

    describe('When walkPackEntries is called with a resolver that returns undefined', () => {
      it('Then still throws "pack has 1 unresolved delta"', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { packBytes } = await buildThinPack(ctx);

        const resolveBase: ExternalBaseResolver = async (_oid) => undefined;

        // Act
        let caught: unknown;
        try {
          await walkPackEntries(ctx, packBytes, resolveBase);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const tsErr = caught as TsgitError;
        expect(tsErr.data.code).toBe('INVALID_PACK_HEADER');
        expect((tsErr.data as { reason: string }).reason).toBe('pack has 1 unresolved delta');
      });
    });

    describe('When walkPackEntries is called with a resolver that returns a base of the wrong size', () => {
      it('Then throws INVALID_DELTA instead of silently reconstructing garbage', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { packBytes, baseId, baseContent } = await buildThinPack(ctx);
        const wrongSizedContent = new Uint8Array(baseContent.length + 5);

        const resolveBase: ExternalBaseResolver = async (oid) => {
          if (oid !== baseId) return undefined;
          return { type: 'blob', content: wrongSizedContent };
        };

        // Act
        let caught: unknown;
        try {
          await walkPackEntries(ctx, packBytes, resolveBase);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const tsErr = caught as TsgitError;
        expect(tsErr.data.code).toBe('INVALID_DELTA');
        expect((tsErr.data as { reason: string }).reason).toContain('source length mismatch');
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// quarantine tmp-name shape and claim-loop edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('quarantine tmp-name claiming', () => {
  describe('Given a normal (non-colliding) quarantine claim', () => {
    describe('When fetchPack drains a pack into quarantine', () => {
      it("Then the claimed name matches git's tmp_pack_ + 6-char alphabet shape exactly", async () => {
        // Arrange
        const baseCtx = createMemoryContext();
        const { packBytes, blobId } = await buildSingleBlobPack(baseCtx, 'shape check\n');
        let claimedPath: string | undefined;
        const ctx = withFsPatch(baseCtx, {
          writeExclusive: async (path: string, data: Uint8Array): Promise<void> => {
            claimedPath ??= path;
            return baseCtx.fs.writeExclusive(path, data);
          },
        });
        const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
        const { transport } = captureRequests(body);

        // Act
        await fetchPack(ctx, toNegotiator(transport), {
          wants: [blobId],
          haves: [],
          capabilities: ['side-band-64k'],
          progressOp: 'test:write-objects',
        });

        // Assert — exactly `tmp_pack_` + 6 alphabet characters, no more, no
        // fewer: a mutant that drops the suffix loop, off-by-ones it, or
        // prepends stray text all break this exact shape.
        expect(claimedPath).toMatch(/\/tmp_pack_[A-Za-z0-9]{6}$/);
      });
    });
  });

  describe('Given every candidate name colliding (a permanently occupied quarantine directory)', () => {
    describe('When fetchPack drains a pack into quarantine', () => {
      it('Then it gives up after exactly MAX_QUARANTINE_NAME_ATTEMPTS tries and reports FILE_EXISTS for this pack dir', async () => {
        // Arrange — every claim attempt collides; proves the retry loop
        // both terminates (an `attempt -= 1` mutant would spin forever
        // instead) and reports the pack directory it was claiming inside.
        const baseCtx = createMemoryContext();
        const { packBytes, blobId } = await buildSingleBlobPack(baseCtx, 'always collides\n');
        let writeExclusiveCalls = 0;
        const ctx = withFsPatch(baseCtx, {
          writeExclusive: async (): Promise<void> => {
            writeExclusiveCalls += 1;
            throw fileExists('colliding');
          },
        });
        const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
        const { transport } = captureRequests(body);

        // Act
        let caught: unknown;
        try {
          await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(writeExclusiveCalls).toBe(8);
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; path?: string };
        expect(data.code).toBe('FILE_EXISTS');
        expect(data.path).toBe(`${packDir(ctx)}/tmp_pack_<random>`);
      });
    });
  });

  describe('Given the exclusive-create call fails with something other than FILE_EXISTS', () => {
    describe('When fetchPack drains a pack into quarantine', () => {
      it('Then it propagates that failure immediately instead of retrying', async () => {
        // Arrange
        const baseCtx = createMemoryContext();
        const { packBytes, blobId } = await buildSingleBlobPack(baseCtx, 'non-collision fault\n');
        let writeExclusiveCalls = 0;
        const ctx = withFsPatch(baseCtx, {
          writeExclusive: async (): Promise<void> => {
            writeExclusiveCalls += 1;
            throw permissionDenied('quarantine claim');
          },
        });
        const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
        const { transport } = captureRequests(body);

        // Act
        let caught: unknown;
        try {
          await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });
        } catch (err) {
          caught = err;
        }

        // Assert — a single attempt, not a retry loop swallowing the fault
        expect(writeExclusiveCalls).toBe(1);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// disk-walk retry classification — raw (non-TsgitError) rejections and the
// switch's default arm
// ─────────────────────────────────────────────────────────────────────────────

describe('disk-walk retry classification', () => {
  describe('Given the entry decode rejects with a raw `undefined` (not an Error object)', () => {
    describe('When fetchPack walks the quarantined pack from disk', () => {
      it("Then the raw rejection propagates unchanged — never crashes reading `.data` off a primitive (typeof undefined !== 'object')", async () => {
        // Arrange
        const baseCtx = createMemoryContext();
        const { packBytes, blobId } = await buildSingleBlobPack(baseCtx, 'raw undefined\n');
        const ctx = {
          ...baseCtx,
          compressor: {
            ...baseCtx.compressor,
            streamInflate: (): Promise<never> => Promise.reject(undefined),
          },
        };
        const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
        const { transport } = captureRequests(body);

        // Act
        let threw = false;
        let caught: unknown;
        try {
          await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });
        } catch (err) {
          threw = true;
          caught = err;
        }

        // Assert
        expect(threw).toBe(true);
        expect(caught).toBeUndefined();
      });
    });
  });

  describe('Given the entry decode rejects with a raw `null`', () => {
    describe('When fetchPack walks the quarantined pack from disk', () => {
      it("Then the raw rejection propagates unchanged — `typeof null === 'object'` needs its own explicit null check", async () => {
        // Arrange — `typeof null === 'object'` is the JS quirk the guard's
        // second half exists for; without it this falls through to `(null).data`.
        const baseCtx = createMemoryContext();
        const { packBytes, blobId } = await buildSingleBlobPack(baseCtx, 'raw null\n');
        const ctx = {
          ...baseCtx,
          compressor: {
            ...baseCtx.compressor,
            streamInflate: (): Promise<never> => Promise.reject(null),
          },
        };
        const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
        const { transport } = captureRequests(body);

        // Act
        let threw = false;
        let caught: unknown;
        try {
          await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });
        } catch (err) {
          threw = true;
          caught = err;
        }

        // Assert
        expect(threw).toBe(true);
        expect(caught).toBeNull();
      });
    });
  });

  describe('Given a large entry (window not yet at trailerStart) whose decode rejects with a raw `undefined`', () => {
    describe('When fetchPack walks the quarantined pack from disk', () => {
      it('Then an undefined reason is treated as not-retryable — no growth is attempted', async () => {
        // Arrange — small packs mask this: their single window already
        // reaches trailerStart, so `growOrRethrow`'s own cap rethrows
        // immediately regardless of the retryable classification. A big
        // entry is required to prove the classification itself — not the
        // cap guard — is what stops growth here.
        const baseCtx = createMemoryContext();
        const bigContent = pseudoRandomBytes(DISK_WALK_WINDOW_BYTES + 40_000, 424_141);
        const entries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: bigContent }];
        const built = await buildSyntheticPack(baseCtx, entries);
        let readSliceCalls = 0;
        const ctx = {
          ...withFsPatch(baseCtx, {
            readSlice: async (
              path: string,
              offset: number,
              length: number,
            ): Promise<Uint8Array> => {
              readSliceCalls += 1;
              return baseCtx.fs.readSlice(path, offset, length);
            },
          }),
          compressor: {
            ...baseCtx.compressor,
            streamInflate: (): Promise<never> => Promise.reject(undefined),
          },
        };
        const body = buildMultiChunkSidebandBody(built.packBytes, 32_768);
        const { transport } = captureRequests(body);

        // Act
        let threw = false;
        let caught: unknown;
        try {
          await fetchPack(ctx, toNegotiator(transport), {
            wants: [built.ids[0] as ObjectId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });
        } catch (err) {
          threw = true;
          caught = err;
        }

        // Assert — a mutant treating an undefined reason as retryable would
        // grow the window (more readSlice calls) before eventually failing
        // the same way; this pins it to exactly one decode attempt.
        expect(threw).toBe(true);
        expect(caught).toBeUndefined();
        expect(readSliceCalls).toBe(2);
      });
    });
  });

  describe('Given a large entry whose decode fails with DECOMPRESS_FAILED but a non-truncation reason', () => {
    describe('When fetchPack walks the quarantined pack from disk', () => {
      it('Then it is not classified retryable — only the exact truncation reason grows the window', async () => {
        // Arrange — same big-entry shape as the truncation-retry pin above,
        // but the injected failure's reason is genuine corruption wording,
        // never equal to RETRYABLE_DECOMPRESS_REASON. A mutant that treats
        // every DECOMPRESS_FAILED as retryable would still grow the window
        // before ultimately failing the same way.
        const baseCtx = createMemoryContext();
        const bigContent = pseudoRandomBytes(DISK_WALK_WINDOW_BYTES + 40_000, 616_161);
        const entries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: bigContent }];
        const built = await buildSyntheticPack(baseCtx, entries);
        let readSliceCalls = 0;
        const ctx = {
          ...withFsPatch(baseCtx, {
            readSlice: async (
              path: string,
              offset: number,
              length: number,
            ): Promise<Uint8Array> => {
              readSliceCalls += 1;
              return baseCtx.fs.readSlice(path, offset, length);
            },
          }),
          compressor: {
            ...baseCtx.compressor,
            streamInflate: (): Promise<never> =>
              Promise.reject({
                data: { code: 'DECOMPRESS_FAILED', reason: 'distance exceeds output' },
              }),
          },
        };
        const body = buildMultiChunkSidebandBody(built.packBytes, 32_768);
        const { transport } = captureRequests(body);

        // Act
        let caught: unknown;
        try {
          await fetchPack(ctx, toNegotiator(transport), {
            wants: [built.ids[0] as ObjectId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(readSliceCalls).toBe(2);
        expect((caught as { data: { code: string; reason: string } }).data.reason).toBe(
          'distance exceeds output',
        );
      });
    });
  });

  describe('Given a large entry whose decode fails with an unrelated error code carrying its own reason', () => {
    describe('When fetchPack walks the quarantined pack from disk', () => {
      it('Then the switch default arm treats it as not retryable — no growth is attempted', async () => {
        // Arrange — a big entry so the held window does NOT already reach
        // trailerStart (the guard in `growOrRethrow` that would otherwise
        // mask this classification regardless of the mutant under test).
        // The injected failure carries a real `reason` string and a code
        // that is neither INVALID_PACK_ENTRY nor DECOMPRESS_FAILED, landing
        // squarely on the switch's `default` arm.
        const baseCtx = createMemoryContext();
        const bigContent = pseudoRandomBytes(DISK_WALK_WINDOW_BYTES + 40_000, 909_090);
        const entries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: bigContent }];
        const built = await buildSyntheticPack(baseCtx, entries);
        let readSliceCalls = 0;
        let streamInflateCalls = 0;
        const ctx = {
          ...withFsPatch(baseCtx, {
            readSlice: async (
              path: string,
              offset: number,
              length: number,
            ): Promise<Uint8Array> => {
              readSliceCalls += 1;
              return baseCtx.fs.readSlice(path, offset, length);
            },
          }),
          compressor: {
            ...baseCtx.compressor,
            streamInflate: (): Promise<never> => {
              streamInflateCalls += 1;
              return Promise.reject({
                data: { code: 'PERMISSION_DENIED', reason: 'synthetic default-arm probe' },
              });
            },
          },
        };
        const body = buildMultiChunkSidebandBody(built.packBytes, 32_768);
        const { transport } = captureRequests(body);

        // Act
        let caught: unknown;
        try {
          await fetchPack(ctx, toNegotiator(transport), {
            wants: [built.ids[0] as ObjectId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });
        } catch (err) {
          caught = err;
        }

        // Assert — exactly one decode attempt and the pack-header read plus
        // one entry window: a mutant treating this as retryable would grow
        // the window and try again instead of surfacing it immediately.
        expect(streamInflateCalls).toBe(1);
        expect(readSliceCalls).toBe(2);
        expect((caught as { data: { code: string } }).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given an entry header split across a too-small first window (INVALID_PACK_ENTRY, "unexpected end of header")', () => {
    describe('When fetchPack walks the quarantined pack from disk', () => {
      it('Then it is classified retryable by prefix and a grown window resolves it', async () => {
        // Arrange — a blob just over 16 bytes forces a 2-byte varint entry
        // header (continuation bit set on the first byte); truncating the
        // FIRST window response to a single byte strands the parse mid
        // varint with "unexpected end of header". The retry then gets the
        // real, full bytes and succeeds.
        const baseCtx = createMemoryContext();
        const { packBytes, blobId } = await buildSingleBlobPack(
          baseCtx,
          'a varint-forcing header content, over sixteen bytes\n',
        );
        let readSliceCalls = 0;
        const ctx = withFsPatch(baseCtx, {
          readSlice: async (path: string, offset: number, length: number): Promise<Uint8Array> => {
            readSliceCalls += 1;
            const real = await baseCtx.fs.readSlice(path, offset, length);
            // Call 1 = pack header (12 bytes) — pass through untouched.
            // Call 2 = the entry's initial window — strand it at 1 byte.
            // Call 3+ = the growth retry — pass through in full.
            return readSliceCalls === 2 ? real.subarray(0, 1) : real;
          },
        });
        const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
        const { transport } = captureRequests(body);

        // Act
        const result = await fetchPack(ctx, toNegotiator(transport), {
          wants: [blobId],
          haves: [],
          capabilities: ['side-band-64k'],
          progressOp: 'test:write-objects',
        });

        // Assert — resolved cleanly via the grown window; a mutant that
        // rejects this reason as non-retryable would instead surface
        // INVALID_PACK_ENTRY here.
        expect(result.objectCount).toBe(1);
        expect(readSliceCalls).toBeGreaterThan(2);
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// disk-walk window bookkeeping — trailer-bound clamp and same-anchor reuse
// ─────────────────────────────────────────────────────────────────────────────

describe('disk-walk window bookkeeping', () => {
  describe('Given a single entry within one entryHeader/inflateEntry pair (no growth needed)', () => {
    describe('When fetchPack walks the quarantined pack from disk', () => {
      it('Then entryHeader and inflateEntry share the SAME window fetch for that entry — exactly one window read, not two', async () => {
        // Arrange — `entryHeader(offset)` and `inflateEntry(offset, ...)`
        // are called with the identical `offset`. The second call must
        // REUSE the window the first call just fetched (anchor === held
        // window's start, satisfied by `>=`); a stricter `>` would refetch.
        const baseCtx = createMemoryContext();
        const { packBytes, blobId } = await buildSingleBlobPack(baseCtx, 'reuse at same anchor\n');
        let readSliceCalls = 0;
        const ctx = withFsPatch(baseCtx, {
          readSlice: async (path: string, offset: number, length: number): Promise<Uint8Array> => {
            readSliceCalls += 1;
            return baseCtx.fs.readSlice(path, offset, length);
          },
        });
        const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
        const { transport } = captureRequests(body);

        // Act
        const result = await fetchPack(ctx, toNegotiator(transport), {
          wants: [blobId],
          haves: [],
          capabilities: ['side-band-64k'],
          progressOp: 'test:write-objects',
        });

        // Assert — pack header (12 bytes) + exactly one shared entry window
        expect(result.objectCount).toBe(1);
        expect(readSliceCalls).toBe(2);
      });
    });
  });

  describe('Given a multi-window pack and its true entry offsets', () => {
    describe('When fetchPack walks the quarantined pack from disk', () => {
      it('Then every entry offset falls inside a window actually fetched to cover it', async () => {
        // Arrange — a window-reuse check that always returns "covered"
        // regardless of the held window's real extent would let a later
        // entry read past the window it was actually given; this proves
        // each entry's true offset was served by a read that really spans it.
        const baseCtx = createMemoryContext();
        const built = await buildMultiWindowPack(baseCtx);
        const calls: Array<{ offset: number; length: number }> = [];
        const ctx = withFsPatch(baseCtx, {
          readSlice: async (path: string, offset: number, length: number): Promise<Uint8Array> => {
            calls.push({ offset, length });
            return baseCtx.fs.readSlice(path, offset, length);
          },
        });
        const body = buildMultiChunkSidebandBody(built.packBytes, 32_768);
        const { transport } = captureRequests(body);

        // Act
        const result = await fetchPack(ctx, toNegotiator(transport), {
          wants: [built.ids[0] as ObjectId],
          haves: [],
          capabilities: ['side-band-64k'],
          progressOp: 'test:write-objects',
        });

        // Assert
        expect(result.objectCount).toBe(MULTI_WINDOW_ENTRY_COUNT);
        for (const offset of built.offsets) {
          const covered = calls.some((c) => c.offset <= offset && offset < c.offset + c.length);
          expect(covered).toBe(true);
        }
      });
    });
  });

  describe('Given a multi-window pack (a fresh, non-growth window crossing near the end)', () => {
    describe('When fetchPack walks the quarantined pack from disk', () => {
      it('Then no window fetch ever requests bytes past trailerStart', async () => {
        // Arrange
        const baseCtx = createMemoryContext();
        const built = await buildMultiWindowPack(baseCtx);
        const trailerStart = built.packBytes.length - baseCtx.hash.digestLength;
        const calls: Array<{ offset: number; length: number }> = [];
        const ctx = withFsPatch(baseCtx, {
          readSlice: async (path: string, offset: number, length: number): Promise<Uint8Array> => {
            calls.push({ offset, length });
            return baseCtx.fs.readSlice(path, offset, length);
          },
        });
        const body = buildMultiChunkSidebandBody(built.packBytes, 32_768);
        const { transport } = captureRequests(body);

        // Act
        const result = await fetchPack(ctx, toNegotiator(transport), {
          wants: [built.ids[0] as ObjectId],
          haves: [],
          capabilities: ['side-band-64k'],
          progressOp: 'test:write-objects',
        });

        // Assert — the 12-byte pack-header read is exempt (fixed, unrelated
        // to window sizing); every window fetch must stop at trailerStart.
        expect(result.objectCount).toBe(MULTI_WINDOW_ENTRY_COUNT);
        const windowCalls = calls.filter((c) => !(c.offset === 0 && c.length === 12));
        expect(windowCalls.length).toBeGreaterThan(0);
        for (const c of windowCalls) {
          expect(c.offset + c.length).toBeLessThanOrEqual(trailerStart);
        }
      });
    });
  });

  describe('Given a single entry needing a growth retry near the end of the pack', () => {
    describe('When fetchPack walks the quarantined pack from disk', () => {
      it("Then the grown window's requested length also never crosses trailerStart", async () => {
        // Arrange — content sized just past one window forces exactly one
        // growth fetch, and that growth fetch's clamp is the one under test
        // (`nextRung`'s own `trailerStart - anchor`, distinct from
        // `initialWindowSize`'s first-window clamp exercised above).
        const baseCtx = createMemoryContext();
        const bigContent = pseudoRandomBytes(DISK_WALK_WINDOW_BYTES + 40_000, 313_131);
        const entries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: bigContent }];
        const built = await buildSyntheticPack(baseCtx, entries);
        const trailerStart = built.packBytes.length - baseCtx.hash.digestLength;
        const calls: Array<{ offset: number; length: number }> = [];
        const ctx = withFsPatch(baseCtx, {
          readSlice: async (path: string, offset: number, length: number): Promise<Uint8Array> => {
            calls.push({ offset, length });
            return baseCtx.fs.readSlice(path, offset, length);
          },
        });
        const body = buildMultiChunkSidebandBody(built.packBytes, 32_768);
        const { transport } = captureRequests(body);

        // Act
        const result = await fetchPack(ctx, toNegotiator(transport), {
          wants: [built.ids[0] as ObjectId],
          haves: [],
          capabilities: ['side-band-64k'],
          progressOp: 'test:write-objects',
        });

        // Assert
        expect(result.objectCount).toBe(1);
        const windowCalls = calls.filter((c) => !(c.offset === 0 && c.length === 12));
        expect(windowCalls.length).toBeGreaterThan(1);
        for (const c of windowCalls) {
          expect(c.offset + c.length).toBeLessThanOrEqual(trailerStart);
        }
      });
    });
  });

  describe('Given a short-read filesystem that never delivers a full window for a large entry', () => {
    describe('When fetchPack walks the quarantined pack from disk', () => {
      it('Then the first growth fetch requests the plain documented window size — not a doubling of the short delivery — and gives up after exactly one non-progress retry', async () => {
        // Arrange — every readSlice delivery is capped far below both the
        // documented window and the entry's true span, so `w.bytes.length`
        // never equals `documented` even for the very first (genuinely
        // fresh) fetch. This is the same "delivered < requested" shape a
        // short-read filesystem produces, and it is the ONLY way
        // `isFreshDocumentedWindow` is false for a fetch that just happened
        // — `rung` must restart at `documented` (not double a stale value),
        // and `deliveredAtAnchor` must be set from THIS fetch (not stay
        // `undefined`) so the very next non-progress delivery is caught
        // immediately rather than after one wasted extra round trip.
        const baseCtx = createMemoryContext();
        const bigContent = pseudoRandomBytes(DISK_WALK_WINDOW_BYTES * 3, 272_727);
        const entries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: bigContent }];
        const built = await buildSyntheticPack(baseCtx, entries);
        const CAP = 100;
        const calls: Array<{ offset: number; length: number }> = [];
        const ctx = withFsPatch(baseCtx, {
          readSlice: async (path: string, offset: number, length: number): Promise<Uint8Array> => {
            calls.push({ offset, length });
            const real = await baseCtx.fs.readSlice(path, offset, length);
            return real.subarray(0, Math.min(real.length, CAP));
          },
        });
        const body = buildMultiChunkSidebandBody(built.packBytes, 32_768);
        const { transport } = captureRequests(body);

        // Act
        let caught: unknown;
        try {
          await fetchPack(ctx, toNegotiator(transport), {
            wants: [built.ids[0] as ObjectId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });
        } catch (err) {
          caught = err;
        }

        // Assert — header, initial (short) window, exactly one growth
        // attempt, then give-up: a `rung` that wrongly starts at
        // `documented` doubles this request instead of matching it, and a
        // `deliveredAtAnchor` that wrongly starts `undefined` costs one
        // extra non-progress round trip before giving up.
        expect(caught).toBeInstanceOf(TsgitError);
        expect(calls).toHaveLength(3);
        expect(calls[2]?.length).toBe(DISK_WALK_WINDOW_BYTES);
      });
    });
  });

  describe('Given a small pack (its one window already reaches trailerStart) and a retryable decode failure', () => {
    describe('When fetchPack walks the quarantined pack from disk', () => {
      it('Then growth is capped immediately — no growth fetch is attempted once the held window already spans to the trailer', async () => {
        // Arrange — a small pack's single window is `trailerStart - anchor`
        // wide by construction (`initialWindowSize`'s own clamp), so
        // `w.start + w.bytes.length` already equals `trailerStart` before
        // any retry is even considered. The injected failure carries the
        // exact retryable truncation reason so classification alone can't
        // explain a cap; only the trailerStart guard can.
        const baseCtx = createMemoryContext();
        const { packBytes, blobId } = await buildSingleBlobPack(baseCtx, 'small capped pack\n');
        let readSliceCalls = 0;
        const ctx = {
          ...withFsPatch(baseCtx, {
            readSlice: async (
              path: string,
              offset: number,
              length: number,
            ): Promise<Uint8Array> => {
              readSliceCalls += 1;
              return baseCtx.fs.readSlice(path, offset, length);
            },
          }),
          compressor: {
            ...baseCtx.compressor,
            streamInflate: (): Promise<never> =>
              Promise.reject({
                data: { code: 'DECOMPRESS_FAILED', reason: 'unexpected end of deflate stream' },
              }),
          },
        };
        const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
        const { transport } = captureRequests(body);

        // Act
        let caught: unknown;
        try {
          await fetchPack(ctx, toNegotiator(transport), {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            progressOp: 'test:write-objects',
          });
        } catch (err) {
          caught = err;
        }

        // Assert — pack header + exactly one window; a mutant that skips
        // (or off-by-ones) the trailerStart cap would attempt a growth
        // fetch here even though there is nowhere left to grow into.
        expect(readSliceCalls).toBe(2);
        expect((caught as { data: { code: string; reason: string } }).data.reason).toBe(
          'unexpected end of deflate stream',
        );
      });
    });
  });
});
