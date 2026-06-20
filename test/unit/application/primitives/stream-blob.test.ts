import { describe, expect, it } from 'vitest';
import { readBlob } from '../../../../src/application/primitives/read-blob.js';
import { streamBlob } from '../../../../src/application/primitives/stream-blob.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { Blob, Commit, ObjectId } from '../../../../src/domain/objects/index.js';
import { computeLooseObjectPath } from '../../../../src/domain/storage/loose-path.js';
import { buildSeededContext, instrumentedContext } from './fixtures.js';

const ZERO_ID = '0'.repeat(40) as ObjectId;

const ENC = new TextEncoder();

async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of it) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function collectChunks(it: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of it) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('streamBlob', () => {
  describe('Given a loose blob, When streamBlob is drained', () => {
    it('Then concatenated bytes are byte-equal to readBlob content', async () => {
      // Arrange
      const blob: Blob = {
        type: 'blob',
        content: ENC.encode('hello streaming world'),
        id: '' as ObjectId,
      };
      const ctx = await buildSeededContext({ objects: [blob] });
      const id = await writeObject(ctx, blob);

      // Act
      const sut = await streamBlob(ctx, id);
      const result = await collect(sut);

      // Assert
      const oracle = await readBlob(ctx, id);
      expect(result).toEqual(oracle.content);
    });
  });

  describe('Given an empty (zero-content) loose blob, When drained', () => {
    it('Then yields zero content bytes and completes without error', async () => {
      // Arrange
      const blob: Blob = {
        type: 'blob',
        content: new Uint8Array(0),
        id: '' as ObjectId,
      };
      const ctx = await buildSeededContext({ objects: [blob] });
      const id = await writeObject(ctx, blob);

      // Act
      const sut = await streamBlob(ctx, id);
      const result = await collect(sut);

      // Assert
      expect(result).toEqual(new Uint8Array(0));
    });
  });

  describe('Given a loose blob whose content is exactly one inflate chunk, When drained', () => {
    it('Then yields bytes byte-equal to readBlob content', async () => {
      // Arrange
      const content = ENC.encode('single chunk content that fits in one inflate output');
      const blob: Blob = { type: 'blob', content, id: '' as ObjectId };
      const ctx = await buildSeededContext({ objects: [blob] });
      const id = await writeObject(ctx, blob);

      // Act
      const sut = await streamBlob(ctx, id);
      const result = await collect(sut);

      // Assert
      const oracle = await readBlob(ctx, id);
      expect(result).toEqual(oracle.content);
    });
  });

  describe('Given a large loose blob (multi-chunk inflate), When drained', () => {
    it('Then yields bytes byte-equal to readBlob content', async () => {
      // Arrange
      const large = new Uint8Array(200 * 1024);
      for (let i = 0; i < large.length; i += 1) {
        large[i] = i % 251;
      }
      const blob: Blob = { type: 'blob', content: large, id: '' as ObjectId };
      const ctx = await buildSeededContext({ objects: [blob] });
      const id = await writeObject(ctx, blob);

      // Act
      const sut = await streamBlob(ctx, id);
      const result = await collect(sut);

      // Assert
      const oracle = await readBlob(ctx, id);
      expect(result).toEqual(oracle.content);
    });
  });

  describe('Given a large loose blob (~200 KB), When drained chunk-by-chunk', () => {
    it('Then yields more than one chunk (genuine streaming, not a single buffered yield)', async () => {
      // Arrange
      const large = new Uint8Array(200 * 1024);
      for (let i = 0; i < large.length; i += 1) {
        large[i] = i % 251;
      }
      const blob: Blob = { type: 'blob', content: large, id: '' as ObjectId };
      const ctx = await buildSeededContext({ objects: [blob] });
      const id = await writeObject(ctx, blob);

      // Act
      const sut = await streamBlob(ctx, id);
      const result = await collectChunks(sut);

      // Assert — a buffered implementation yields exactly one chunk; streaming yields many
      expect(result.length).toBeGreaterThan(1);
    });
  });

  describe('Given a loose non-blob object id (a commit), When streamBlob is called', () => {
    it('Then throws unexpectedObjectType with correct data', async () => {
      // Arrange
      const identity = {
        name: 'A',
        email: 'a@a.com',
        timestamp: 1,
        timezoneOffset: '+0000' as const,
      };
      const commit: Commit = {
        type: 'commit',
        id: '' as ObjectId,
        data: {
          tree: ZERO_ID,
          parents: [],
          author: identity,
          committer: identity,
          message: 'msg',
          extraHeaders: [],
        },
      };
      const ctx = await buildSeededContext({ objects: [commit] });
      const id = await writeObject(ctx, commit);

      // Act / Assert
      try {
        const sut = await streamBlob(ctx, id);
        await collect(sut);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(TsgitError);
        const data = (error as TsgitError).data;
        expect(data.code).toBe('UNEXPECTED_OBJECT_TYPE');
        if (data.code === 'UNEXPECTED_OBJECT_TYPE') {
          expect(data.expected).toBe('blob');
          expect(data.actual).toBe('commit');
          expect(data.id).toBe(id);
        }
      }
    });
  });

  describe('Given a loose blob with default options, When drained', () => {
    it('Then no objectHashMismatch is thrown (verification passes on a good blob)', async () => {
      // Arrange
      const blob: Blob = {
        type: 'blob',
        content: ENC.encode('good content'),
        id: '' as ObjectId,
      };
      const ctx = await buildSeededContext({ objects: [blob] });
      const id = await writeObject(ctx, blob);

      // Act / Assert — should not throw
      const sut = await streamBlob(ctx, id);
      await expect(collect(sut)).resolves.toBeDefined();
    });
  });

  describe('Given a corrupted loose blob, When drained to completion', () => {
    it('Then throws objectHashMismatch with correct data', async () => {
      // Arrange
      const blob: Blob = {
        type: 'blob',
        content: ENC.encode('original content'),
        id: '' as ObjectId,
      };
      const ctx = await buildSeededContext({ objects: [blob] });
      const id = await writeObject(ctx, blob);

      // Corrupt: write a different blob under the same id path
      const corruptBlob: Blob = {
        type: 'blob',
        content: ENC.encode('CORRUPTED content'),
        id: '' as ObjectId,
      };
      const corruptBytes = new TextEncoder().encode(
        `blob ${corruptBlob.content.length}\0${new TextDecoder().decode(corruptBlob.content)}`,
      );
      const compressed = await ctx.compressor.deflate(corruptBytes);
      const loosePath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`;
      await ctx.fs.write(loosePath, compressed);

      // Act / Assert
      try {
        const sut = await streamBlob(ctx, id);
        await collect(sut);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(TsgitError);
        const data = (error as TsgitError).data;
        expect(data.code).toBe('OBJECT_HASH_MISMATCH');
        if (data.code === 'OBJECT_HASH_MISMATCH') {
          expect(data.expected).toBe(id);
          expect(data.actual).toBeDefined();
          expect(data.actual).not.toBe(id);
        }
      }
    });
  });

  describe('Given a corrupted loose blob with verifyHash false, When drained', () => {
    it('Then no objectHashMismatch is thrown (opt-out)', async () => {
      // Arrange
      const blob: Blob = {
        type: 'blob',
        content: ENC.encode('original'),
        id: '' as ObjectId,
      };
      const ctx = await buildSeededContext({ objects: [blob] });
      const id = await writeObject(ctx, blob);

      const corruptBytes = new TextEncoder().encode('blob 7\0CORRUPT');
      const compressed = await ctx.compressor.deflate(corruptBytes);
      const loosePath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`;
      await ctx.fs.write(loosePath, compressed);

      // Act / Assert — should not throw with verifyHash: false
      const sut = await streamBlob(ctx, id, { verifyHash: false });
      await expect(collect(sut)).resolves.toBeDefined();
    });
  });

  describe('Given a ctx.signal aborted before streaming, When streamBlob is drained', () => {
    it('Then throws operationAborted', async () => {
      // Arrange
      const blob: Blob = {
        type: 'blob',
        content: ENC.encode('content'),
        id: '' as ObjectId,
      };
      const controller = new AbortController();
      const ctx = await buildSeededContext({ signal: controller.signal, objects: [blob] });
      const id = await writeObject(ctx, blob);
      controller.abort();

      // Act / Assert
      try {
        const sut = await streamBlob(ctx, id);
        await collect(sut);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(TsgitError);
        const data = (error as TsgitError).data;
        expect(data.code).toBe('OPERATION_ABORTED');
      }
    });
  });

  describe('Given a loose blob, When the BlobStream.materialised is read', () => {
    it('Then it is false (genuinely streamed)', async () => {
      // Arrange
      const blob: Blob = {
        type: 'blob',
        content: ENC.encode('materialised flag test'),
        id: '' as ObjectId,
      };
      const ctx = await buildSeededContext({ objects: [blob] });
      const id = await writeObject(ctx, blob);

      // Act
      const sut = await streamBlob(ctx, id);

      // Assert
      expect(sut.materialised).toBe(false);
    });
  });

  describe('Given a loose blob, When drained', () => {
    it('Then read was called (not readSlice) — pins the loose route', async () => {
      // Arrange
      const blob: Blob = {
        type: 'blob',
        content: ENC.encode('route pin test'),
        id: '' as ObjectId,
      };
      const baseCtx = await buildSeededContext({ objects: [blob] });
      const id = await writeObject(baseCtx, blob);

      const { ctx, calls } = instrumentedContext(baseCtx);

      // Act
      const sut = await streamBlob(ctx, id);
      await collect(sut);

      // Assert
      const log = calls();
      expect(log.some((e) => e.method === 'read')).toBe(true);
      expect(log.some((e) => e.method === 'readSlice')).toBe(false);
    });
  });
});
