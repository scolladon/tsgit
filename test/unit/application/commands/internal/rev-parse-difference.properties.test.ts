/**
 * Property tests for differenceSides.
 *
 * Lens 1 (round-trip) fits: joining two sides free of `..` with `..` (or the
 * symmetric `...`) and splitting again yields those sides, an empty side read
 * as `HEAD`. Lens 3 (total function) is covered by the same arbitrary.
 * Lens 2 and 4 do not fit — there is nothing to match and no count to keep.
 */
import fc from 'fast-check';
import { describe, it } from 'vitest';
import { differenceSides } from '../../../../../src/application/commands/internal/rev-parse-difference.js';

const NUM_RUNS = 200;
const arbSide = fc.stringMatching(/^[a-z~^:/]{0,6}$/);
const orHead = (side: string): string => (side === '' ? 'HEAD' : side);

describe('differenceSides properties', () => {
  describe('Given two sides joined by a two- or three-dot operator', () => {
    describe('When the join is split', () => {
      it('Then it yields the sides back, an empty one read as HEAD', () => {
        // Arrange
        const sut = differenceSides;

        // Act + Assert
        fc.assert(
          fc.property(arbSide, arbSide, fc.constantFrom('..', '...'), (start, end, operator) => {
            const result = sut(`${start}${operator}${end}`);
            if (start === '' && end === '' && operator === '..') return result === undefined;
            return result?.start === orHead(start) && result.end === orHead(end);
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});
