/**
 * Property tests for decodeDeltaIntervals.
 *
 * Lens 1 (round-trip) fits: any ascending list of non-negative code points,
 * written as base-36 deltas from the previous one, decodes back to itself.
 * Lenses 2–4 do not fit: the generator is the only producer of the encoding,
 * so there is no grammar to match or reject and no count beyond the length.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DELTA_RADIX,
  DELTA_SEPARATOR,
  decodeDeltaIntervals,
} from '../../../../src/domain/pretty/delta-intervals.js';

const NUM_RUNS = 100;
const MAX_CODE_POINT = 0x10ffff;

const arbAscendingCodePoints = fc
  .array(fc.integer({ min: 0, max: MAX_CODE_POINT }), { minLength: 1, maxLength: 40 })
  .map((codePoints) => [...codePoints].sort((left, right) => left - right));

const encode = (codePoints: readonly number[]): string =>
  codePoints
    .map((codePoint, index) => codePoint - (codePoints[index - 1] ?? 0))
    .map((delta) => delta.toString(DELTA_RADIX))
    .join(DELTA_SEPARATOR);

describe('decodeDeltaIntervals properties', () => {
  describe('Given any ascending code point list', () => {
    describe('When it is delta-encoded then decoded', () => {
      it('Then the list comes back unchanged', () => {
        fc.assert(
          fc.property(arbAscendingCodePoints, (codePoints) => {
            // Arrange
            const sut = decodeDeltaIntervals;

            // Act
            const result = sut(encode(codePoints));

            // Assert
            expect(result).toEqual(codePoints);
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});
