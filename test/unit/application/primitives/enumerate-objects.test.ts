import { describe, expect, it } from 'vitest';
import { enumerateObjects } from '../../../../src/application/primitives/enumerate-objects.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { GitObject, ObjectId } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';
import { restampPackHeader, writeSyntheticPack } from './pack-fixture.js';

const blob = (content: string): GitObject => ({
  type: 'blob',
  id: '' as ObjectId,
  content: new TextEncoder().encode(content),
});

describe('enumerateObjects', () => {
  describe('Given repo with no objects', () => {
    describe('When enumerateObjects runs', () => {
      it('Then returns empty array', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act
        const result = await enumerateObjects(ctx);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given repo with no objects and includePacks false', () => {
    describe('When enumerateObjects runs', () => {
      it('Then returns empty array', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act
        const result = await enumerateObjects(ctx, { includePacks: false });

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given repo with N loose objects', () => {
    describe('When enumerateObjects runs', () => {
      it('Then each loose oid appears exactly once', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const idA = await writeObject(ctx, blob('aaa'));
        const idB = await writeObject(ctx, blob('bbb'));
        const idC = await writeObject(ctx, blob('ccc'));
        const expectedIds = [idA, idB, idC].sort();

        // Act
        const result = await enumerateObjects(ctx);

        // Assert
        expect([...result].sort()).toEqual(expectedIds);
        expect(new Set(result).size).toBe(result.length);
      });
    });
  });

  describe('Given repo with a single loose object', () => {
    describe('When enumerateObjects runs with includePacks false', () => {
      it('Then returns the loose oid', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeObject(ctx, blob('hello'));

        // Act
        const result = await enumerateObjects(ctx, { includePacks: false });

        // Assert
        expect(result).toContain(id);
      });
    });
  });

  describe('Given repo with the same object written twice', () => {
    describe('When enumerateObjects runs', () => {
      it('Then the oid appears exactly once', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeObject(ctx, blob('same'));
        await writeObject(ctx, blob('same'));

        // Act
        const result = await enumerateObjects(ctx);

        // Assert
        expect(result.filter((oid) => oid === id)).toHaveLength(1);
      });
    });
  });

  describe('Given repo with loose objects', () => {
    describe('When enumerateObjects runs', () => {
      it('Then result is sorted ascending', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeObject(ctx, blob('aaa'));
        await writeObject(ctx, blob('bbb'));
        await writeObject(ctx, blob('ccc'));

        // Act
        const result = await enumerateObjects(ctx);

        // Assert
        const sorted = [...result].sort();
        expect(result).toEqual(sorted);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Kill id 414: enumerate-objects.ts line 34 ConditionalExpression
  // entry.isFile → true
  // A subdirectory inside an objects prefix dir has isFile === false.
  // The mutant treats ALL entries as files, so a directory named 'subdir'
  // inside objects/ab/ would be added as OID 'ab' + 'subdir' (garbage).
  // This test verifies only real file OIDs appear in the result.
  // -------------------------------------------------------------------------

  describe('Given repo with a loose object and a subdirectory in the same prefix dir', () => {
    describe('When enumerateObjects runs', () => {
      it('Then only the actual object OID is returned (directory entry is excluded)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeObject(ctx, blob('real-object'));
        // The OID prefix is blobId.slice(0,2); create a subdirectory inside that prefix dir
        const prefix = blobId.slice(0, 2);
        const prefixDir = `${ctx.layout.gitDir}/objects/${prefix}`;
        await ctx.fs.mkdir(`${prefixDir}/subdir`);

        // Act
        const result = await enumerateObjects(ctx);

        // Assert — only the real blob OID; prefix+dirname garbage must not appear
        expect(result).toContain(blobId);
        expect(result.every((id) => id.length === 40)).toBe(true);
        expect(result).not.toContain(`${prefix}subdir`);
      });
    });
  });

  describe('Given repo with a loose object and a tmp_obj_ quarantine litter file in the same prefix dir', () => {
    describe('When enumerateObjects runs', () => {
      it('Then the litter file never becomes a phantom oid', async () => {
        // Arrange — `objects/<prefix>/tmp_obj_XXXXXX` is git's own quarantine
        // naming for a loose-object write that never completed; its filename
        // is neither hex nor the right width, so it is not an oid suffix.
        const ctx = await buildSeededContext();
        const blobId = await writeObject(ctx, blob('real-object'));
        const prefix = blobId.slice(0, 2);
        const prefixDir = `${ctx.layout.gitDir}/objects/${prefix}`;
        await ctx.fs.write(`${prefixDir}/tmp_obj_XXXXXX`, new Uint8Array(0));

        // Act
        const result = await enumerateObjects(ctx);

        // Assert
        expect(result).toContain(blobId);
        expect(result).not.toContain(`${prefix}tmp_obj_XXXXXX`);
        expect(result.every((id) => id.length === 40)).toBe(true);
      });
    });
  });

  describe('Given a repo holding one healthy pack, one header-refused pack and one loose object', () => {
    describe('When enumerateObjects runs with default options', () => {
      it('Then the ids include the refused pack ids', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeObject(ctx, blob('loose-content'));
        await writeSyntheticPack(ctx, 'healthy', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('healthy-content') },
        ]);
        const refusedIds = await writeSyntheticPack(ctx, 'refused', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('refused-content') },
        ]);
        const refusedPackPath = `${ctx.layout.gitDir}/objects/pack/pack-refused.pack`;
        await restampPackHeader(ctx, refusedPackPath, { version: 99 });

        // Act
        const result = await enumerateObjects(ctx);

        // Assert
        expect(result).toContain(refusedIds[0] as ObjectId);
      });
    });

    describe('When enumerateObjects runs with accessiblePacksOnly: true', () => {
      it('Then the refused pack ids are absent and the healthy pack and loose ids are present', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const looseId = await writeObject(ctx, blob('loose-content'));
        const healthyIds = await writeSyntheticPack(ctx, 'healthy', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('healthy-content') },
        ]);
        const refusedIds = await writeSyntheticPack(ctx, 'refused', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('refused-content') },
        ]);
        const refusedPackPath = `${ctx.layout.gitDir}/objects/pack/pack-refused.pack`;
        await restampPackHeader(ctx, refusedPackPath, { version: 99 });

        // Act
        const result = await enumerateObjects(ctx, { accessiblePacksOnly: true });

        // Assert
        expect(result).not.toContain(refusedIds[0] as ObjectId);
        expect(result).toContain(healthyIds[0] as ObjectId);
        expect(result).toContain(looseId);
      });
    });

    describe('When enumerateObjects runs with includePacks: false and accessiblePacksOnly: true', () => {
      it('Then the result equals the loose ids alone', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const looseId = await writeObject(ctx, blob('loose-content'));
        await writeSyntheticPack(ctx, 'healthy', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('healthy-content') },
        ]);
        await writeSyntheticPack(ctx, 'refused', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('refused-content') },
        ]);
        const refusedPackPath = `${ctx.layout.gitDir}/objects/pack/pack-refused.pack`;
        await restampPackHeader(ctx, refusedPackPath, { version: 99 });

        // Act
        const result = await enumerateObjects(ctx, {
          includePacks: false,
          accessiblePacksOnly: true,
        });

        // Assert
        expect(result).toEqual([looseId]);
      });
    });
  });

  describe('Given an oid present both loose and in the header-refused pack', () => {
    describe('When enumerateObjects runs with accessiblePacksOnly: true', () => {
      it('Then that oid is still enumerated', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sharedContent = 'shared-content';
        const looseId = await writeObject(ctx, blob(sharedContent));
        await writeSyntheticPack(ctx, 'refused', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode(sharedContent) },
        ]);
        const refusedPackPath = `${ctx.layout.gitDir}/objects/pack/pack-refused.pack`;
        await restampPackHeader(ctx, refusedPackPath, { version: 99 });

        // Act
        const result = await enumerateObjects(ctx, { accessiblePacksOnly: true });

        // Assert
        expect(result).toContain(looseId);
      });
    });
  });
});
