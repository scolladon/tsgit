/**
 * Property tests for enumerateObjects — lens 1 (round-trip pair):
 * every written oid is returned by enumerateObjects exactly once.
 */
import fc from 'fast-check';
import { describe, it } from 'vitest';
import { enumerateObjects } from '../../../../src/application/primitives/enumerate-objects.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { GitObject, ObjectId } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

const sut = enumerateObjects;

/** Generate a blob whose content is an arbitrary non-empty byte sequence. */
const arbBlob = (): fc.Arbitrary<GitObject> =>
  fc
    .uint8Array({ minLength: 1, maxLength: 64 })
    .map((bytes): GitObject => ({ type: 'blob', id: '' as ObjectId, content: bytes }));

/**
 * Generate a set of 1–8 distinct blobs.
 * fast-check de-duplicates by content so the count is approximate.
 */
const arbBlobSet = (): fc.Arbitrary<ReadonlyArray<GitObject>> =>
  fc.uniqueArray(arbBlob(), {
    minLength: 1,
    maxLength: 8,
    selector: (obj) => new TextDecoder().decode((obj as { content: Uint8Array }).content),
  });

describe('Given an arbitrary set of blob objects', () => {
  describe('When writing them and calling enumerateObjects', () => {
    it('Then every written oid is enumerated exactly once (loose ∪ packed)', async () => {
      // Arrange + Act + Assert
      await fc.assert(
        fc.asyncProperty(arbBlobSet(), async (blobs) => {
          const ctx = await buildSeededContext();

          // Write all blobs and collect their oids
          const writtenIds = await Promise.all(blobs.map((obj) => writeObject(ctx, obj)));
          const uniqueWrittenIds = new Set(writtenIds);

          const result = await sut(ctx);
          const resultSet = new Set(result);

          // Every written oid appears in the result
          for (const id of uniqueWrittenIds) {
            if (!resultSet.has(id)) return false;
          }

          // No duplicates in result
          if (result.length !== resultSet.size) return false;

          // Result is sorted
          const sorted = [...result].sort();
          for (let i = 0; i < result.length; i++) {
            if (result[i] !== sorted[i]) return false;
          }

          return true;
        }),
        { numRuns: 200 },
      );
    });

    it('Then with includePacks false, all loose oids are enumerated exactly once', async () => {
      // Arrange + Act + Assert
      await fc.assert(
        fc.asyncProperty(arbBlobSet(), async (blobs) => {
          const ctx = await buildSeededContext();

          const writtenIds = await Promise.all(blobs.map((obj) => writeObject(ctx, obj)));
          const uniqueWrittenIds = new Set(writtenIds);

          const result = await sut(ctx, { includePacks: false });
          const resultSet = new Set(result);

          // Every written loose oid appears exactly once
          for (const id of uniqueWrittenIds) {
            if (!resultSet.has(id)) return false;
          }

          // No duplicates
          if (result.length !== resultSet.size) return false;

          return true;
        }),
        { numRuns: 200 },
      );
    });
  });
});
