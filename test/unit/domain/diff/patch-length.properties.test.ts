import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { joinedLength } from '../../../../src/domain/diff/patch-length.js';

// Lens 2 (compositional aggregator): joinedLength reduces an array of rendered
// lines to the length of the one string the renderer will materialise. The
// oracle is the join itself — an independent computation, not a copy of the
// production loop — which is what makes this a pin on the arithmetic the
// refusal is built from rather than a tautology.
const arbRenderedLine = (): fc.Arbitrary<string> => fc.string({ maxLength: 40 });

describe('patch length accounting properties', () => {
  describe('Given an arbitrary array of rendered lines', () => {
    describe('When joinedLength is compared against the join it stands in for', () => {
      it("Then it equals [...lines, ''].join('\\n').length exactly", () => {
        // Arrange
        fc.assert(
          fc.property(fc.array(arbRenderedLine(), { maxLength: 32 }), (lines) => {
            // Act
            const result = joinedLength(lines);
            // Assert
            expect(result).toBe([...lines, ''].join('\n').length);
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary array of rendered lines and one more line', () => {
    describe('When the extra line is appended', () => {
      it('Then the joined length grows by exactly that line plus its separator', () => {
        // Arrange
        fc.assert(
          fc.property(
            fc.array(arbRenderedLine(), { maxLength: 32 }),
            arbRenderedLine(),
            (lines, extra) => {
              // Act
              const result = joinedLength([...lines, extra]) - joinedLength(lines);
              // Assert
              expect(result).toBe(extra.length + 1);
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });
});
