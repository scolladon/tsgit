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
