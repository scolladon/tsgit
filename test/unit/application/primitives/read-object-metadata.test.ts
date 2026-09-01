import { describe, expect, it, vi } from 'vitest';
import { readObjectMetadata } from '../../../../src/application/primitives/read-object.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type {
  Blob,
  Commit,
  GitObject,
  ObjectId,
  Tag,
  Tree,
} from '../../../../src/domain/objects/index.js';
import { parseHeader, serializeObject } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from './fixtures.js';
import type { EntrySpec } from './pack-fixture.js';
import { buildSyntheticPack, corruptIdxOffset, writeSyntheticPack } from './pack-fixture.js';

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
