import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { fetchPack } from '../../../../src/application/primitives/fetch-pack.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { hexToBytes } from '../../../../src/domain/objects/encoding.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import { encodePktStream } from '../../../../src/domain/protocol/pkt-line.js';
import { parsePackHeader } from '../../../../src/domain/storage/pack-entry.js';
import { lookupPackIndex, parsePackIndex } from '../../../../src/domain/storage/pack-index.js';
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from '../../../../src/ports/http-transport.js';
import { recordingProgress, withProgress } from '../commands/fixtures.js';
import { buildSyntheticPack, type EntrySpec } from './pack-fixture.js';

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

type MemCtx = ReturnType<typeof createMemoryContext>;

const withConfig = (ctx: MemCtx, patch: Partial<NonNullable<MemCtx['config']>>): MemCtx =>
  ({ ...ctx, config: { ...(ctx.config ?? {}), ...patch } }) as MemCtx;

const withMaxResponseBytes = (ctx: MemCtx, max: number): MemCtx =>
  withConfig(ctx, { maxResponseBytes: max });

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
          const sut = await fetchPack(ctx, transport, {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k', 'ofs-delta'],
            url: REMOTE_URL,
            progressOp: 'test:write-objects',
          });

          // Assert
          const expectedTrailerHex = await ctx.hash.hashHex(packBytes.subarray(0, -20));
          expect(sut.packSha).toBe(expectedTrailerHex);
          expect(sut.objectCount).toBe(1);
          expect(sut.packPath).toBe(
            `${ctx.layout.gitDir}/objects/pack/pack-${expectedTrailerHex}.pack`,
          );
          expect(sut.idxPath).toBe(
            `${ctx.layout.gitDir}/objects/pack/pack-${expectedTrailerHex}.idx`,
          );
          const writtenPack = await ctx.fs.read(sut.packPath);
          expect(writtenPack).toEqual(packBytes);
          const writtenIdx = await ctx.fs.read(sut.idxPath);
          const parsedIdx = parsePackIndex(writtenIdx);
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
          await fetchPack(ctx, transport, {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k', 'ofs-delta', 'filter'],
            url: REMOTE_URL,
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
          const sut = await fetchPack(ctx, transport, {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k', 'ofs-delta'],
            url: REMOTE_URL,
            progressOp: 'test:write-objects',
            promisor: true,
          });

          // Assert
          const promisorPath = `${ctx.layout.gitDir}/objects/pack/pack-${sut.packSha}.promisor`;
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
          const sut = await fetchPack(ctx, transport, {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k', 'ofs-delta'],
            url: REMOTE_URL,
            progressOp: 'test:write-objects',
          });

          // Assert
          const promisorPath = `${ctx.layout.gitDir}/objects/pack/pack-${sut.packSha}.promisor`;
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
          const sut = await fetchPack(ctx, transport, {
            wants: ['a'.repeat(40) as ObjectId],
            haves: [],
            capabilities: ['side-band-64k', 'ofs-delta'],
            url: REMOTE_URL,
            progressOp: 'test:write-objects',
            promisor: true,
          });

          // Assert
          expect(sut.packPath).toBe('');
          const packDir = await ctx.fs.readdir(`${ctx.layout.gitDir}/objects/pack`);
          expect(packDir.some((e) => e.name.endsWith('.promisor'))).toBe(false);
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
          const sut = await fetchPack(ctx, transport, {
            wants: [built.ids[0] as ObjectId],
            haves: [],
            capabilities: ['side-band-64k', 'ofs-delta'],
            url: REMOTE_URL,
            progressOp: 'test:write-objects',
          });

          // Assert
          expect(sut.objectCount).toBe(2);
          const idxBytes = await ctx.fs.read(sut.idxPath);
          const idx = parsePackIndex(idxBytes);
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
          const sut = await fetchPack(ctx, transport, {
            wants: [built.ids[0] as ObjectId],
            haves: [],
            capabilities: ['side-band-64k'],
            url: REMOTE_URL,
            progressOp: 'test:write-objects',
          });

          // Assert
          expect(sut.objectCount).toBe(2);
          const idx = parsePackIndex(await ctx.fs.read(sut.idxPath));
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
          const sut = await fetchPack(ctx, transport, {
            wants: [normal.ids[0] as ObjectId],
            haves: [],
            capabilities: ['side-band-64k'],
            url: REMOTE_URL,
            progressOp: 'test:write-objects',
          });

          // Assert
          expect(sut.objectCount).toBe(2);
          const idx = parsePackIndex(await ctx.fs.read(sut.idxPath));
          expect(lookupPackIndex(idx, normal.ids[0] as ObjectId)).toBeGreaterThanOrEqual(12);
          expect(lookupPackIndex(idx, normal.ids[1] as ObjectId)).toBeGreaterThanOrEqual(12);
        });
      });
    });

    describe('Given an OFS_DELTA pointing before the pack body', () => {
      describe('When fetchPack runs', () => {
        it('Then throws INVALID_PACK_HEADER referencing the offset', async () => {
          // Arrange — synthesize a pack with one entry whose OFS_DELTA distance is
          // larger than its own offset minus the 12-byte header. Real packs cannot
          // produce such an entry; we craft it directly to exercise the negative
          // base-offset guard inside tryResolveEntry. The entry header is hand-built:
          // type-byte sets OFS_DELTA(=6) with a 1-byte size of 0, the distance varint
          // encodes 100, then a 2-byte zlib stream for an empty target.
          const ctx = createMemoryContext();
          // Pack header (12 bytes) — version 2, 1 entry.
          const header = new Uint8Array(12);
          const dv = new DataView(header.buffer);
          dv.setUint32(0, 0x5041434b);
          dv.setUint32(4, 2);
          dv.setUint32(8, 1);
          // Entry header: type=6 (OFS_DELTA), size=0 → byte = (6 << 4) | 0 = 0x60.
          // Distance = 100, encoded as a single byte 0x64 (no continuation).
          const entryHeader = new Uint8Array([0x60, 0x64]);
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
            await fetchPack(ctx, transport, {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              url: REMOTE_URL,
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string; reason?: string };
          expect(data.code).toBe('INVALID_PACK_HEADER');
          expect(data.reason).toContain('OFS_DELTA');
          expect(data.reason).toContain('before pack body');
        });
      });
    });

    describe('Given a REF_DELTA whose base is not in the pack', () => {
      describe('When fetchPack runs', () => {
        it('Then throws unresolved REF_DELTA', async () => {
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
            await fetchPack(ctx, transport, {
              wants: [unknownBaseId as ObjectId],
              haves: [],
              capabilities: ['side-band-64k'],
              url: REMOTE_URL,
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string; reason?: string };
          expect(data.code).toBe('INVALID_PACK_HEADER');
          expect(data.reason).toContain('unresolved');
          expect(data.reason).toContain(unknownBaseId);
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
            await fetchPack(ctx, transport, {
              wants: [],
              haves: [],
              capabilities: [],
              url: REMOTE_URL,
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
            await fetchPack(ctx, transport, {
              wants: [blobId],
              haves: [],
              capabilities: ['side-band-64k'],
              url: REMOTE_URL,
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
          const sut = await fetchPack(ctx, transport, {
            wants: [dummyId],
            haves: [],
            capabilities: ['side-band-64k'],
            url: REMOTE_URL,
            progressOp: 'test:write-objects',
          });

          // Assert
          expect(sut.objectCount).toBe(0);
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
            await fetchPack(ctx, transport, {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              url: REMOTE_URL,
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
            await fetchPack(ctx, transport, {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              url: REMOTE_URL,
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
            await fetchPack(ctx, transport, {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              url: REMOTE_URL,
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
            await fetchPack(ctx, transport, {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              url: REMOTE_URL,
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
            await fetchPack(ctx, transport, {
              wants: [blobId],
              haves: [],
              capabilities: ['side-band-64k'],
              url: REMOTE_URL,
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
        it('Then writes a valid.pack +.idx', async () => {
          // Arrange — assemble a 12-byte header with objectCount=0 + 20-byte trailer.
          const ctx = createMemoryContext();
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
          const sut = await fetchPack(ctx, transport, {
            wants: [dummyId],
            haves: [],
            capabilities: ['side-band-64k'],
            url: REMOTE_URL,
            progressOp: 'test:write-objects',
          });

          // Assert
          expect(sut.objectCount).toBe(0);
          const idx = parsePackIndex(await ctx.fs.read(sut.idxPath));
          expect(idx.objectCount).toBe(0);
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
          const sut = await fetchPack(tightCtx, transport, {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            url: REMOTE_URL,
            progressOp: 'test:write-objects',
          });

          // Assert
          expect(sut.objectCount).toBe(1);
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
          const sut = await fetchPack(exactCtx, transport, {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            url: REMOTE_URL,
            progressOp: 'test:write-objects',
          });

          // Assert
          expect(sut.objectCount).toBe(1);
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
            await fetchPack(overCtx, transport, {
              wants: [blobId],
              haves: [],
              capabilities: ['side-band-64k'],
              url: REMOTE_URL,
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
          const sut = await fetchPack(ctx, transport, {
            wants: [blobId],
            haves: [],
            capabilities: [], // no side-band advertised
            url: REMOTE_URL,
            progressOp: 'test:write-objects',
          });

          // Assert
          expect(sut.objectCount).toBe(1);
          const written = await ctx.fs.read(sut.packPath);
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
          await fetchPack(ctx, transport, {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            url: REMOTE_URL,
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

    describe('Given a non-200 server response', () => {
      describe('When fetchPack runs', () => {
        it('Then throws HTTP_ERROR with the status code', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const dummyId = (await computeBlobId(ctx, ENCODER.encode('boom\n'))) as ObjectId;
          const transport: HttpTransport = {
            request: async (): Promise<HttpResponse> => ({
              statusCode: 503,
              headers: {},
              body: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.close();
                },
              }),
            }),
          };

          // Act
          let caught: unknown;
          try {
            await fetchPack(ctx, transport, {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              url: REMOTE_URL,
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as {
            code: string;
            statusCode?: number;
            reason?: string;
          };
          expect(data.code).toBe('HTTP_ERROR');
          expect(data.statusCode).toBe(503);
          expect(data.reason).toContain('503');
        });
      });
    });

    describe('Given a ctx.signal', () => {
      describe('When fetchPack runs', () => {
        it('Then the signal is forwarded on the HttpRequest', async () => {
          // Arrange
          const controller = new AbortController();
          const baseCtx = createMemoryContext();
          const ctx = { ...baseCtx, signal: controller.signal };
          const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'signal\n');
          const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const { transport, requests } = captureRequests(body);

          // Act
          await fetchPack(ctx, transport, {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            url: REMOTE_URL,
            progressOp: 'test:write-objects',
          });

          // Assert — signal flows through to req.signal exactly.
          expect(requests[0]?.signal).toBe(controller.signal);
        });
      });
    });

    describe('Given a base URL with a fragment', () => {
      describe('When fetchPack runs', () => {
        it('Then throws INVALID_BASE_URL', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const dummyId = (await computeBlobId(ctx, ENCODER.encode('frag\n'))) as ObjectId;
          const { transport } = captureRequests(new Uint8Array(0));

          // Act
          let caught: unknown;
          try {
            await fetchPack(ctx, transport, {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              url: `${REMOTE_URL}#frag`,
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string; reason?: string };
          expect(data.code).toBe('INVALID_BASE_URL');
          expect(data.reason).toContain('fragment');
        });
      });
    });

    describe('Given a malformed URL', () => {
      describe('When fetchPack runs', () => {
        it('Then throws INVALID_BASE_URL', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const dummyId = (await computeBlobId(ctx, ENCODER.encode('bad\n'))) as ObjectId;
          const { transport } = captureRequests(new Uint8Array(0));

          // Act
          let caught: unknown;
          try {
            await fetchPack(ctx, transport, {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              url: 'not a url',
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          const data = (caught as TsgitError).data as { code: string; reason?: string };
          expect(data.code).toBe('INVALID_BASE_URL');
          expect(data.reason).toContain('invalid URL');
        });
      });
    });

    describe('Given a ctx with no signal', () => {
      describe('When fetchPack runs', () => {
        it('Then the request object omits the signal key entirely', async () => {
          // Arrange
          const ctx = createMemoryContext();
          // ctx.signal is undefined by default in createMemoryContext.
          const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'no signal\n');
          const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const { transport, requests } = captureRequests(body);

          // Act
          await fetchPack(ctx, transport, {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            url: REMOTE_URL,
            progressOp: 'test:write-objects',
          });

          // Assert — the spread guard `ctx.signal !== undefined` must omit the
          // signal key entirely when ctx has no signal. `'signal' in req` returning
          // false pins the guard; flipping it to always-true would spread
          // `{ signal: undefined }`, making `'signal' in req` true.
          expect(requests[0] && 'signal' in requests[0]).toBe(false);
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
          const sut = await fetchPack(ctx, transport, {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            url: REMOTE_URL,
            progressOp: 'test:write-objects',
          });

          // Assert — verifies the post-drain concat (off +=...) is correct.
          const written = await ctx.fs.read(sut.packPath);
          expect(written).toEqual(packBytes);
          expect(sut.objectCount).toBe(1);
        });
      });
    });

    describe('Given a base URL with a trailing slash', () => {
      describe('When fetchPack runs', () => {
        it('Then the POST URL is normalized (no doubled slash)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const { packBytes, blobId } = await buildSingleBlobPack(ctx, 'trailing slash\n');
          const body = buildUploadPackResponseBody({ packBytes, sideBand: true });
          const { transport, requests } = captureRequests(body);

          // Act
          await fetchPack(ctx, transport, {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            url: `${REMOTE_URL}/`,
            progressOp: 'test:write-objects',
          });

          // Assert
          expect(requests[0]?.url).toBe(UPLOAD_PACK_URL);
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
          const sut = await fetchPack(ctx, transport, {
            wants: [built.ids[0] as ObjectId],
            haves: [],
            capabilities: ['side-band-64k'],
            url: REMOTE_URL,
            progressOp: 'test:write-objects',
          });

          // Assert
          const idx = parsePackIndex(await ctx.fs.read(sut.idxPath));
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
            await fetchPack(ctx, transport, {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              url: REMOTE_URL,
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
            await fetchPack(ctx, transport, {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              url: REMOTE_URL,
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
            await fetchPack(ctx, transport, {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              url: REMOTE_URL,
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
            await fetchPack(ctx, transport, {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              url: REMOTE_URL,
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
        it('Then throws "unresolved entry at offset"', async () => {
          // Arrange — a single OFS_DELTA at offset 12 with a distance-0 varint.
          // `tryResolveEntry` computes `baseOffset = 12 - 0 = 12`, which is NOT
          // `< PACK_HEADER_BYTES`, so the negative-offset guard does not fire;
          // `byOffset.get(12)` is never populated (the delta cannot resolve
          // itself), so the entry stays unresolved. `firstUnresolvedError` then
          // falls through `refDeltaBaseId` (OFS_DELTA → undefined) to the final
          // `unresolved entry at offset ${first.offset}` arm — pinning that
          // template literal against the empty-string mutant.
          const ctx = createMemoryContext();
          // Pack header (12 bytes) — magic 'PACK', version 2, 1 entry.
          const header = new Uint8Array(12);
          const hdv = new DataView(header.buffer);
          hdv.setUint32(0, 0x5041434b);
          hdv.setUint32(4, 2);
          hdv.setUint32(8, 1);
          // Entry header: type=6 (OFS_DELTA), size=0 → byte (6 << 4) | 0 = 0x60.
          // Distance = 0, encoded as a single 0x00 byte (no continuation).
          const entryHeader = new Uint8Array([0x60, 0x00]);
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
            await fetchPack(ctx, transport, {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              url: REMOTE_URL,
              progressOp: 'test:write-objects',
            });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as { code: string; reason?: string };
          expect(data.code).toBe('INVALID_PACK_HEADER');
          expect(data.reason).toContain('unresolved entry at offset');
          // The offset 12 must appear — proves the template literal interpolates
          // `first.offset` and is not the empty string.
          expect(data.reason).toContain('12');
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
          const sut = await fetchPack(ctx, transport, {
            wants: [dummyId],
            haves: [],
            capabilities: ['side-band-64k'],
            url: REMOTE_URL,
            progressOp: 'test:write-objects',
          });

          // Assert — synthetic empty result.
          expect(sut.objectCount).toBe(0);
          expect(sut.packSha).toBe('');
          expect(sut.packPath).toBe('');
          expect(sut.idxPath).toBe('');
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
          await fetchPack(ctx, transport, {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            url: REMOTE_URL,
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
            await fetchPack(ctx, transport, {
              wants: [blobId],
              haves: [],
              capabilities: ['side-band-64k'],
              url: REMOTE_URL,
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
          await fetchPack(ctx, transport, {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            url: REMOTE_URL,
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
          const sut = await fetchPack(ctx, transport, {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            url: REMOTE_URL,
            progressOp: 'test:write-objects',
          });

          // Assert
          expect(sut.shallow).toEqual([]);
          expect(sut.unshallow).toEqual([]);
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
          const sut = await fetchPack(ctx, transport, {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            url: REMOTE_URL,
            progressOp: 'test:write-objects',
            depth: 1,
          });

          // Assert — `deepen 1\n` in the request body.
          expect(sut.shallow).toEqual([shallowOid]);
          expect(sut.unshallow).toEqual([]);
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
          const sut = await fetchPack(ctx, transport, {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            url: REMOTE_URL,
            progressOp: 'test:write-objects',
            depth: 1,
          });

          // Assert
          expect(sut.shallow).toEqual([]);
          expect(sut.unshallow).toEqual([]);
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
            await fetchPack(ctx, transport, {
              wants: [dummyId],
              haves: [],
              capabilities: ['side-band-64k'],
              url: REMOTE_URL,
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
          const sut = await fetchPack(ctx, transport, {
            wants: [blobId],
            haves: [],
            capabilities: ['side-band-64k'],
            url: REMOTE_URL,
            progressOp: 'test:write-objects',
            depth: 3,
          });

          // Assert
          expect(sut.shallow).toEqual([shallowOid]);
          expect(sut.unshallow).toEqual([unshallowOid]);
        });
      });
    });
  });
});
