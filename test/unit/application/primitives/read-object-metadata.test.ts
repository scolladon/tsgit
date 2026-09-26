import { deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  getPackRegistry,
  readDeclaredObjectSize,
  readObjectMetadata,
} from '../../../../src/application/primitives/read-object.js';
import { notADirectory, TsgitError } from '../../../../src/domain/error.js';
import type {
  Blob,
  Commit,
  GitObject,
  ObjectId,
  Tag,
  Tree,
} from '../../../../src/domain/objects/index.js';
import {
  parseHeader,
  serializeHeader,
  serializeObject,
} from '../../../../src/domain/objects/index.js';
import { computeLooseObjectPath } from '../../../../src/domain/storage/loose-path.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext, writeLooseWithDeclaredSize, writeRawObjectBytes } from './fixtures.js';
import type { EntrySpec } from './pack-fixture.js';
import { buildSyntheticPack, corruptIdxOffset, writeSyntheticPack } from './pack-fixture.js';

/** git's zlib stored-block encoding of an empty block: BFINAL=0, BTYPE=00
 *  (stored), byte-aligned; LEN=0x0000 then its one's-complement NLEN=0xFFFF.
 *  Emits zero output bytes, so a run of these exhausts the size-probe's
 *  compressed-byte budget before the header's own NUL ever appears. */
const EMPTY_STORED_DEFLATE_BLOCK = new Uint8Array([0x00, 0x00, 0x00, 0xff, 0xff]);

/** Enough empty stored blocks (5 bytes each) to outlast the 1024-byte probe
 *  window on their own, before the real payload ever starts. */
const PREFIX_EXHAUSTING_BLOCK_COUNT = 300;

/** zlib (RFC1950) wraps a raw DEFLATE stream with a 2-byte header and a
 *  trailing big-endian Adler-32 of the UNCOMPRESSED bytes. */
const ZLIB_HEADER = new Uint8Array([0x78, 0x01]);

function adler32(data: Uint8Array): number {
  const MOD_ADLER = 65521;
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % MOD_ADLER;
    b = (b + a) % MOD_ADLER;
  }
  return ((b << 16) | a) >>> 0;
}

/** Hand-builds a valid zlib stream whose first 1024 compressed bytes decode
 *  to zero output — a run of empty stored blocks precedes the real payload
 *  — so the size-probe's prefix read can never find the header's NUL and
 *  must fall back to a whole-file inflate. */
function buildPrefixExhaustingLooseBytes(serialized: Uint8Array): Uint8Array {
  const emptyBlocks = new Uint8Array(
    EMPTY_STORED_DEFLATE_BLOCK.length * PREFIX_EXHAUSTING_BLOCK_COUNT,
  );
  for (let i = 0; i < PREFIX_EXHAUSTING_BLOCK_COUNT; i += 1) {
    emptyBlocks.set(EMPTY_STORED_DEFLATE_BLOCK, i * EMPTY_STORED_DEFLATE_BLOCK.length);
  }
  const payload = deflateRawSync(serialized);
  const trailer = new Uint8Array(4);
  new DataView(trailer.buffer).setUint32(0, adler32(serialized), false);
  return new Uint8Array([...ZLIB_HEADER, ...emptyBlocks, ...payload, ...trailer]);
}

const loosePathOf = (ctx: Context, id: ObjectId): string =>
  `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`;

const AUTHOR = { name: 'A', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' };
const ENC = new TextEncoder();

/** Independent oracle for a loose object's content length — derived from the
 *  real header parser, never from `readObjectMetadata` itself. */
function looseContentSize(ctx: Context, object: GitObject): number {
  const bytes = serializeObject(object, ctx.hashConfig);
  const { contentOffset } = parseHeader(bytes);
  return bytes.length - contentOffset;
}

describe('readObjectMetadata', () => {
  describe('Given loose objects of each domain type', () => {
    describe('When readObjectMetadata is called', () => {
      it.each([
        {
          label: 'blob',
          build: (): Blob => ({
            type: 'blob',
            content: new Uint8Array([1, 2, 3]),
            id: '' as ObjectId,
          }),
        },
        {
          label: 'tree',
          build: (): Tree => ({ type: 'tree', entries: [], id: '' as ObjectId }),
        },
        {
          label: 'commit',
          build: (): Commit => ({
            type: 'commit',
            id: '' as ObjectId,
            data: {
              tree: '0'.repeat(40) as ObjectId,
              parents: [],
              author: AUTHOR,
              committer: AUTHOR,
              message: 'first',
              extraHeaders: [],
            },
          }),
        },
        {
          label: 'tag',
          build: (): Tag => ({
            type: 'tag',
            id: '' as ObjectId,
            data: {
              object: '0'.repeat(40) as ObjectId,
              objectType: 'blob',
              tagName: 'v1',
              tagger: AUTHOR,
              message: 'tagged\n',
              extraHeaders: [],
            },
          }),
        },
      ])(
        'Then returns { type: $label, uncompressedSize } from the loose route',
        async ({ label, build }) => {
          // Arrange
          const object = build();
          const ctx = await buildSeededContext({ objects: [object] });
          const id = (await ctx.hash.hashHex(serializeObject(object, ctx.hashConfig))) as ObjectId;
          const expectedSize = looseContentSize(ctx, object);

          // Act
          const result = await readObjectMetadata(ctx, id);

          // Assert
          expect(result.type).toBe(label);
          expect(result.uncompressedSize).toBe(expectedSize);
        },
      );
    });
  });

  describe('Given a loose blob whose header size claim disagrees with its body length', () => {
    describe('When readObjectMetadata is called', () => {
      it('Then uncompressedSize is the real 12-byte body, never the stored claim', async () => {
        // Arrange
        const content = ENC.encode('hello world!'); // 12 bytes
        const ctx = await buildSeededContext();
        const id = await writeRawObjectBytes(ctx, 'blob', content);
        await writeLooseWithDeclaredSize(ctx, id, 'blob', 5, content);

        // Act
        const result = await readObjectMetadata(ctx, id);

        // Assert
        expect(result.type).toBe('blob');
        expect(result.uncompressedSize).toBe(12);
      });
    });
  });

  describe('Given a packed base entry', () => {
    describe('When readObjectMetadata is called', () => {
      it('Then returns its type and size without inflating', async () => {
        // Arrange
        const content = new TextEncoder().encode('abcdefgh');
        const ctx = await buildSeededContext();
        const [id] = await writeSyntheticPack(ctx, 'meta-base', [
          { kind: 'base', type: 'blob', content },
        ]);
        const inflateSpy = vi.spyOn(ctx.compressor, 'inflate');

        // Act
        const result = await readObjectMetadata(ctx, id as ObjectId);

        // Assert
        expect(result.type).toBe('blob');
        expect(result.uncompressedSize).toBe(content.length);
        expect(inflateSpy).not.toHaveBeenCalled();
        inflateSpy.mockRestore();
      });
    });
  });

  describe('Given a packed base entry whose idx successor offset was corrupted past the pack file size', () => {
    describe('When readObjectMetadata is called', () => {
      it('Then throws INVALID_PACK_INDEX with the next-offset-exceeds reason', async () => {
        // Arrange — two base entries; the SECOND entry's recorded offset in
        // the real on-disk `.idx` small-offsets table is overwritten with a
        // value far past the pack's actual size. `nextOffsetForEntry` finds
        // it as the FIRST entry's successor (by numeric value, not idx row
        // order), so a metadata read of the first entry must refuse rather
        // than pass the bogus successor into readSlice — the exact gap a
        // fetched or cloned pack's attacker-controlled `.idx` can carry,
        // since `readOffset` bounds an offset's own encoding but never the
        // pack's real size.
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
        const base = `${ctx.layout.gitDir}/objects/pack/pack-meta-corrupt-bounds`;
        await ctx.fs.write(`${base}.pack`, built.packBytes);
        await ctx.fs.write(`${base}.idx`, idxBytes);
        const targetId = built.ids[0] as ObjectId;

        // Act
        try {
          await readObjectMetadata(ctx, targetId);
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

  describe('Given a packed OFS_DELTA entry', () => {
    describe('When readObjectMetadata is called', () => {
      it('Then returns the target size and the base type, walked back through headers only', async () => {
        // Arrange
        const baseContent = new TextEncoder().encode('abcd');
        const targetContent = new TextEncoder().encode('abcdefgh');
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'meta-ofs', [
          { kind: 'base', type: 'blob', content: baseContent },
          { kind: 'ofs-delta', baseIndex: 0, targetContent },
        ]);
        const deltaId = ids[1] as ObjectId;

        // Act
        const result = await readObjectMetadata(ctx, deltaId);

        // Assert
        expect(result.type).toBe('blob');
        expect(result.uncompressedSize).toBe(targetContent.length);
      });
    });
  });

  describe('Given a packed REF_DELTA entry', () => {
    describe('When readObjectMetadata is called', () => {
      it('Then returns the target size and the base type', async () => {
        // Arrange
        const baseContent = new TextEncoder().encode('ref base');
        const targetContent = new TextEncoder().encode('ref target — different bytes');
        const ctx = await buildSeededContext();
        const baseIds = await writeSyntheticPack(ctx, 'meta-ref-base', [
          { kind: 'base', type: 'blob', content: baseContent },
        ]);
        const baseId = baseIds[0] as string;
        const deltaIds = await writeSyntheticPack(ctx, 'meta-ref-delta', [
          { kind: 'ref-delta', baseId, baseUncompressed: baseContent, targetContent },
        ]);

        // Act
        const result = await readObjectMetadata(ctx, deltaIds[0] as ObjectId);

        // Assert
        expect(result.type).toBe('blob');
        expect(result.uncompressedSize).toBe(targetContent.length);
      });
    });
  });

  describe('Given a packed REF_DELTA entry whose base id is claimed by no pack', () => {
    describe('When readObjectMetadata is called', () => {
      it('Then throws OBJECT_NOT_FOUND for the missing base id', async () => {
        // Arrange — a corrupt/incomplete pack: the REF_DELTA's declared base
        // was never written anywhere, so the header-only type walk cannot
        // find it. This must fail loud, not degrade silently.
        const missingBaseId = 'b'.repeat(40);
        const targetContent = new TextEncoder().encode('orphan target');
        const ctx = await buildSeededContext();
        const deltaIds = await writeSyntheticPack(ctx, 'meta-ref-orphan', [
          {
            kind: 'ref-delta',
            baseId: missingBaseId,
            baseUncompressed: new TextEncoder().encode('x'),
            targetContent,
          },
        ]);

        // Act
        try {
          await readObjectMetadata(ctx, deltaIds[0] as ObjectId);
          expect.unreachable();
        } catch (error) {
          // Assert
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_NOT_FOUND');
          if (data.code === 'OBJECT_NOT_FOUND') {
            expect(data.id).toBe(missingBaseId);
          }
        }
      });
    });
  });

  describe('Given a packed REF_DELTA entry whose base was written to a new pack only after the registry already scanned', () => {
    describe('When readObjectMetadata is called', () => {
      it('Then throws OBJECT_NOT_FOUND for the base id — the metadata walk never re-scans, matching packed_to_object_type', async () => {
        // Arrange — git's header-only type walk (`packed_to_object_type`)
        // resolves a REF_DELTA base via a same-pack lookup (git's
        // `get_delta_base` / `find_pack_entry_one`), never `reprepare_packed_git`;
        // only the CONTENT-resolving path (`oid_object_info_extended`)
        // retries after a re-scan. A base that only lands on disk after the
        // scan is therefore a genuine miss here, exactly like the "claimed
        // by no pack" row above.
        const baseContent = new TextEncoder().encode('ref base, late pack');
        const targetContent = new TextEncoder().encode('ref target, late base — different bytes');
        const ctx = await buildSeededContext();
        const basePack = await buildSyntheticPack(ctx, [
          { kind: 'base', type: 'blob', content: baseContent },
        ]);
        const baseId = basePack.ids[0] as string;
        const deltaIds = await writeSyntheticPack(ctx, 'meta-ref-late-base-delta', [
          { kind: 'ref-delta', baseId, baseUncompressed: baseContent, targetContent },
        ]);
        const registry = await getPackRegistry(ctx);
        await registry.lookup(deltaIds[0] as ObjectId); // scans while the base's pack is absent

        const base = `${ctx.layout.gitDir}/objects/pack/pack-meta-ref-late-base`;
        await ctx.fs.write(`${base}.pack`, basePack.packBytes);
        await ctx.fs.write(`${base}.idx`, basePack.idxBytes);

        // Act
        try {
          await readObjectMetadata(ctx, deltaIds[0] as ObjectId);
          expect.unreachable();
        } catch (error) {
          // Assert
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_NOT_FOUND');
          if (data.code === 'OBJECT_NOT_FOUND') {
            expect(data.id).toBe(baseId);
          }
        }
      });
    });
  });

  describe('Given an OFS_DELTA chain of length 51', () => {
    describe('When readObjectMetadata is called on the tip', () => {
      it('Then throws DELTA_CHAIN_TOO_DEEP with the accumulated depth', async () => {
        // Arrange — base + 51 chained OFS deltas, each reconstructing unique
        // bytes so every entry has a distinct id (avoids pack-lookup collisions).
        const ctx = await buildSeededContext();
        const baseContent = new TextEncoder().encode('base');
        const entries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: baseContent }];
        for (let i = 0; i < 51; i += 1) {
          const target = new TextEncoder().encode(`target-${i}`);
          entries.push({ kind: 'ofs-delta', baseIndex: i, targetContent: target });
        }
        const ids = await writeSyntheticPack(ctx, 'meta-long-chain', entries);
        const tipId = ids[ids.length - 1] as ObjectId;

        // Act
        try {
          await readObjectMetadata(ctx, tipId);
          expect.unreachable();
        } catch (error) {
          // Assert
          const data = (error as TsgitError).data;
          expect(data.code).toBe('DELTA_CHAIN_TOO_DEEP');
          if (data.code === 'DELTA_CHAIN_TOO_DEEP') {
            expect(data.depth).toBe(51);
          }
        }
      });
    });
  });

  describe('Given an absent oid', () => {
    describe('When readObjectMetadata is called', () => {
      it('Then throws OBJECT_NOT_FOUND', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act
        try {
          await readObjectMetadata(ctx, 'f'.repeat(40) as ObjectId);
          expect.unreachable();
        } catch (error) {
          // Assert
          expect((error as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
        }
      });
    });
  });
});

describe('readDeclaredObjectSize', () => {
  describe('Given a 64 KiB loose blob', () => {
    describe('When readDeclaredObjectSize is called', () => {
      it('Then returns 65536, reading only through readSlice', async () => {
        // Arrange
        const content = new Uint8Array(65536).fill(7);
        const ctx = await buildSeededContext();
        const id = await writeRawObjectBytes(ctx, 'blob', content);
        // Warm the repo-settings verdict first so the spies below observe
        // only the size read's own filesystem traffic, not the one-time
        // config check every fresh Context pays on its first pack-registry use.
        await getPackRegistry(ctx);
        const readSliceSpy = vi.spyOn(ctx.fs, 'readSlice');
        const readSpy = vi.spyOn(ctx.fs, 'read');

        // Act
        const result = await readDeclaredObjectSize(ctx, id);

        // Assert
        expect(result).toBe(65536);
        expect(readSliceSpy).toHaveBeenCalled();
        expect(readSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a size-lying loose blob', () => {
    describe('When readDeclaredObjectSize is called', () => {
      it('Then returns the header claim, while readObjectMetadata keeps returning the real length', async () => {
        // Arrange
        const content = ENC.encode('hello world!'); // 12 bytes
        const ctx = await buildSeededContext();
        const id = await writeRawObjectBytes(ctx, 'blob', content);
        await writeLooseWithDeclaredSize(ctx, id, 'blob', 5, content);

        // Act
        const declaredSize = await readDeclaredObjectSize(ctx, id);
        const metadata = await readObjectMetadata(ctx, id);

        // Assert
        expect(declaredSize).toBe(5);
        expect(metadata.uncompressedSize).toBe(12);
      });
    });
  });

  describe('Given a loose object whose header decodes only after more than 1024 compressed bytes', () => {
    describe('When readDeclaredObjectSize is called', () => {
      it('Then returns the true size through the whole-file fallback', async () => {
        // Arrange — a run of empty stored deflate blocks pushes the real
        // payload past the 1024-byte probe window (verified against the
        // memory adapter's own DecompressionStream: the full stream inflates
        // to the serialized object, the truncated 1024-byte prefix alone
        // rejects with zero output).
        const content = ENC.encode('hello');
        const header = serializeHeader('blob', content.length);
        const serialized = new Uint8Array(header.length + content.length);
        serialized.set(header, 0);
        serialized.set(content, header.length);
        const ctx = await buildSeededContext();
        const id = 'b'.repeat(40) as ObjectId;
        await ctx.fs.write(loosePathOf(ctx, id), buildPrefixExhaustingLooseBytes(serialized));

        // Act
        const result = await readDeclaredObjectSize(ctx, id);

        // Assert
        expect(result).toBe(content.length);
      });
    });
  });

  describe('Given a whole-file fallback whose real payload decodes to more than 32 bytes with no NUL', () => {
    describe('When readDeclaredObjectSize is called', () => {
      it('Then rejects header-too-long through the SAME capped scan, never a whole-buffer inflate', async () => {
        // Arrange — the same empty-stored-block run pushes the payload past the
        // 1024-byte probe window, forcing the whole-file fallback; the payload
        // itself is large and has no NUL anywhere, mirroring a compressed loose
        // object that would inflate to hundreds of megabytes. The fallback must
        // apply the SAME 32-byte header cap via the streaming inflate, never
        // ctx.compressor.inflate's uncapped whole-buffer route.
        const junk = new Uint8Array(100_000);
        let state = 7;
        for (let i = 0; i < junk.length; i++) {
          state = (state * 1103515245 + 12345) & 0x7fffffff;
          junk[i] = (state % 255) + 1; // never 0x00
        }
        const ctx = await buildSeededContext();
        const id = 'c'.repeat(40) as ObjectId;
        await ctx.fs.write(loosePathOf(ctx, id), buildPrefixExhaustingLooseBytes(junk));
        const inflateSpy = vi.spyOn(ctx.compressor, 'inflate');

        // Act
        try {
          await readDeclaredObjectSize(ctx, id);
          expect.unreachable();
        } catch (error) {
          // Assert
          const data = (error as TsgitError).data;
          expect(data.code).toBe('INVALID_OBJECT_HEADER');
          if (data.code === 'INVALID_OBJECT_HEADER') {
            expect(data.reason).toBe(`header for ${id} too long, exceeds 32 bytes`);
          }
        }
        expect(inflateSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a loose file whose entire content has no NUL and decodes to more than 32 bytes', () => {
    describe('When readDeclaredObjectSize is called', () => {
      it('Then rejects INVALID_OBJECT_HEADER with the header-too-long reason, like git', async () => {
        // Arrange — the whole file fits inside the 1024-byte probe, but the
        // decoded header alone (49 bytes, no NUL) already exceeds git's own
        // 32-byte header buffer — refused before any fallback is even considered.
        const ctx = await buildSeededContext();
        const junk = ENC.encode('no header here, just plain text with no null byte');
        const compressed = await ctx.compressor.deflate(junk);
        const id = 'a'.repeat(40) as ObjectId;
        await ctx.fs.write(loosePathOf(ctx, id), compressed);

        // Act
        try {
          await readDeclaredObjectSize(ctx, id);
          expect.unreachable();
        } catch (error) {
          // Assert
          const data = (error as TsgitError).data;
          expect(data.code).toBe('INVALID_OBJECT_HEADER');
          if (data.code === 'INVALID_OBJECT_HEADER') {
            expect(data.reason).toBe(`header for ${id} too long, exceeds 32 bytes`);
          }
        }
      });
    });
  });

  describe('Given a loose file whose entire content has no NUL but stays at or under 32 bytes', () => {
    describe('When readDeclaredObjectSize is called', () => {
      it('Then rejects INVALID_OBJECT_HEADER with the no-NUL-terminator reason', async () => {
        // Arrange — the whole file fits inside the 1024-byte probe and never
        // reaches the 32-byte header cap, so the "never catch" branch applies:
        // no fallback, the plain no-NUL error propagates as-is.
        const ctx = await buildSeededContext();
        const junk = ENC.encode('short, no null byte here');
        const compressed = await ctx.compressor.deflate(junk);
        const id = 'd'.repeat(40) as ObjectId;
        await ctx.fs.write(loosePathOf(ctx, id), compressed);

        // Act
        try {
          await readDeclaredObjectSize(ctx, id);
          expect.unreachable();
        } catch (error) {
          // Assert
          const data = (error as TsgitError).data;
          expect(data.code).toBe('INVALID_OBJECT_HEADER');
          if (data.code === 'INVALID_OBJECT_HEADER') {
            expect(data.reason).toBe(`no NUL terminator found in inflated object ${id}`);
          }
        }
      });
    });
  });

  describe('Given a large loose file whose header decodes to more than 32 bytes with no NUL', () => {
    describe('When readDeclaredObjectSize is called', () => {
      it('Then rejects immediately and never falls back to a whole-file read', async () => {
        // Arrange — deterministic, poorly-compressible bytes (never 0x00) push the
        // compressed size past the 1024-byte probe window, mirroring a hostile
        // large loose object whose header never terminates: the fix must refuse
        // as soon as the decoded header passes 32 bytes, never re-reading the
        // whole (here, ~2 KiB; in the wild, hundreds of MiB) file looking for a
        // NUL that will never appear.
        const ctx = await buildSeededContext();
        const junk = new Uint8Array(2000);
        let state = 1;
        for (let i = 0; i < junk.length; i++) {
          state = (state * 1103515245 + 12345) & 0x7fffffff;
          junk[i] = (state % 255) + 1; // never 0x00
        }
        const compressed = await ctx.compressor.deflate(junk);
        expect(compressed.length).toBeGreaterThan(1024);
        const id = 'e'.repeat(40) as ObjectId;
        await ctx.fs.write(loosePathOf(ctx, id), compressed);
        // Warm the repo-settings verdict first so the spy below observes only
        // the size read's own filesystem traffic (see the 64 KiB blob test above).
        await getPackRegistry(ctx);
        const readSpy = vi.spyOn(ctx.fs, 'read');

        // Act
        try {
          await readDeclaredObjectSize(ctx, id);
          expect.unreachable();
        } catch (error) {
          // Assert
          const data = (error as TsgitError).data;
          expect(data.code).toBe('INVALID_OBJECT_HEADER');
          if (data.code === 'INVALID_OBJECT_HEADER') {
            expect(data.reason).toBe(`header for ${id} too long, exceeds 32 bytes`);
          }
        }
        expect(readSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a small loose file whose own compressed bytes are truncated mid-stream', () => {
    describe('When readDeclaredObjectSize is called', () => {
      it('Then the inflate fault propagates as-is — the whole file already IS the prefix', async () => {
        // Arrange — the prefix is shorter than the probe budget, so this is the
        // "never catch" branch even for a hard stream fault (not just a clean
        // no-NUL end): there is no more of the file left to re-read, so nothing
        // routes to the whole-file fallback.
        const ctx = await buildSeededContext();
        const header = serializeHeader('blob', 5);
        const serialized = new Uint8Array(header.length + 5);
        serialized.set(header, 0);
        serialized.set(ENC.encode('hello'), header.length);
        const compressed = await ctx.compressor.deflate(serialized);
        const truncated = compressed.subarray(0, 5);
        const id = 'f'.repeat(40) as ObjectId;
        await ctx.fs.write(loosePathOf(ctx, id), truncated);

        // Act
        const rejection = readDeclaredObjectSize(ctx, id);

        // Assert
        await expect(rejection).rejects.not.toBeInstanceOf(TsgitError);
      });
    });
  });

  describe('Given a packed base entry and an OFS_DELTA entry', () => {
    describe('When readDeclaredObjectSize is called', () => {
      it("Then equals readObjectMetadata's uncompressedSize for both", async () => {
        // Arrange
        const baseContent = new TextEncoder().encode('abcd');
        const targetContent = new TextEncoder().encode('abcdefgh');
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'declared-size-ofs', [
          { kind: 'base', type: 'blob', content: baseContent },
          { kind: 'ofs-delta', baseIndex: 0, targetContent },
        ]);
        const baseId = ids[0] as ObjectId;
        const deltaId = ids[1] as ObjectId;

        // Act
        const baseDeclaredSize = await readDeclaredObjectSize(ctx, baseId);
        const deltaDeclaredSize = await readDeclaredObjectSize(ctx, deltaId);

        // Assert
        expect(baseDeclaredSize).toBe((await readObjectMetadata(ctx, baseId)).uncompressedSize);
        expect(deltaDeclaredSize).toBe((await readObjectMetadata(ctx, deltaId)).uncompressedSize);
      });
    });
  });

  describe('Given an id neither loose nor packed', () => {
    describe('When readDeclaredObjectSize is called', () => {
      it('Then rejects OBJECT_NOT_FOUND with the id', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const missingId = 'f'.repeat(40) as ObjectId;

        // Act
        try {
          await readDeclaredObjectSize(ctx, missingId);
          expect.unreachable();
        } catch (error) {
          // Assert
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_NOT_FOUND');
          if (data.code === 'OBJECT_NOT_FOUND') {
            expect(data.id).toBe(missingId);
          }
        }
      });
    });
  });

  describe('Given a cached membership hit whose loose file was pruned before the size read', () => {
    describe('When readDeclaredObjectSize is called for the pruned id', () => {
      it('Then forgets the stale membership and rejects OBJECT_NOT_FOUND with the id', async () => {
        // Arrange — warm the fanout membership cache with a real HIT, then
        // remove the file underneath it (an external `git gc` prune) so the
        // next size read's readSlice meets a FILE_NOT_FOUND the membership
        // cache didn't see coming.
        const ctx = await buildSeededContext();
        const content = ENC.encode('pruned-before-size-read');
        const id = await writeRawObjectBytes(ctx, 'blob', content);
        await readDeclaredObjectSize(ctx, id);
        await ctx.fs.rm(loosePathOf(ctx, id));

        // Act
        try {
          await readDeclaredObjectSize(ctx, id);
          expect.unreachable();
        } catch (error) {
          // Assert
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_NOT_FOUND');
          if (data.code === 'OBJECT_NOT_FOUND') {
            expect(data.id).toBe(id);
          }
        }

        // Assert — the stale membership was forgotten: a fresh loose write
        // under the same id is found again rather than staying a phantom miss.
        await writeRawObjectBytes(ctx, 'blob', content);
        await expect(readDeclaredObjectSize(ctx, id)).resolves.toBe(content.length);
      });
    });
  });

  describe('Given the size read meets a non-FILE_NOT_FOUND error while probing a present loose id', () => {
    describe('When readDeclaredObjectSize is called', () => {
      it('Then the error propagates unchanged, never folded into OBJECT_NOT_FOUND', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = ENC.encode('a present loose object');
        const id = await writeRawObjectBytes(ctx, 'blob', content);
        const rejection = notADirectory(loosePathOf(ctx, id));
        vi.spyOn(ctx.fs, 'readSlice').mockRejectedValueOnce(rejection);

        // Act
        const caught = await readDeclaredObjectSize(ctx, id).catch((error: unknown) => error);

        // Assert
        expect(caught).toBe(rejection);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('NOT_A_DIRECTORY');
      });
    });
  });
});
