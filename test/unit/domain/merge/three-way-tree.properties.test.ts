import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { uniquePath } from '../../../../src/domain/merge/three-way-tree.js';
import type { FilePath } from '../../../../src/domain/objects/index.js';

// Generator: a slash-free label (flattenLabel is identity when no slashes),
// a non-empty base path (no slashes so stem = `${base}~${label}` is computable),
// and a reserved set built from the stem plus an arbitrary subset of stem_0…stem_9.
const arbUniquePath = () =>
  fc
    .record({
      base: fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/).filter((s) => !s.includes('/')),
      label: fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/).filter((s) => !s.includes('/')),
      // bitmask: which of stem_0..stem_9 are pre-occupied (stem itself always occupied)
      mask: fc.integer({ min: 0, max: 1023 }),
    })
    .map(({ base, label, mask }) => {
      const stem = `${base}~${label}`;
      const reserved = new Set<FilePath>([stem as FilePath]);
      for (let k = 0; k < 10; k++) {
        if (mask & (1 << k)) {
          reserved.add(`${stem}_${k}` as FilePath);
        }
      }
      return { base: base as FilePath, label, stem, reserved };
    });

describe('Given an arbitrary base, label, and reserved set containing the stem', () => {
  describe('When uniquePath is called', () => {
    it('Then the result is not in the pre-call reserved set and is added to it', () => {
      fc.assert(
        fc.property(arbUniquePath(), ({ base, label, stem: _stem, reserved }) => {
          // Arrange
          const sut = uniquePath;
          const preSizeBefore = reserved.size;
          const snapshot = new Set(reserved);

          // Act
          const result = sut(reserved, base, label);

          // Assert — result was not in the pre-call set
          expect(snapshot.has(result)).toBe(false);
          // Reserved grows by exactly one entry (the result)
          expect(reserved.size).toBe(preSizeBefore + 1);
          expect(reserved.has(result)).toBe(true);
        }),
        { numRuns: 200 },
      );
    });

    it('Then the result is the stem when free, else stem_k for the minimal free k', () => {
      fc.assert(
        fc.property(arbUniquePath(), ({ base, label, stem, reserved }) => {
          // Arrange
          const sut = uniquePath;
          const snapshot = new Set(reserved);

          // Act
          const result = sut(reserved, base, label);

          // Assert — oracle: stem when free (impossible here since stem is always reserved),
          // else the smallest k ≥ 0 such that `${stem}_${k}` is not in the pre-call set.
          // Since stem is always in the pre-call reserved set, we always look for minimal k.
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
        { numRuns: 200 },
      );
    });
  });
});
