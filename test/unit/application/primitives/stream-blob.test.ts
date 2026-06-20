import { describe, expect, it, vi } from 'vitest';
import { readBlob } from '../../../../src/application/primitives/read-blob.js';
import { streamBlob } from '../../../../src/application/primitives/stream-blob.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { Blob, Commit, ObjectId } from '../../../../src/domain/objects/index.js';
import { computeLooseObjectPath } from '../../../../src/domain/storage/loose-path.js';
import { buildSeededContext, instrumentedContext } from './fixtures.js';
import { buildSyntheticPack, writeSyntheticPack } from './pack-fixture.js';

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

  describe('Given a packed base (non-delta) blob, When streamBlob is drained', () => {
    it('Then concatenated bytes are byte-equal to readBlob content and materialised is false', async () => {
      // Arrange
      const content = ENC.encode('packed base blob content for streaming test');
      const ctx = await buildSeededContext();
      const ids = await writeSyntheticPack(ctx, 'base-test', [
        { kind: 'base', type: 'blob', content },
      ]);
      const id = ids[0] as ObjectId;

      // Act
      const sut = await streamBlob(ctx, id);
      const result = await collect(sut);

      // Assert
      const oracle = await readBlob(ctx, id);
      expect(result).toEqual(oracle.content);
      expect(sut.materialised).toBe(false);
    });
  });

  describe('Given a packed base blob, When drained', () => {
    it('Then readSlice was called and no loose-object read was called — pins the packed route', async () => {
      // Arrange
      const content = ENC.encode('packed route pin test');
      const baseCtx = await buildSeededContext();
      const ids = await writeSyntheticPack(baseCtx, 'route-pin', [
        { kind: 'base', type: 'blob', content },
      ]);
      const id = ids[0] as ObjectId;
      const { ctx, calls } = instrumentedContext(baseCtx);

      // Act
      const sut = await streamBlob(ctx, id);
      await collect(sut);

      // Assert
      const log = calls();
      // Packed base path must call readSlice (not whole-file read of the loose object)
      expect(log.some((e) => e.method === 'readSlice')).toBe(true);
      // The loose path would call read on the loose object path (under /objects/XX/...)
      // Pack registry reads .idx files (under /objects/pack/) — those reads are expected.
      // The distinguishing check: no loose object path should be read (two-char dir prefix pattern).
      const looseObjectReadPattern = /\/objects\/[0-9a-f]{2}\//;
      expect(
        log.filter((e) => e.method === 'read').every((e) => !looseObjectReadPattern.test(e.path)),
      ).toBe(true);
    });
  });

  describe('Given a deltified packed blob, When streamBlob is drained', () => {
    it('Then concatenated bytes are byte-equal to readBlob content and materialised is true', async () => {
      // Arrange
      const baseContent = ENC.encode('base content for delta chain');
      const targetContent = ENC.encode('delta target content — different from base');
      const ctx = await buildSeededContext();
      const ids = await writeSyntheticPack(ctx, 'delta-test', [
        { kind: 'base', type: 'blob', content: baseContent },
        { kind: 'ofs-delta', baseIndex: 0, targetContent },
      ]);
      const id = ids[1] as ObjectId;

      // Act
      const sut = await streamBlob(ctx, id);
      const result = await collect(sut);

      // Assert
      const oracle = await readBlob(ctx, id);
      expect(result).toEqual(oracle.content);
      expect(sut.materialised).toBe(true);
    });
  });

  describe('Given a packed non-blob (tree) id, When streamBlob is drained', () => {
    it('Then throws unexpectedObjectType with correct data', async () => {
      // Arrange
      const content = ENC.encode('tree-like content');
      const ctx = await buildSeededContext();
      const ids = await writeSyntheticPack(ctx, 'non-blob-test', [
        { kind: 'base', type: 'tree', content },
      ]);
      const id = ids[0] as ObjectId;

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
          expect(data.actual).toBe('tree');
          expect(data.id).toBe(id);
        }
      }
    });
  });

  describe('Given an id present in neither loose nor pack, When streamBlob is called', () => {
    it('Then throws objectNotFound with correct data', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = 'f'.repeat(40) as ObjectId;

      // Act / Assert
      try {
        await streamBlob(ctx, id);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(TsgitError);
        const data = (error as TsgitError).data;
        expect(data.code).toBe('OBJECT_NOT_FOUND');
        if (data.code === 'OBJECT_NOT_FOUND') {
          expect(data.id).toBe(id);
        }
      }
    });
  });

  describe('Given a large (~200 KB) packed base blob, When drained chunk-by-chunk', () => {
    it('Then yields more than one chunk (genuine streaming, not a single buffered yield)', async () => {
      // Arrange
      const large = new Uint8Array(200 * 1024);
      for (let i = 0; i < large.length; i += 1) {
        large[i] = i % 251;
      }
      const ctx = await buildSeededContext();
      const ids = await writeSyntheticPack(ctx, 'large-base', [
        { kind: 'base', type: 'blob', content: large },
      ]);
      const id = ids[0] as ObjectId;

      // Act
      const sut = await streamBlob(ctx, id);
      const chunks = await collectChunks(sut);

      // Assert — a buffered implementation yields exactly one chunk; streaming yields many
      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  // Finding 1: corrupted PACK (not loose) — the packed route runs exclusively
  // because no loose object for this id exists. The index maps the real id to
  // an offset whose compressed payload inflates to different bytes, so the
  // incremental hash built by yieldAndVerifyPackedBaseChunks never matches.
  describe('Given a genuinely-packed blob whose pack payload inflates to different content, When drained to completion', () => {
    it('Then throws objectHashMismatch via yieldAndVerifyPackedBaseChunks (readSlice called, loose path skipped)', async () => {
      // Arrange
      // Build two separate packs in the same ctx so we share fs / hash service.
      // Pack A: "correct" content — its id goes into the idx.
      // Pack B: "corrupt" content — its pack bytes replace the .pack file.
      // Result: idx maps id-A to offset 12, but the .pack stores B's payload.
      const ctxBase = await buildSeededContext();
      const contentA = ENC.encode('correct blob content for pack corruption test');
      const contentB = ENC.encode('DIFFERENT blob content that hashes to a different id');

      const packA = await buildSyntheticPack(ctxBase, [
        { kind: 'base', type: 'blob', content: contentA },
      ]);
      const packB = await buildSyntheticPack(ctxBase, [
        { kind: 'base', type: 'blob', content: contentB },
      ]);

      // Write B's .pack bytes (valid zlib at offset 12, but wrong content)
      // but A's .idx (which registers id-A at offset 12).
      // No loose object for id-A → loose branch returns undefined → packed branch runs.
      const packBase = `${ctxBase.layout.gitDir}/objects/pack/pack-corrupt-genuine`;
      await ctxBase.fs.write(`${packBase}.pack`, packB.packBytes);
      await ctxBase.fs.write(`${packBase}.idx`, packA.idxBytes);

      const id = packA.ids[0] as ObjectId;

      // Confirm no loose object shadows this id (it never existed in ctxBase as loose)
      const loosePath = `${ctxBase.layout.gitDir}/objects/${computeLooseObjectPath(id)}`;
      expect(await ctxBase.fs.exists(loosePath)).toBe(false);

      // Spy routing: readSlice IS called (packed path), loose read IS NOT.
      const { ctx, calls } = instrumentedContext(ctxBase);

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

      // Pin routing: packed path was taken, not the loose path.
      const log = calls();
      expect(log.some((e) => e.method === 'readSlice')).toBe(true);
      const looseObjectReadPattern = /\/objects\/[0-9a-f]{2}\//;
      expect(
        log.filter((e) => e.method === 'read').every((e) => !looseObjectReadPattern.test(e.path)),
      ).toBe(true);
    });
  });

  describe('Given a genuinely-packed blob whose pack payload is corrupt, When drained with verifyHash false', () => {
    it('Then no objectHashMismatch is thrown (opt-out) and yields the wrong bytes without error', async () => {
      // Arrange — same cross-pack trick: idx from A, .pack from B, no loose shadow.
      const ctxBase = await buildSeededContext();
      const contentA = ENC.encode('original content for no-verify test');
      const contentB = ENC.encode('CORRUPT content for no-verify test');

      const packA = await buildSyntheticPack(ctxBase, [
        { kind: 'base', type: 'blob', content: contentA },
      ]);
      const packB = await buildSyntheticPack(ctxBase, [
        { kind: 'base', type: 'blob', content: contentB },
      ]);

      const packBase = `${ctxBase.layout.gitDir}/objects/pack/pack-corrupt-no-verify`;
      await ctxBase.fs.write(`${packBase}.pack`, packB.packBytes);
      await ctxBase.fs.write(`${packBase}.idx`, packA.idxBytes);

      const id = packA.ids[0] as ObjectId;

      // Act / Assert — should not throw with verifyHash: false
      const sut = await streamBlob(ctxBase, id, { verifyHash: false });
      const result = await collect(sut);
      // The wrong (B) bytes are yielded without error
      expect(result).toEqual(contentB);
    });
  });

  // Finding 2: header-strip across a chunk boundary
  // stripHeader accumulates inflate chunks until the NUL byte is found.
  // A real DecompressionStream always emits the tiny header in the first chunk,
  // so this path is only exercised by driving a re-chunking inflate that
  // emits 1–3 bytes per chunk, forcing the NUL to land in chunk ≥2.
  //
  // Implementation: override createInflateStream to return a TransformStream
  // that collects all compressed input, inflates it via the real inflate(), then
  // emits the inflated bytes 2 bytes at a time. This avoids complex stream
  // chaining while deterministically driving the multi-chunk stripHeader loop.
  function makeRechunkingInflateStream(
    realInflate: (data: Uint8Array) => Promise<Uint8Array>,
    chunkSize: number,
  ): TransformStream<Uint8Array, Uint8Array> {
    const inputChunks: Uint8Array[] = [];
    return new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk) {
        inputChunks.push(chunk);
      },
      async flush(controller) {
        const totalLen = inputChunks.reduce((n, c) => n + c.length, 0);
        const allInput = new Uint8Array(totalLen);
        let pos = 0;
        for (const c of inputChunks) {
          allInput.set(c, pos);
          pos += c.length;
        }
        const inflated = await realInflate(allInput);
        let offset = 0;
        while (offset < inflated.length) {
          controller.enqueue(inflated.subarray(offset, offset + chunkSize));
          offset += chunkSize;
        }
      },
    });
  }

  describe('Given a loose blob and a re-chunking inflate (2 bytes/chunk), When drained', () => {
    it('Then concatenated bytes equal readBlob content and no header bytes leak into content', async () => {
      // Arrange
      const content = ENC.encode('content for cross-chunk header strip test');
      const blob: Blob = { type: 'blob', content, id: '' as ObjectId };
      const baseCtx = await buildSeededContext({ objects: [blob] });
      const id = await writeObject(baseCtx, blob);

      // Override createInflateStream to emit 2-byte chunks, forcing the NUL
      // byte of "blob <size>\0" to land in chunk ≥2 (header is >2 bytes).
      const realCompressor = baseCtx.compressor;
      let createInflateStreamCalled = false;
      const ctx = {
        ...baseCtx,
        compressor: {
          ...realCompressor,
          createInflateStream: (): TransformStream<Uint8Array, Uint8Array> => {
            createInflateStreamCalled = true;
            return makeRechunkingInflateStream(realCompressor.inflate, 2);
          },
        },
      };

      // Act
      const sut = await streamBlob(ctx as typeof baseCtx, id);
      const result = await collect(sut);

      // Assert
      const oracle = await readBlob(baseCtx, id);
      expect(result).toEqual(oracle.content);
      // Header bytes must not bleed into the yielded content
      const firstFive = result.subarray(0, 5);
      expect(new TextDecoder().decode(firstFive)).not.toBe('blob ');
      expect(createInflateStreamCalled).toBe(true);
    });
  });

  describe('Given an empty loose blob and a re-chunking inflate (2 bytes/chunk), When drained', () => {
    it('Then yields zero content bytes without error (header-only stream via multi-chunk stripHeader path)', async () => {
      // Arrange — "blob 0\0" is 7 bytes; 2-byte chunks guarantee the NUL lands in chunk 4
      const blob: Blob = { type: 'blob', content: new Uint8Array(0), id: '' as ObjectId };
      const baseCtx = await buildSeededContext({ objects: [blob] });
      const id = await writeObject(baseCtx, blob);

      const realCompressor = baseCtx.compressor;
      let createInflateStreamCalled = false;
      const ctx = {
        ...baseCtx,
        compressor: {
          ...realCompressor,
          createInflateStream: (): TransformStream<Uint8Array, Uint8Array> => {
            createInflateStreamCalled = true;
            return makeRechunkingInflateStream(realCompressor.inflate, 2);
          },
        },
      };

      // Act
      const sut = await streamBlob(ctx as typeof baseCtx, id);
      const result = await collect(sut);

      // Assert
      expect(result).toEqual(new Uint8Array(0));
      expect(createInflateStreamCalled).toBe(true);
    });
  });

  // Finding 3: between-chunks abort is untested — two isolated tests so each
  // between-chunks guard (loose path in yieldAndVerifyChunks; packed-base path
  // in yieldAndVerifyPackedBaseChunks) must fail independently when deleted.

  describe('Given a large loose blob and an abort signal fired mid-drain, When the iterator is advanced after abort', () => {
    it('Then throws operationAborted on the next chunk (loose between-chunks guard)', async () => {
      // Arrange — large blob guarantees multiple inflate chunks
      const large = new Uint8Array(200 * 1024);
      for (let i = 0; i < large.length; i += 1) {
        large[i] = i % 251;
      }
      const blob: Blob = { type: 'blob', content: large, id: '' as ObjectId };
      const controller = new AbortController();
      const ctx = await buildSeededContext({ signal: controller.signal, objects: [blob] });
      const id = await writeObject(ctx, blob);

      // Act — drain one chunk, then abort, then advance to trigger the guard
      const sut = await streamBlob(ctx, id);
      const iter = sut[Symbol.asyncIterator]();

      // Consume the first chunk (the guard fires BEFORE yielding each subsequent chunk)
      const first = await iter.next();
      expect(first.done).toBe(false);

      // Abort between chunks
      controller.abort();

      // Assert — next advance must throw operationAborted
      try {
        await iter.next();
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(TsgitError);
        const data = (error as TsgitError).data;
        expect(data.code).toBe('OPERATION_ABORTED');
      }
    });
  });

  describe('Given a large packed-base blob and an abort signal fired mid-drain, When the iterator is advanced after abort', () => {
    it('Then throws operationAborted on the next chunk (packed-base between-chunks guard)', async () => {
      // Arrange — large blob guarantees multiple inflate chunks from the packed path
      const large = new Uint8Array(200 * 1024);
      for (let i = 0; i < large.length; i += 1) {
        large[i] = i % 251;
      }
      const controller = new AbortController();
      const baseCtx = await buildSeededContext();
      const ids = await writeSyntheticPack(baseCtx, 'abort-packed', [
        { kind: 'base', type: 'blob', content: large },
      ]);
      const id = ids[0] as ObjectId;

      // Attach the abort signal to the context after building the pack
      const ctx = { ...baseCtx, signal: controller.signal };

      // Act — drain one chunk, abort, then advance
      const sut = await streamBlob(ctx, id);
      const iter = sut[Symbol.asyncIterator]();

      const first = await iter.next();
      expect(first.done).toBe(false);

      controller.abort();

      // Assert
      try {
        await iter.next();
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(TsgitError);
        const data = (error as TsgitError).data;
        expect(data.code).toBe('OPERATION_ABORTED');
      }
    });
  });

  // LOW: spy that createInflateStream is invoked on loose and packed-base paths
  describe('Given a loose blob, When drained', () => {
    it('Then createInflateStream is invoked (pins the streaming inflate path, not whole-buffer inflate)', async () => {
      // Arrange
      const blob: Blob = {
        type: 'blob',
        content: ENC.encode('inflate-spy content'),
        id: '' as ObjectId,
      };
      const baseCtx = await buildSeededContext({ objects: [blob] });
      const id = await writeObject(baseCtx, blob);

      const spy = vi.spyOn(baseCtx.compressor, 'createInflateStream');

      // Act
      const sut = await streamBlob(baseCtx, id);
      await collect(sut);

      // Assert
      expect(spy).toHaveBeenCalledOnce();
      spy.mockRestore();
    });
  });

  describe('Given a packed-base blob, When drained', () => {
    it('Then createInflateStream is invoked (pins the streaming inflate path, not whole-buffer inflate)', async () => {
      // Arrange
      const content = ENC.encode('packed inflate-spy content');
      const baseCtx = await buildSeededContext();
      const ids = await writeSyntheticPack(baseCtx, 'inflate-spy-packed', [
        { kind: 'base', type: 'blob', content },
      ]);
      const id = ids[0] as ObjectId;

      const spy = vi.spyOn(baseCtx.compressor, 'createInflateStream');

      // Act
      const sut = await streamBlob(baseCtx, id);
      await collect(sut);

      // Assert
      expect(spy).toHaveBeenCalledOnce();
      spy.mockRestore();
    });
  });

  describe('Given a deltified blob, When resolvePackChain is called', () => {
    it('Then the delta route invokes resolvePackChain (not the direct inflate path)', async () => {
      // Arrange
      const baseContent = ENC.encode('base content for spy test');
      const targetContent = ENC.encode('target content for spy test — different');
      const ctx = await buildSeededContext();
      const ids = await writeSyntheticPack(ctx, 'spy-delta', [
        { kind: 'base', type: 'blob', content: baseContent },
        { kind: 'ofs-delta', baseIndex: 0, targetContent },
      ]);
      const id = ids[1] as ObjectId;

      // Spy on resolvePackChain via the object-resolver module
      const resolverModule = await import(
        '../../../../src/application/primitives/object-resolver.js'
      );
      const spy = vi.spyOn(resolverModule, 'resolvePackChain');

      // Act
      const sut = await streamBlob(ctx, id);
      await collect(sut);

      // Assert — resolvePackChain must have been called for the delta arm
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  // Group A — delta-path non-blob type check (streamFromBuffer line 139)
  describe('Given a deltified non-blob (tree) id, When streamBlob is drained', () => {
    it('Then throws unexpectedObjectType with correct data (kills streamFromBuffer type guard)', async () => {
      // Arrange — tree base entry + ofs-delta that reconstructs it; resolvedType is tree
      const treeContent = ENC.encode('fake tree content');
      const ctx = await buildSeededContext();
      const ids = await writeSyntheticPack(ctx, 'delta-non-blob', [
        { kind: 'base', type: 'tree', content: treeContent },
        { kind: 'ofs-delta', baseIndex: 0, targetContent: ENC.encode('delta tree content') },
      ]);
      const id = ids[1] as ObjectId;

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
          expect(data.actual).toBe('tree');
          expect(data.id).toBe(id);
        }
      }
    });
  });

  // Group A — empty deltified blob content check (streamFromBuffer line 148)
  describe('Given a deltified blob with empty content, When streamBlob is drained', () => {
    it('Then yields zero content chunks and materialised is true (kills >= 0 and true mutants)', async () => {
      // Arrange — base blob + ofs-delta that reconstructs to empty blob
      const baseContent = ENC.encode('base for empty delta');
      const ctx = await buildSeededContext();
      const ids = await writeSyntheticPack(ctx, 'delta-empty-blob', [
        { kind: 'base', type: 'blob', content: baseContent },
        { kind: 'ofs-delta', baseIndex: 0, targetContent: new Uint8Array(0) },
      ]);
      const id = ids[1] as ObjectId;

      // Act
      const sut = await streamBlob(ctx, id);
      const chunks = await collectChunks(sut);

      // Assert — empty blob yields no content chunks; materialised flag is true (delta path)
      expect(chunks.length).toBe(0);
      expect(sut.materialised).toBe(true);
    });
  });

  // Group B — degenerate inflate: zero chunks (yieldAndVerifyChunks line 208)
  describe('Given a loose blob whose inflate stream emits zero chunks, When streamBlob is drained', () => {
    it('Then throws invalidObjectHeader (corrupt/empty inflate output, not silent empty)', async () => {
      // Arrange — real loose object exists so looseCompressedBytes returns bytes;
      // override createInflateStream to return an immediately-closed stream.
      const blob: Blob = { type: 'blob', content: ENC.encode('content'), id: '' as ObjectId };
      const baseCtx = await buildSeededContext({ objects: [blob] });
      const id = await writeObject(baseCtx, blob);

      const ctx = {
        ...baseCtx,
        compressor: {
          ...baseCtx.compressor,
          createInflateStream: (): TransformStream<Uint8Array, Uint8Array> =>
            new TransformStream<Uint8Array, Uint8Array>({
              start(controller) {
                controller.terminate();
              },
            }),
        },
      };

      // Act / Assert
      try {
        const sut = await streamBlob(ctx as typeof baseCtx, id);
        await collect(sut);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(TsgitError);
        const data = (error as TsgitError).data;
        expect(data.code).toBe('INVALID_OBJECT_HEADER');
        if (data.code === 'INVALID_OBJECT_HEADER') {
          expect(data.reason).toContain(id);
        }
      }
    });
  });

  // Group B — degenerate inflate: NUL-less bytes exhausted (stripHeader line 187)
  describe('Given a loose blob whose inflate stream emits bytes with no NUL terminator, When streamBlob is drained', () => {
    it('Then throws invalidObjectHeader (no NUL in header, not silent empty)', async () => {
      // Arrange — real loose object exists; override inflate to emit bytes without NUL.
      const blob: Blob = { type: 'blob', content: ENC.encode('content'), id: '' as ObjectId };
      const baseCtx = await buildSeededContext({ objects: [blob] });
      const id = await writeObject(baseCtx, blob);

      const ctx = {
        ...baseCtx,
        compressor: {
          ...baseCtx.compressor,
          createInflateStream: (): TransformStream<Uint8Array, Uint8Array> =>
            new TransformStream<Uint8Array, Uint8Array>({
              start(controller) {
                // Emit bytes with no NUL (0x00) byte — stripHeader will exhaust the iterator
                controller.enqueue(new Uint8Array([0x62, 0x6c, 0x6f, 0x62, 0x20])); // "blob "
                controller.terminate();
              },
            }),
        },
      };

      // Act / Assert
      try {
        const sut = await streamBlob(ctx as typeof baseCtx, id);
        await collect(sut);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(TsgitError);
        const data = (error as TsgitError).data;
        expect(data.code).toBe('INVALID_OBJECT_HEADER');
        if (data.code === 'INVALID_OBJECT_HEADER') {
          expect(data.reason).toContain(id);
        }
      }
    });
  });

  // Group C — packTypeName COMMIT case (line 71 NoCoverage)
  describe('Given a packed non-blob (commit) id, When streamBlob is drained', () => {
    it('Then throws unexpectedObjectType with actual commit (kills COMMIT case NoCoverage)', async () => {
      // Arrange
      const content = ENC.encode('fake commit content');
      const ctx = await buildSeededContext();
      const ids = await writeSyntheticPack(ctx, 'non-blob-commit', [
        { kind: 'base', type: 'commit', content },
      ]);
      const id = ids[0] as ObjectId;

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

  // Group C — packTypeName TAG case (line 75 NoCoverage — BLOB removed)
  describe('Given a packed non-blob (tag) id, When streamBlob is drained', () => {
    it('Then throws unexpectedObjectType with actual tag (kills TAG case NoCoverage)', async () => {
      // Arrange
      const content = ENC.encode('fake tag content');
      const ctx = await buildSeededContext();
      const ids = await writeSyntheticPack(ctx, 'non-blob-tag', [
        { kind: 'base', type: 'tag', content },
      ]);
      const id = ids[0] as ObjectId;

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
          expect(data.actual).toBe('tag');
          expect(data.id).toBe(id);
        }
      }
    });
  });
});
