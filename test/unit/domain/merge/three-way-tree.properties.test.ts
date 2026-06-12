import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { uniquePath } from '../../../../src/domain/merge/three-way-tree.js';
import type { FilePath } from '../../../../src/domain/objects/index.js';
import { arbUniquePathInput } from './arbitraries.js';

describe('Given an arbitrary base, label, and reserved set', () => {
  describe('When uniquePath is called', () => {
    it('Then the result is not in the pre-call reserved set and is added to it', () => {
      fc.assert(
        fc.property(arbUniquePathInput(), ({ base, label, reserved }) => {
          // Arrange
          const sut = uniquePath;
          const typedReserved = reserved as Set<FilePath>;
          const preSizeBefore = typedReserved.size;
          const snapshot = new Set(typedReserved);

          // Act
          const result = sut(typedReserved, base as FilePath, label);

          // Assert — result was not in the pre-call set
          expect(snapshot.has(result)).toBe(false);
          // Reserved grows by exactly one entry (the result)
          expect(typedReserved.size).toBe(preSizeBefore + 1);
          expect(typedReserved.has(result)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });

    it('Then the result is the stem when free, else stem_k for the minimal free k', () => {
      fc.assert(
        fc.property(arbUniquePathInput(), ({ base, label, stem, reserved }) => {
          // Arrange
          const sut = uniquePath;
          const typedReserved = reserved as Set<FilePath>;
          const snapshot = new Set(typedReserved);

          // Act
          const result = sut(typedReserved, base as FilePath, label);

          // Assert — oracle: the stem when free, else the smallest k ≥ 0 such
          // that `${stem}_${k}` is not in the pre-call set.
          let expected: FilePath;
          if (!snapshot.has(stem as FilePath)) {
            expected = stem as FilePath;
          } else {
            let k = 0;
            while (snapshot.has(`${stem}_${k}` as FilePath)) {
              k += 1;
            }
            expected = `${stem}_${k}` as FilePath;
          }
          expect(result).toBe(expected);
        }),
        { numRuns: 100 },
      );
    });
  });
});
