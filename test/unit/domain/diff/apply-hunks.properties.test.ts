import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyDiffOnto } from '../../../../src/domain/diff/apply-hunks.js';
import { concatBytes, decode } from '../../../../src/domain/objects/encoding.js';
import { arbLineBlob, arbUniqueLineEdit } from './arbitraries.js';

describe('apply-hunks properties', () => {
  describe('Given an arbitrary base and target (round-trip lens)', () => {
    describe('When the diff of base to target is applied onto base', () => {
      it('Then the result equals the target byte for byte', () => {
        // Arrange
        const sut = applyDiffOnto;
        fc.assert(
          fc.property(arbLineBlob(), arbLineBlob(), (base, target) => {
            // Act
            const result = sut({ base, target, current: base });

            // Assert
            expect(result === undefined ? undefined : decode(result)).toBe(decode(target));
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary edit of unique lines (invariant lens)', () => {
    describe('When an unrelated prefix is added above the current', () => {
      it('Then the result is the prefix followed by the target', () => {
        // Arrange
        const sut = applyDiffOnto;
        fc.assert(
          fc.property(arbUniqueLineEdit(), ({ base, target, prefix }) => {
            // Act
            const result = sut({ base, target, current: concatBytes([prefix, base]) });

            // Assert
            expect(result === undefined ? undefined : decode(result)).toBe(
              decode(concatBytes([prefix, target])),
            );
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
