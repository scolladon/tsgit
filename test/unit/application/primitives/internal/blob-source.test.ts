import { describe, expect, it } from 'vitest';
import {
  MAX_BUFFERED_BLOB_BYTES,
  openBlobSource,
} from '../../../../../src/application/primitives/internal/blob-source.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import type { Blob, Commit, ObjectId } from '../../../../../src/domain/objects/index.js';
import { EMPTY_TREE_OID } from '../../../../../src/domain/objects/index.js';
import { computeLooseObjectPath } from '../../../../../src/domain/storage/loose-path.js';
import { buildSeededContext } from '../fixtures.js';
import { writeSyntheticPack } from '../pack-fixture.js';

const ZERO_ID = '0'.repeat(40) as ObjectId;
const ENC = new TextEncoder();

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) {
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

function looseFormatBytes(type: string, content: Uint8Array): Uint8Array {
  const header = ENC.encode(`${type} ${content.length}\0`);
  const out = new Uint8Array(header.length + content.length);
  out.set(header, 0);
  out.set(content, header.length);
  return out;
}

async function buildLooseCommit(): Promise<{
  ctx: Awaited<ReturnType<typeof buildSeededContext>>;
  id: ObjectId;
}> {
  const identity = { name: 'A', email: 'a@a.com', timestamp: 1, timezoneOffset: '+0000' as const };
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
  return { ctx, id };
}

async function looseCompressedLength(
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  id: ObjectId,
): Promise<number> {
  const loosePath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`;
  return (await ctx.fs.read(loosePath)).length;
}

describe('openBlobSource', () => {
  describe('Given a delta-cache entry for an id absent from loose and pack storage', () => {
    describe('When openBlobSource is called with the gate open (maxBufferedBytes > 0)', () => {
      it('Then resolves from the cache as a bytes source', async () => {
        // Arrange
        const content = ENC.encode('cached blob content');
        const full = looseFormatBytes('blob', content);
        const ctx = await buildSeededContext();
        const id = (await ctx.hash.hashHex(full)) as ObjectId;
        ctx.deltaCache.set(id, full, full.length);

        // Act
        const result = await openBlobSource(ctx, id, MAX_BUFFERED_BLOB_BYTES);

        // Assert
        expect(result.kind).toBe('bytes');
        if (result.kind === 'bytes') {
          expect(result.type).toBe('blob');
          expect(result.content).toEqual(content);
        }
      });
    });

    describe('When openBlobSource is called with the gate at 0', () => {
      it('Then the cache probe is skipped and OBJECT_NOT_FOUND is thrown', async () => {
        // Arrange
        const content = ENC.encode('cached blob content, gate closed');
        const full = looseFormatBytes('blob', content);
        const ctx = await buildSeededContext();
        const id = (await ctx.hash.hashHex(full)) as ObjectId;
        ctx.deltaCache.set(id, full, full.length);

        // Act + Assert
        try {
          await openBlobSource(ctx, id, 0);
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
  });

  describe('Given a loose blob', () => {
    describe('When openBlobSource is called with the gate at the compressed length', () => {
      it('Then resolves as a bytes source split via splitObject', async () => {
        // Arrange
        const blob: Blob = {
          type: 'blob',
          content: ENC.encode('loose gate test content'),
          id: '' as ObjectId,
        };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = await writeObject(ctx, blob);
        const compressedLen = await looseCompressedLength(ctx, id);

        // Act
        const result = await openBlobSource(ctx, id, compressedLen);

        // Assert
        expect(result.kind).toBe('bytes');
        if (result.kind === 'bytes') {
          expect(result.type).toBe('blob');
          expect(result.content).toEqual(blob.content);
        }
      });
    });

    describe('When openBlobSource is called with the gate one byte under the compressed length', () => {
      it('Then resolves as a stream source with type undefined', async () => {
        // Arrange
        const blob: Blob = {
          type: 'blob',
          content: ENC.encode('loose streamed gate test content'),
          id: '' as ObjectId,
        };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = await writeObject(ctx, blob);
        const compressedLen = await looseCompressedLength(ctx, id);

        // Act
        const result = await openBlobSource(ctx, id, compressedLen - 1);

        // Assert
        expect(result.kind).toBe('stream');
        if (result.kind === 'stream') {
          expect(result.type).toBeUndefined();
          expect(result.materialised).toBe(false);
          const drained = await collect(result.stream);
          expect(drained).toEqual(blob.content);
        }
      });
    });
  });

  describe('Given a packed base (non-delta) blob', () => {
    describe('When openBlobSource is called with the gate at the payload length', () => {
      it('Then resolves as a bytes source with raw content and no loose-format header', async () => {
        // Arrange
        const content = ENC.encode('packed base content for the buffered gate test');
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'gate-base', [
          { kind: 'base', type: 'blob', content },
        ]);
        const id = ids[0] as ObjectId;
        const payloadLen = (await ctx.compressor.deflate(content)).length;

        // Act
        const result = await openBlobSource(ctx, id, payloadLen);

        // Assert
        expect(result.kind).toBe('bytes');
        if (result.kind === 'bytes') {
          expect(result.type).toBe('blob');
          expect(result.content).toEqual(content);
        }
      });
    });

    describe('When openBlobSource is called with the gate one byte under the payload length', () => {
      it('Then resolves as a stream source with the type already known', async () => {
        // Arrange
        const content = ENC.encode('packed base content for the streamed gate test');
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'gate-base-stream', [
          { kind: 'base', type: 'blob', content },
        ]);
        const id = ids[0] as ObjectId;
        const payloadLen = (await ctx.compressor.deflate(content)).length;

        // Act
        const result = await openBlobSource(ctx, id, payloadLen - 1);

        // Assert
        expect(result.kind).toBe('stream');
        if (result.kind === 'stream') {
          expect(result.type).toBe('blob');
          expect(result.materialised).toBe(false);
          const drained = await collect(result.stream);
          expect(drained).toEqual(content);
        }
      });
    });
  });

  describe('Given a packed base blob whose payload fits the gate but whose inflated size does not', () => {
    describe('When openBlobSource is called with the gate over the payload length', () => {
      it('Then resolves streamed, so the inflated bytes are never materialised', async () => {
        // Arrange — 512 KiB of one byte deflates to a few hundred bytes, so the
        // compressed length alone would wave it through the buffered arm.
        const content = new Uint8Array(512 * 1024).fill(0x61);
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'gate-base-inflated', [
          { kind: 'base', type: 'blob', content },
        ]);
        const id = ids[0] as ObjectId;
        const payloadLen = (await ctx.compressor.deflate(content)).length;

        // Act
        const result = await openBlobSource(ctx, id, MAX_BUFFERED_BLOB_BYTES);

        // Assert
        expect(payloadLen).toBeLessThan(MAX_BUFFERED_BLOB_BYTES);
        expect(content.length).toBeGreaterThan(MAX_BUFFERED_BLOB_BYTES);
        expect(result.kind).toBe('stream');
        if (result.kind === 'stream') {
          expect(result.type).toBe('blob');
          const drained = await collect(result.stream);
          expect(drained).toEqual(content);
        }
      });
    });
  });

  describe('Given a deltified packed blob', () => {
    describe('When openBlobSource is called with the gate at 0', () => {
      it('Then resolves as a bytes source (the gate is a no-op for deltas)', async () => {
        // Arrange
        const baseContent = ENC.encode('base content for delta-arm test');
        const targetContent = ENC.encode('delta target content for delta-arm test');
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'delta-arm', [
          { kind: 'base', type: 'blob', content: baseContent },
          { kind: 'ofs-delta', baseIndex: 0, targetContent },
        ]);
        const id = ids[1] as ObjectId;

        // Act
        const result = await openBlobSource(ctx, id, 0);

        // Assert
        expect(result.kind).toBe('bytes');
        if (result.kind === 'bytes') {
          expect(result.type).toBe('blob');
          expect(result.content).toEqual(targetContent);
        }
      });
    });
  });

  describe('Given an id present in neither loose nor pack storage', () => {
    describe('When openBlobSource is called', () => {
      it('Then throws objectNotFound with correct data', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = 'f'.repeat(40) as ObjectId;

        // Act + Assert
        try {
          await openBlobSource(ctx, id, MAX_BUFFERED_BLOB_BYTES);
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
  });

  describe('Given the empty-tree oid, absent from both loose and pack storage', () => {
    describe('When openBlobSource is called', () => {
      it('Then throws objectNotFound, never unexpectedObjectType (no virtual short-circuit)', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act + Assert
        try {
          await openBlobSource(ctx, EMPTY_TREE_OID, MAX_BUFFERED_BLOB_BYTES);
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_NOT_FOUND');
          if (data.code === 'OBJECT_NOT_FOUND') {
            expect(data.id).toBe(EMPTY_TREE_OID);
          }
        }
      });
    });
  });

  describe('Given a loose non-blob (commit) object', () => {
    describe('When openBlobSource resolves it buffered (gate at the compressed length)', () => {
      it('Then reports the real type without refusing', async () => {
        // Arrange
        const { ctx, id } = await buildLooseCommit();
        const compressedLen = await looseCompressedLength(ctx, id);

        // Act
        const result = await openBlobSource(ctx, id, compressedLen);

        // Assert
        expect(result.kind).toBe('bytes');
        if (result.kind === 'bytes') {
          expect(result.type).toBe('commit');
        }
      });
    });

    describe('When openBlobSource resolves it streamed (gate one byte under the compressed length)', () => {
      it('Then type is undefined until first drain, which throws unexpectedObjectType', async () => {
        // Arrange
        const { ctx, id } = await buildLooseCommit();
        const compressedLen = await looseCompressedLength(ctx, id);

        // Act
        const result = await openBlobSource(ctx, id, compressedLen - 1);

        // Assert
        expect(result.kind).toBe('stream');
        if (result.kind === 'stream') {
          expect(result.type).toBeUndefined();
          try {
            await collect(result.stream);
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
        }
      });
    });
  });

  describe('Given a packed base non-blob (tree) object', () => {
    describe('When openBlobSource resolves it streamed (gate at 0)', () => {
      it('Then reports the real type and verifies against that type header', async () => {
        // Arrange
        const content = ENC.encode('tree-like content for pack-base type test');
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'pack-base-non-blob', [
          { kind: 'base', type: 'tree', content },
        ]);
        const id = ids[0] as ObjectId;

        // Act
        const result = await openBlobSource(ctx, id, 0);

        // Assert
        expect(result.kind).toBe('stream');
        if (result.kind === 'stream') {
          expect(result.type).toBe('tree');
          const drained = await collect(result.stream);
          expect(drained).toEqual(content);
        }
      });
    });

    describe('When openBlobSource resolves it buffered (gate over the entry size)', () => {
      it('Then reports the real type instead of failing the blob-shaped hash', async () => {
        // Arrange — the seam only REPORTS type, so a non-blob must reach the
        // caller's refusal rather than dying on a hash rebuilt as `blob <n>`.
        const content = ENC.encode('tree-like content for the buffered type test');
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'pack-base-non-blob-buffered', [
          { kind: 'base', type: 'tree', content },
        ]);
        const id = ids[0] as ObjectId;

        // Act
        const result = await openBlobSource(ctx, id, MAX_BUFFERED_BLOB_BYTES);

        // Assert
        expect(result.kind).toBe('bytes');
        if (result.kind === 'bytes') {
          expect(result.type).toBe('tree');
          expect(result.content).toEqual(content);
        }
      });
    });
  });

  describe('Given a corrupted loose object resolved buffered', () => {
    describe('When openBlobSource is called with verifyHash default (true)', () => {
      it('Then throws objectHashMismatch before returning (eager verification)', async () => {
        // Arrange
        const blob: Blob = {
          type: 'blob',
          content: ENC.encode('original content'),
          id: '' as ObjectId,
        };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = await writeObject(ctx, blob);
        const corruptBytes = looseFormatBytes('blob', ENC.encode('CORRUPTED content'));
        const compressed = await ctx.compressor.deflate(corruptBytes);
        const loosePath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`;
        await ctx.fs.write(loosePath, compressed);

        // Act + Assert
        try {
          await openBlobSource(ctx, id, MAX_BUFFERED_BLOB_BYTES);
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_HASH_MISMATCH');
          if (data.code === 'OBJECT_HASH_MISMATCH') {
            expect(data.expected).toBe(id);
            expect(data.actual).not.toBe(id);
          }
        }
      });
    });

    describe('When openBlobSource is called with verifyHash false', () => {
      it('Then resolves without throwing (opt-out)', async () => {
        // Arrange
        const blob: Blob = {
          type: 'blob',
          content: ENC.encode('original content'),
          id: '' as ObjectId,
        };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = await writeObject(ctx, blob);
        const corruptContent = ENC.encode('CORRUPTED content');
        const corruptBytes = looseFormatBytes('blob', corruptContent);
        const compressed = await ctx.compressor.deflate(corruptBytes);
        const loosePath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`;
        await ctx.fs.write(loosePath, compressed);

        // Act
        const result = await openBlobSource(ctx, id, MAX_BUFFERED_BLOB_BYTES, {
          verifyHash: false,
        });

        // Assert
        expect(result.kind).toBe('bytes');
        if (result.kind === 'bytes') {
          expect(result.content).toEqual(corruptContent);
        }
      });
    });
  });

  describe('Given a corrupted loose object resolved streamed (gate at 0)', () => {
    describe('When the returned stream is drained', () => {
      it('Then throws objectHashMismatch lazily, on first drain', async () => {
        // Arrange
        const blob: Blob = {
          type: 'blob',
          content: ENC.encode('original content'),
          id: '' as ObjectId,
        };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = await writeObject(ctx, blob);
        const corruptBytes = looseFormatBytes('blob', ENC.encode('CORRUPTED content'));
        const compressed = await ctx.compressor.deflate(corruptBytes);
        const loosePath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`;
        await ctx.fs.write(loosePath, compressed);

        // Act — resolves fine; the stream itself is not yet drained
        const result = await openBlobSource(ctx, id, 0);

        // Assert
        expect(result.kind).toBe('stream');
        if (result.kind === 'stream') {
          try {
            await collect(result.stream);
            expect.unreachable();
          } catch (error) {
            expect(error).toBeInstanceOf(TsgitError);
            const data = (error as TsgitError).data;
            expect(data.code).toBe('OBJECT_HASH_MISMATCH');
            if (data.code === 'OBJECT_HASH_MISMATCH') {
              expect(data.expected).toBe(id);
              expect(data.actual).not.toBe(id);
            }
          }
        }
      });
    });
  });

  describe('Given a ctx.signal aborted before the call', () => {
    describe('When openBlobSource is called', () => {
      it('Then throws operationAborted', async () => {
        // Arrange
        const controller = new AbortController();
        const ctx = await buildSeededContext({ signal: controller.signal });
        controller.abort();

        // Act + Assert
        try {
          await openBlobSource(ctx, 'f'.repeat(40) as ObjectId, MAX_BUFFERED_BLOB_BYTES);
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OPERATION_ABORTED');
        }
      });
    });
  });
});
