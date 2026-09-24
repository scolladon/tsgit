import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_BUFFERED_BLOB_BYTES,
  openBlobSource,
  type VerifiedObject,
  verifyStoredObject,
} from '../../../../../src/application/primitives/internal/blob-source.js';
import { getPackRegistry } from '../../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import { serializeObject } from '../../../../../src/domain/objects/git-object.js';
import type { Blob, Commit, ObjectId, Tag } from '../../../../../src/domain/objects/index.js';
import { EMPTY_TREE_OID } from '../../../../../src/domain/objects/index.js';
import { parseAcceptanceVerdict } from '../../../../../src/domain/objects/parse-acceptance.js';
import { computeLooseObjectPath } from '../../../../../src/domain/storage/loose-path.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildSeededContext, writeRawObjectBytes } from '../fixtures.js';
import { buildSyntheticPack, corruptIdxOffset, writeSyntheticPack } from '../pack-fixture.js';

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

/** Like `looseFormatBytes`, but the header's size claim is given explicitly
 *  instead of derived from `content` — a size-lying loose-format buffer. */
function looseFormatBytesWithClaim(
  type: string,
  declaredSize: number,
  content: Uint8Array,
): Uint8Array {
  const header = ENC.encode(`${type} ${declaredSize}\0`);
  const out = new Uint8Array(header.length + content.length);
  out.set(header, 0);
  out.set(content, header.length);
  return out;
}

/** Wraps a readable so cancellation is counted — an un-cancelled stream is
 *  exactly the leaked reader/inflate instance `release()` exists to avoid. */
function trackedReadable(
  source: ReadableStream<Uint8Array>,
  onCancel: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel: async (reason) => {
      onCancel();
      await reader.cancel(reason);
    },
  });
}

/** Overwrite an already-written loose object's on-disk file with `bytes` —
 *  used to plant a size-lying header at an id whose file already exists. */
async function overwriteLoose(
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  id: ObjectId,
  bytes: Uint8Array,
): Promise<void> {
  const loosePath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`;
  const compressed = await ctx.compressor.deflate(bytes);
  await ctx.fs.write(loosePath, compressed);
}

async function buildLooseCommit(): Promise<{
  ctx: Awaited<ReturnType<typeof buildSeededContext>>;
  id: ObjectId;
  content: Uint8Array;
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
  const serialized = serializeObject(commit, ctx.hashConfig);
  const content = serialized.subarray(serialized.indexOf(0) + 1);
  return { ctx, id, content };
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
        ctx.deltaCache.set(id, { type: 'blob', content }, content.length);

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
        ctx.deltaCache.set(id, { type: 'blob', content }, content.length);

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
      it('Then resolves as a stream source reporting its type at open', async () => {
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
          expect(result.type).toBe('blob');
          expect(result.materialised).toBe(false);
          const drained = await collect(result.stream);
          expect(drained).toEqual(blob.content);
        }
      });
    });
  });

  describe('Given a loose blob whose header size claim disagrees with its body length', () => {
    describe('When openBlobSource is called with the gate at the compressed length', () => {
      it('Then resolves as a bytes source with the real content', async () => {
        // Arrange
        const blob: Blob = {
          type: 'blob',
          content: ENC.encode('lying loose blob content'),
          id: '' as ObjectId,
        };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = await writeObject(ctx, blob);
        await overwriteLoose(ctx, id, looseFormatBytesWithClaim('blob', 3, blob.content));
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
  });

  describe('Given a loose commit whose header size claim disagrees with its body length', () => {
    describe('When openBlobSource is called with the gate at the compressed length', () => {
      it('Then throws INVALID_OBJECT_HEADER with the verbatim size-mismatch reason', async () => {
        // Arrange
        const { ctx, id } = await buildLooseCommit();
        const content = ENC.encode('short commit body');
        await overwriteLoose(ctx, id, looseFormatBytesWithClaim('commit', 999, content));
        const compressedLen = await looseCompressedLength(ctx, id);

        // Act
        try {
          await openBlobSource(ctx, id, compressedLen);
          // Assert
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('INVALID_OBJECT_HEADER');
          if (data.code === 'INVALID_OBJECT_HEADER') {
            expect(data.reason).toBe(
              `size mismatch: header says 999, actual content is ${content.byteLength}`,
            );
          }
        }
      });
    });
  });

  describe('Given a loose blob whose header size claim disagrees with its body length, opened with verifyHash true', () => {
    describe('When openBlobSource is called with the gate at the compressed length', () => {
      it('Then throws OBJECT_HASH_MISMATCH hashing the stored (lying) bytes', async () => {
        // Arrange
        const blob: Blob = {
          type: 'blob',
          content: ENC.encode('lying loose blob content'),
          id: '' as ObjectId,
        };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = await writeObject(ctx, blob);
        const lyingBytes = looseFormatBytesWithClaim('blob', 3, blob.content);
        await overwriteLoose(ctx, id, lyingBytes);
        const compressedLen = await looseCompressedLength(ctx, id);
        const expectedActual = (await ctx.hash.hashHex(lyingBytes)) as ObjectId;

        // Act
        try {
          await openBlobSource(ctx, id, compressedLen, { verifyHash: true });
          // Assert
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_HASH_MISMATCH');
          if (data.code === 'OBJECT_HASH_MISMATCH') {
            expect(data.expected).toBe(id);
            expect(data.actual).toBe(expectedActual);
          }
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

  describe('Given a packed base blob whose idx successor offset was corrupted past the pack file size', () => {
    describe('When openBlobSource is called', () => {
      it('Then throws INVALID_PACK_INDEX with the next-offset-exceeds reason', async () => {
        // Arrange — mirrors the readObjectMetadata regression: the SECOND
        // entry's on-disk `.idx` offset is overwritten with a value far past
        // the pack's actual size, so it becomes the first entry's successor
        // by numeric value. openBlobSource's own pack arm (blob-source.ts)
        // must inherit the same bound readEntryHeaderWithChunk now enforces,
        // rather than pass the bogus successor into readSlice.
        const ctx = await buildSeededContext();
        const built = await buildSyntheticPack(ctx, [
          { kind: 'base', type: 'blob', content: ENC.encode('first') },
          { kind: 'base', type: 'blob', content: ENC.encode('second') },
        ]);
        const digestLength = ctx.hashConfig.digestLength;
        const idxBytes = corruptIdxOffset(
          built.idxBytes,
          digestLength,
          built.offsets[1]!,
          0x7ffffff0,
        );
        const base = `${ctx.layout.gitDir}/objects/pack/pack-blob-source-corrupt-bounds`;
        await ctx.fs.write(`${base}.pack`, built.packBytes);
        await ctx.fs.write(`${base}.idx`, idxBytes);
        const targetId = built.ids[0] as ObjectId;

        // Act
        try {
          await openBlobSource(ctx, targetId, MAX_BUFFERED_BLOB_BYTES);
          expect.unreachable();
        } catch (error) {
          // Assert
          const data = (error as TsgitError).data;
          expect(data.code).toBe('INVALID_PACK_INDEX');
          if (data.code !== 'INVALID_PACK_INDEX') {
            expect.fail(`expected INVALID_PACK_INDEX, got ${data.code}`);
          }
          expect(data.reason).toBe('next offset exceeds pack file size: corrupt index');
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

  describe('Given a pack written directly to disk after openBlobSource already forced a registry scan', () => {
    describe('When openBlobSource is called for the newly-packed id', () => {
      it('Then it resolves via one re-scan retry, mirroring reprepare_packed_git', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const registry = await getPackRegistry(ctx);
        await registry.all(); // force the (empty) generation the write below bypasses
        const content = ENC.encode('packed after scan\n');
        const [id] = await writeSyntheticPack(ctx, 'blob-source-late-pack', [
          { kind: 'base', type: 'blob', content },
        ]);

        // Act
        const source = await openBlobSource(ctx, id as ObjectId, MAX_BUFFERED_BLOB_BYTES);

        // Assert
        expect(source.kind).toBe('bytes');
        if (source.kind === 'bytes') {
          expect(source.content).toEqual(content);
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
      it('Then reports the real type without refusing, and caches it (non-blob types are reused, not read-once)', async () => {
        // Arrange
        const { ctx, id } = await buildLooseCommit();
        const compressedLen = await looseCompressedLength(ctx, id);

        // Act
        const result = await openBlobSource(ctx, id, compressedLen);

        // Assert
        expect(result.kind).toBe('bytes');
        if (result.kind === 'bytes') {
          expect(result.type).toBe('commit');
          expect(ctx.deltaCache.get(id)).toEqual({ type: 'commit', content: result.content });
        }
      });
    });

    describe('When openBlobSource resolves it streamed (gate one byte under the compressed length)', () => {
      it('Then type is known at open, and draining yields the body without refusing', async () => {
        // Arrange
        const { ctx, id, content } = await buildLooseCommit();
        const compressedLen = await looseCompressedLength(ctx, id);

        // Act
        const result = await openBlobSource(ctx, id, compressedLen - 1);

        // Assert — openBlobSource only REPORTS type; refusing a non-blob is a
        // caller concern, so draining a commit through it succeeds.
        expect(result.kind).toBe('stream');
        if (result.kind === 'stream') {
          expect(result.type).toBe('commit');
          const drained = await collect(result.stream);
          expect(drained).toEqual(content);
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
      it('Then reports the real type instead of failing the blob-shaped hash, and caches it (non-blob types are reused, not read-once)', async () => {
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
          expect(ctx.deltaCache.get(id)).toEqual({ type: 'tree', content });
        }
      });
    });
  });

  describe('Given a packed base entry indexed under an id its bytes do not hash to', () => {
    describe('When openBlobSource resolves it buffered (gate over the entry size)', () => {
      it('Then throws objectHashMismatch, verified against the synthetic type header', async () => {
        // Arrange — the buffered pack-base arm rebuilds `<type> <size>\0` from
        // the entry header and hashes it with the content; a lying index entry
        // is the only way that rebuild can disagree with the id.
        const content = ENC.encode('packed base content indexed under the wrong id');
        const ctx = await buildSeededContext();
        const wrongId = 'b'.repeat(40) as ObjectId;
        await writeSyntheticPack(ctx, 'pack-base-hash-mismatch', [
          { kind: 'base', type: 'blob', content, idOverride: wrongId },
        ]);
        const storedId = await ctx.hash.hashHex(looseFormatBytes('blob', content));

        // Act + Assert
        try {
          await openBlobSource(ctx, wrongId, MAX_BUFFERED_BLOB_BYTES, { verifyHash: true });
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_HASH_MISMATCH');
          if (data.code === 'OBJECT_HASH_MISMATCH') {
            expect(data.expected).toBe(wrongId);
            expect(data.actual).toBe(storedId);
          }
        }
      });
    });
  });

  describe('Given a corrupted loose object resolved buffered', () => {
    describe('When openBlobSource is called with the default', () => {
      it('Then it returns the corrupt bytes (unverified by default)', async () => {
        // Arrange
        // Kills the `options?.verifyHash ?? false` BooleanLiteral mutant to
        // `true`: the default must stay unverified, or corrupt bytes would be
        // refused instead of returned.
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
        const result = await openBlobSource(ctx, id, MAX_BUFFERED_BLOB_BYTES);

        // Assert
        expect(result.kind).toBe('bytes');
        if (result.kind === 'bytes') {
          expect(result.content).toEqual(corruptContent);
        }
      });
    });

    describe('When openBlobSource is called with verifyHash true', () => {
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
        const corruptId = await ctx.hash.hashHex(corruptBytes);
        const compressed = await ctx.compressor.deflate(corruptBytes);
        const loosePath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`;
        await ctx.fs.write(loosePath, compressed);

        // Act + Assert
        try {
          await openBlobSource(ctx, id, MAX_BUFFERED_BLOB_BYTES, { verifyHash: true });
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_HASH_MISMATCH');
          if (data.code === 'OBJECT_HASH_MISMATCH') {
            expect(data.expected).toBe(id);
            expect(data.actual).toBe(corruptId);
          }
        }
      });
    });
  });

  describe('Given a corrupted loose object resolved streamed (gate at 0)', () => {
    describe('When the returned stream is drained with the default', () => {
      it('Then it yields the corrupt bytes (unverified by default)', async () => {
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
        const result = await openBlobSource(ctx, id, 0);

        // Assert
        expect(result.kind).toBe('stream');
        if (result.kind === 'stream') {
          const drained = await collect(result.stream);
          expect(drained).toEqual(corruptContent);
        }
      });
    });

    describe('When the returned stream is drained with verifyHash true', () => {
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
        const corruptId = await ctx.hash.hashHex(corruptBytes);
        const compressed = await ctx.compressor.deflate(corruptBytes);
        const loosePath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`;
        await ctx.fs.write(loosePath, compressed);

        // Act — resolves fine; the stream itself is not yet drained
        const result = await openBlobSource(ctx, id, 0, { verifyHash: true });

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
              expect(data.actual).toBe(corruptId);
            }
          }
        }
      });
    });
  });

  describe('Given the loose header read finds a malformed header', () => {
    describe('When openBlobSource is called', () => {
      it('Then it rejects INVALID_OBJECT_HEADER and still releases the inflate pipeline', async () => {
        // Arrange — the header read happens at open now (not on first
        // drain), so a throw there must still return the iterator, or the
        // inflate pipeline leaks. The readable is left open (never closed),
        // so a genuine cancellation — not a no-op on an already-closed
        // stream — is what proves the release ran.
        const blob: Blob = { type: 'blob', content: ENC.encode('content'), id: '' as ObjectId };
        const base = await buildSeededContext({ objects: [blob] });
        const id = await writeObject(base, blob);
        let cancels = 0;
        const ctx = {
          ...base,
          compressor: {
            ...base.compressor,
            createInflateStream: () => ({
              readable: trackedReadable(
                new ReadableStream<Uint8Array>({
                  start: (controller) => {
                    controller.enqueue(ENC.encode('garbage\0left open'));
                  },
                }),
                () => {
                  cancels += 1;
                },
              ),
              writable: new WritableStream<Uint8Array>(),
            }),
          },
        };

        // Act + Assert
        try {
          await openBlobSource(ctx, id, 0);
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          const data = (error as TsgitError).data;
          expect(data.code).toBe('INVALID_OBJECT_HEADER');
          if (data.code === 'INVALID_OBJECT_HEADER') {
            expect(data.reason).toBe('missing space between type and size');
          }
        }
        expect(cancels).toBe(1);
      });
    });
  });

  describe('Given a streamed loose source that has not been drained', () => {
    describe('When release() is called on it', () => {
      it('Then it cancels the inflate readable exactly once', async () => {
        // Arrange
        const blob: Blob = { type: 'blob', content: ENC.encode('content'), id: '' as ObjectId };
        const base = await buildSeededContext({ objects: [blob] });
        const id = await writeObject(base, blob);
        let cancels = 0;
        const ctx = {
          ...base,
          compressor: {
            ...base.compressor,
            createInflateStream: () => {
              const inner = base.compressor.createInflateStream();
              return {
                readable: trackedReadable(inner.readable, () => {
                  cancels += 1;
                }),
                writable: inner.writable,
              };
            },
          },
        };
        const source = await openBlobSource(ctx, id, 0);

        // Act
        expect(source.kind).toBe('stream');
        if (source.kind === 'stream') {
          await source.release();
        }

        // Assert
        expect(cancels).toBe(1);
      });
    });
  });

  // Cancelling an errored readable rejects with the error the stream stored, which would
  // replace whatever the caller is really reporting; nothing is left to release by then.
  describe('Given a streamed loose source whose inflate readable errored after handing over the header', () => {
    describe('When release() is called on it', () => {
      it('Then it resolves instead of re-throwing the stream’s stored error', async () => {
        // Arrange — the header is read at open, so the readable must yield it before erroring.
        const blob: Blob = { type: 'blob', content: ENC.encode('content'), id: '' as ObjectId };
        const base = await buildSeededContext({ objects: [blob] });
        const id = await writeObject(base, blob);
        let errored = false;
        const ctx = {
          ...base,
          compressor: {
            ...base.compressor,
            createInflateStream: () => ({
              readable: new ReadableStream<Uint8Array>({
                start: (controller) => {
                  controller.enqueue(looseFormatBytes('blob', blob.content));
                },
                pull: (controller) => {
                  errored = true;
                  controller.error(new Error('inflate blew up'));
                },
              }),
              writable: new WritableStream<Uint8Array>(),
            }),
          },
        };
        const source = await openBlobSource(ctx, id, 0);

        // Act
        const released = source.kind === 'stream' ? await source.release() : source.kind;

        // Assert
        expect(released).toBeUndefined();
        expect(errored).toBe(true);
      });
    });
  });

  describe('Given a streamed packed base source whose inflate readable has already errored', () => {
    describe('When release() is called on it', () => {
      it('Then it resolves instead of re-throwing the stream’s stored error', async () => {
        // Arrange
        const base = await buildSeededContext();
        const ids = await writeSyntheticPack(base, 'release-errored-base', [
          { kind: 'base', type: 'blob', content: ENC.encode('packed base content to release') },
        ]);
        const ctx = {
          ...base,
          compressor: {
            ...base.compressor,
            createInflateStream: () => ({
              readable: new ReadableStream<Uint8Array>({
                start: (controller) => {
                  controller.error(new Error('inflate blew up'));
                },
              }),
              writable: new WritableStream<Uint8Array>(),
            }),
          },
        };
        const source = await openBlobSource(ctx, ids[0] as ObjectId, 0);

        // Act
        const released = source.kind === 'stream' ? await source.release() : source.kind;

        // Assert
        expect(released).toBeUndefined();
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

  describe('Given a loose blob resolved buffered', () => {
    describe('When openBlobSource is called with the gate at the compressed length', () => {
      it('Then it is never cached in ctx.deltaCache — a read-once blob would only evict hotter tree/commit entries', async () => {
        // Arrange
        const blob: Blob = {
          type: 'blob',
          content: ENC.encode('loose buffered caching content'),
          id: '' as ObjectId,
        };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = await writeObject(ctx, blob);
        const compressedLen = await looseCompressedLength(ctx, id);

        // Act
        await openBlobSource(ctx, id, compressedLen);

        // Assert
        expect(ctx.deltaCache.get(id)).toBeUndefined();
      });
    });
  });

  describe('Given a loose blob resolved streamed (gate one byte under the compressed length)', () => {
    describe('When the returned stream is fully drained', () => {
      it('Then it is never cached in ctx.deltaCache', async () => {
        // Arrange
        const blob: Blob = {
          type: 'blob',
          content: ENC.encode('loose streamed caching content'),
          id: '' as ObjectId,
        };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = await writeObject(ctx, blob);
        const compressedLen = await looseCompressedLength(ctx, id);

        // Act
        const result = await openBlobSource(ctx, id, compressedLen - 1);
        if (result.kind === 'stream') {
          await collect(result.stream);
        }

        // Assert
        expect(result.kind).toBe('stream');
        expect(ctx.deltaCache.get(id)).toBeUndefined();
      });
    });
  });

  describe('Given a loose blob whose header size claim disagrees with its body length', () => {
    describe('When openBlobSource is called with the gate at the compressed length', () => {
      it('Then the size-lying entry is never cached in ctx.deltaCache', async () => {
        // Arrange
        const blob: Blob = {
          type: 'blob',
          content: ENC.encode('size-lying loose blob content'),
          id: '' as ObjectId,
        };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = await writeObject(ctx, blob);
        await overwriteLoose(ctx, id, looseFormatBytesWithClaim('blob', 3, blob.content));
        const compressedLen = await looseCompressedLength(ctx, id);

        // Act
        await openBlobSource(ctx, id, compressedLen);

        // Assert
        expect(ctx.deltaCache.get(id)).toBeUndefined();
      });
    });
  });

  describe('Given a packed base (non-delta) blob', () => {
    describe('When openBlobSource is called with the gate at the payload length', () => {
      it('Then it is never cached in ctx.deltaCache — a read-once blob would only evict hotter tree/commit entries', async () => {
        // Arrange
        const content = ENC.encode('packed base content for the caching test');
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'cache-base', [
          { kind: 'base', type: 'blob', content },
        ]);
        const id = ids[0] as ObjectId;
        const payloadLen = (await ctx.compressor.deflate(content)).length;

        // Act
        await openBlobSource(ctx, id, payloadLen);

        // Assert
        expect(ctx.deltaCache.get(id)).toBeUndefined();
      });
    });

    describe('When openBlobSource is called with the gate one byte under the payload length', () => {
      it('Then the streamed result is never cached in ctx.deltaCache', async () => {
        // Arrange
        const content = ENC.encode('packed base content for the streamed caching test');
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'cache-base-stream', [
          { kind: 'base', type: 'blob', content },
        ]);
        const id = ids[0] as ObjectId;
        const payloadLen = (await ctx.compressor.deflate(content)).length;

        // Act
        const result = await openBlobSource(ctx, id, payloadLen - 1);
        if (result.kind === 'stream') {
          await collect(result.stream);
        }

        // Assert
        expect(result.kind).toBe('stream');
        expect(ctx.deltaCache.get(id)).toBeUndefined();
      });
    });
  });
});

const IDENTITY = { name: 'A', email: 'a@a.com', timestamp: 1, timezoneOffset: '+0000' as const };

const NO_ACCEPTANCE_SCAN = 'no acceptance scan';

/** The verdict a verified object's scan reaches with parent lookups checked,
 *  or a marker distinct from "accepted" when the object carries no scan. */
const checkedVerdict = (verified: VerifiedObject) =>
  verified.acceptance === undefined
    ? NO_ACCEPTANCE_SCAN
    : parseAcceptanceVerdict(verified.acceptance, { parentLookups: 'checked' });

/** A long, deflate-resistant printable-ASCII string — pushes a loose
 *  object's COMPRESSED size past the buffered gate without any non-UTF-8
 *  byte concerns (`Commit`/`Tag` messages are plain strings). */
function pseudoRandomAsciiMessage(length: number, seed: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    let h = (seed * 1_000_003 + i) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    out += String.fromCharCode(32 + (h % 95));
  }
  return out;
}

describe('verifyStoredObject', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Given a delta-cache entry whose content does NOT hash to its own key', () => {
    describe('When verifyStoredObject is called', () => {
      it('Then it refuses OBJECT_HASH_MISMATCH — a cache hit is hashed, never trusted', async () => {
        // Arrange — the id names one (real) blob; the cache is poisoned
        // with a DIFFERENT blob's content under that same id.
        const ctx = await buildSeededContext();
        const realId = (await ctx.hash.hashHex(
          looseFormatBytes('blob', ENC.encode('real')),
        )) as ObjectId;
        const poisoned = ENC.encode('an entirely different body');
        ctx.deltaCache.set(realId, { type: 'blob', content: poisoned }, poisoned.length);
        const poisonedId = await ctx.hash.hashHex(looseFormatBytes('blob', poisoned));

        // Act + Assert
        try {
          await verifyStoredObject(ctx, realId);
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_HASH_MISMATCH');
          if (data.code === 'OBJECT_HASH_MISMATCH') {
            expect(data.expected).toBe(realId);
            expect(data.actual).toBe(poisonedId);
          }
        }
      });
    });
  });

  describe('Given a delta-cache entry that genuinely hashes to its key', () => {
    describe('When verifyStoredObject is called', () => {
      it('Then it resolves with the cached type and no acceptance scan (a blob)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = ENC.encode('cached content');
        const id = (await ctx.hash.hashHex(looseFormatBytes('blob', content))) as ObjectId;
        ctx.deltaCache.set(id, { type: 'blob', content }, content.length);

        // Act
        const result = await verifyStoredObject(ctx, id);

        // Assert
        expect(result.type).toBe('blob');
        expect(result.acceptance).toBeUndefined();
      });
    });
  });

  describe('Given a buffered loose blob', () => {
    describe('When verifyStoredObject is called', () => {
      it('Then it resolves with no acceptance scan', async () => {
        // Arrange
        const blob: Blob = { type: 'blob', content: ENC.encode('hello'), id: '' as ObjectId };
        const ctx = await buildSeededContext({ objects: [blob] });
        const id = await writeObject(ctx, blob);

        // Act
        const result = await verifyStoredObject(ctx, id);

        // Assert
        expect(result.type).toBe('blob');
        expect(result.acceptance).toBeUndefined();
      });
    });
  });

  describe('Given a streamed loose commit above the buffered gate', () => {
    describe('When verifyStoredObject is called', () => {
      it('Then its acceptance scan accepts the commit', async () => {
        // Arrange
        const commit: Commit = {
          type: 'commit',
          id: '' as ObjectId,
          data: {
            tree: ZERO_ID,
            parents: [],
            author: IDENTITY,
            committer: IDENTITY,
            message: pseudoRandomAsciiMessage(150_000, 1),
            extraHeaders: [],
          },
        };
        const ctx = await buildSeededContext({ objects: [commit] });
        const id = await writeObject(ctx, commit);
        expect(await looseCompressedLength(ctx, id)).toBeGreaterThan(MAX_BUFFERED_BLOB_BYTES);

        // Act
        const result = await verifyStoredObject(ctx, id);

        // Assert
        expect(result.type).toBe('commit');
        expect(checkedVerdict(result)).toBeUndefined();
      });
    });
  });

  describe('Given a streamed loose commit above the buffered gate with a malformed parent line', () => {
    describe('When verifyStoredObject is called', () => {
      it('Then its acceptance scan refuses bad parents', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const body = ENC.encode(
          `tree ${ZERO_ID}\nparent ${'g'.repeat(40)}\n\n${pseudoRandomAsciiMessage(150_000, 2)}`,
        );
        const id = await writeRawObjectBytes(ctx, 'commit', body);
        expect(await looseCompressedLength(ctx, id)).toBeGreaterThan(MAX_BUFFERED_BLOB_BYTES);

        // Act
        const result = await verifyStoredObject(ctx, id);

        // Assert
        expect(result.type).toBe('commit');
        expect(checkedVerdict(result)).toEqual({ type: 'commit', reason: 'bad parents' });
      });
    });
  });

  describe('Given a buffered loose tag', () => {
    describe('When verifyStoredObject is called', () => {
      it('Then its acceptance scan accepts the tag', async () => {
        // Arrange
        const tag: Tag = {
          type: 'tag',
          id: '' as ObjectId,
          data: {
            object: ZERO_ID,
            objectType: 'commit',
            tagName: 't',
            message: 'msg',
            extraHeaders: [],
          },
        };
        const ctx = await buildSeededContext({ objects: [tag] });
        const id = await writeObject(ctx, tag);

        // Act
        const result = await verifyStoredObject(ctx, id);

        // Assert
        expect(result.type).toBe('tag');
        expect(checkedVerdict(result)).toBeUndefined();
      });
    });
  });

  describe('Given a buffered loose tree', () => {
    describe('When verifyStoredObject is called', () => {
      it('Then it resolves with no acceptance scan (git never parses a tree)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeRawObjectBytes(ctx, 'tree', ENC.encode('not really a tree body'));

        // Act
        const result = await verifyStoredObject(ctx, id);

        // Assert
        expect(result.type).toBe('tree');
        expect(result.acceptance).toBeUndefined();
      });
    });
  });

  describe('Given a buffered packed base tree', () => {
    describe('When verifyStoredObject is called', () => {
      it('Then it resolves with no acceptance scan (git never parses a tree)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'verify-tree', [
          { kind: 'base', type: 'tree', content: ENC.encode('not really a tree body') },
        ]);
        const id = ids[0] as ObjectId;

        // Act
        const result = await verifyStoredObject(ctx, id);

        // Assert
        expect(result.type).toBe('tree');
        expect(result.acceptance).toBeUndefined();
      });
    });
  });

  describe('Given the virtual empty tree', () => {
    describe('When verifyStoredObject is called', () => {
      it('Then it resolves type tree with no acceptance scan, after the store gate and without a store read', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const registry = await getPackRegistry(ctx);
        const gate = vi.spyOn(registry, 'assertLoadable');
        const lookup = vi.spyOn(registry, 'lookup');
        const read = vi.spyOn(ctx.fs, 'read');
        const readdir = vi.spyOn(ctx.fs, 'readdir');
        const fanoutDir = `${ctx.layout.gitDir}/objects/${EMPTY_TREE_OID.slice(0, 2)}`;

        // Act
        const result = await verifyStoredObject(ctx, EMPTY_TREE_OID);

        // Assert
        expect(result.type).toBe('tree');
        expect(result.acceptance).toBeUndefined();
        expect(gate).toHaveBeenCalledTimes(1);
        expect(lookup).not.toHaveBeenCalled();
        const looseProbes = [...read.mock.calls, ...readdir.mock.calls]
          .map(([path]) => path)
          .filter((path) => path.startsWith(fanoutDir));
        expect(looseProbes).toEqual([]);
      });
    });
  });

  describe('Given the virtual empty tree and a store gate that refuses', () => {
    describe('When verifyStoredObject is called', () => {
      it('Then the gate refusal surfaces instead of the virtual tree', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const registry = await getPackRegistry(ctx);
        const refusal = new TsgitError({ code: 'PERMISSION_DENIED', path: 'store gate' });
        vi.spyOn(registry, 'assertLoadable').mockRejectedValue(refusal);

        // Act
        let caught: unknown;
        try {
          await verifyStoredObject(ctx, EMPTY_TREE_OID);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBe(refusal);
      });
    });
  });

  describe('Given a packed base commit', () => {
    describe('When verifyStoredObject is called', () => {
      it('Then its acceptance scan accepts the commit', async () => {
        // Arrange
        const content = ENC.encode(`tree ${ZERO_ID}\n\nmsg\n`);
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'verify-packed-commit', [
          { kind: 'base', type: 'commit', content },
        ]);
        const id = ids[0] as ObjectId;

        // Act
        const result = await verifyStoredObject(ctx, id);

        // Assert
        expect(result.type).toBe('commit');
        expect(checkedVerdict(result)).toBeUndefined();
      });
    });
  });

  describe('Given a packed delta blob', () => {
    describe('When verifyStoredObject is called', () => {
      it('Then it resolves with no acceptance scan', async () => {
        // Arrange
        const baseContent = ENC.encode('base blob content');
        const targetContent = ENC.encode('base blob content, delta-modified');
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'verify-packed-delta', [
          { kind: 'base', type: 'blob', content: baseContent },
          { kind: 'ofs-delta', baseIndex: 0, targetContent },
        ]);
        const id = ids[1] as ObjectId;

        // Act
        const result = await verifyStoredObject(ctx, id);

        // Assert
        expect(result.type).toBe('blob');
        expect(result.acceptance).toBeUndefined();
      });
    });
  });

  describe('Given an id absent from every storage form', () => {
    describe('When verifyStoredObject is called', () => {
      it('Then it refuses OBJECT_NOT_FOUND', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const missing = 'f'.repeat(40) as ObjectId;

        // Act + Assert
        try {
          await verifyStoredObject(ctx, missing);
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_NOT_FOUND');
          if (data.code === 'OBJECT_NOT_FOUND') expect(data.id).toBe(missing);
        }
      });
    });
  });

  describe('Given a missing object and a promisor that supplies it', () => {
    describe('When verifyStoredObject is called', () => {
      it('Then it is lazy-fetched exactly once and then verified', async () => {
        // Arrange
        const base = await buildSeededContext();
        const blob: Blob = { type: 'blob', content: ENC.encode('fetched'), id: '' as ObjectId };
        const id = (await base.hash.hashHex(serializeObject(blob, base.hashConfig))) as ObjectId;
        const calls = { count: 0 };
        let ctx!: Context;
        ctx = {
          ...base,
          promisor: {
            fetch: async (oids) => {
              calls.count += 1;
              await writeObject(ctx, blob);
              return { attempted: true, requested: oids.length, fetched: oids.length };
            },
          },
        };

        // Act
        const result = await verifyStoredObject(ctx, id);

        // Assert
        expect(result.type).toBe('blob');
        expect(calls.count).toBe(1);
      });
    });
  });
});
