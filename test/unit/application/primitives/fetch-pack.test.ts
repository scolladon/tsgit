import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { fetchPack } from '../../../../src/application/primitives/fetch-pack.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import { encodePktStream } from '../../../../src/domain/protocol/pkt-line.js';
import { parsePackHeader } from '../../../../src/domain/storage/pack-entry.js';
import { lookupPackIndex, parsePackIndex } from '../../../../src/domain/storage/pack-index.js';
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from '../../../../src/ports/http-transport.js';
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
    it('Given a single-blob side-band-1 pack, When fetchPack runs, Then writes pack-<sha>.pack and .idx', async () => {
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
      expect(sut.idxPath).toBe(`${ctx.layout.gitDir}/objects/pack/pack-${expectedTrailerHex}.idx`);
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

  describe('delta resolution', () => {
    it('Given a base + OFS_DELTA pack, When fetchPack runs, Then both ids appear in the .idx', async () => {
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

    it('Given a base + REF_DELTA pack (base first), When fetchPack runs, Then resolves the delta in first pass', async () => {
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

    it('Given a REF_DELTA before its base (out-of-order), When fetchPack runs, Then resolves via the deferred pass', async () => {
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

    it('Given a REF_DELTA whose base is not in the pack, When fetchPack runs, Then throws unresolved REF_DELTA', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const baseContent = ENCODER.encode('orphan base\n');
      const targetContent = ENCODER.encode('orphan target\n');
      const unknownBaseId = await computeBlobId(ctx, ENCODER.encode('not in pack\n'));
      // The pack contains only the REF_DELTA — no base. uncompressed base content
      // is only used by the fixture's delta-encoder to declare sourceLength.
      const built = await buildSyntheticPack(ctx, [
        { kind: 'ref-delta', baseId: unknownBaseId, baseUncompressed: baseContent, targetContent },
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

  describe('failure modes', () => {
    it('Given no wants, When fetchPack runs, Then throws EMPTY_WANTS', async () => {
      // Arrange
      const ctx = createMemoryContext();
      const { transport } = captureRequests(new Uint8Array(0));

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
    });
  });
});
