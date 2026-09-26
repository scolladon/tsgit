import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  isSizeRejected,
  sizeCompatibleIds,
} from '../../../../src/application/primitives/detect-similarity-renames.js';
import { MAX_SCORE } from '../../../../src/domain/diff/similarity.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';

const MAX_POOL_SIZE = 8;
const MAX_BLOB_BYTES = 4096;

const arbSizes = (): fc.Arbitrary<ReadonlyArray<number>> =>
  fc.array(fc.integer({ min: 0, max: MAX_BLOB_BYTES }), { minLength: 0, maxLength: MAX_POOL_SIZE });

const arbThreshold = (): fc.Arbitrary<number> => fc.integer({ min: 0, max: MAX_SCORE });

const idsFor = (prefix: string, sizes: ReadonlyArray<number>): ReadonlyArray<ObjectId> =>
  sizes.map((_, i) => `${prefix}-${i}` as ObjectId);

/**
 * Independent oracle: the O(S·D) brute-force scan the design doc names —
 * never the binary search `sizeCompatibleIds` itself uses — so a shared bug
 * between the two can't hide behind agreement.
 */
const bruteForceCompatible = (
  ids: ReadonlyArray<ObjectId>,
  partners: ReadonlyArray<ObjectId>,
  sizes: ReadonlyMap<ObjectId, number>,
  threshold: number,
): ReadonlySet<ObjectId> =>
  new Set(
    ids.filter((id) =>
      partners.some(
        (p) => !isSizeRejected(sizes.get(id) as number, sizes.get(p) as number, threshold),
      ),
    ),
  );

describe('sizeCompatibleIds', () => {
  describe('Given arbitrary src/dst size pools and an arbitrary threshold', () => {
    describe('When sizeCompatibleIds is called', () => {
      it('Then it returns exactly the ids with at least one size-compatible partner on the other side', () => {
        fc.assert(
          fc.property(arbSizes(), arbSizes(), arbThreshold(), (srcSizes, dstSizes, threshold) => {
            // Arrange
            const srcIds = idsFor('src', srcSizes);
            const dstIds = idsFor('dst', dstSizes);
            const sizes = new Map<ObjectId, number>();
            srcIds.forEach((id, i) => {
              sizes.set(id, srcSizes[i] as number);
            });
            dstIds.forEach((id, i) => {
              sizes.set(id, dstSizes[i] as number);
            });

            // Act
            const result = sizeCompatibleIds(sizes, srcIds, dstIds, threshold);

            // Assert
            const expectedSrc = bruteForceCompatible(srcIds, dstIds, sizes, threshold);
            const expectedDst = bruteForceCompatible(dstIds, srcIds, sizes, threshold);
            const expected = new Set([...expectedSrc, ...expectedDst]);
            expect(result).toEqual(expected);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
