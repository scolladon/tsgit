import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  diffPresplitLinesForMode,
  type LineHunk,
} from '../../../../../src/domain/diff/line-diff.js';

// A tiny alphabet keeps repeats common, so the rarest-line anchoring, the
// over-repeated classic fallback (a 2-letter alphabet past 130 lines) and the
// post-slide re-diff all get exercised.
const enc = (s: string): Uint8Array => new TextEncoder().encode(`${s}\n`);

function arbLines(alphabet: ReadonlyArray<string>, maxLength: number): fc.Arbitrary<string[]> {
  return fc.array(fc.constantFrom(...alphabet), { maxLength });
}

function commonLines(
  hunks: ReadonlyArray<LineHunk>,
  ours: ReadonlyArray<string>,
  theirs: ReadonlyArray<string>,
): { readonly ours: string[]; readonly theirs: string[] } {
  const common = hunks.filter((hunk) => hunk.kind === 'common');
  return {
    ours: common.flatMap((hunk) => ours.slice(hunk.oursStart, hunk.oursEnd)),
    theirs: common.flatMap((hunk) => theirs.slice(hunk.theirsStart, hunk.theirsEnd)),
  };
}

function covered(hunks: ReadonlyArray<LineHunk>): {
  readonly ours: number;
  readonly theirs: number;
} {
  return {
    ours: hunks.reduce((sum, hunk) => sum + hunk.oursEnd - hunk.oursStart, 0),
    theirs: hunks.reduce((sum, hunk) => sum + hunk.theirsEnd - hunk.theirsStart, 0),
  };
}

describe('the histogram line diff properties', () => {
  describe.each([
    ['a four-line alphabet', ['a', 'b', 'c', 'd'], 40],
    ['a two-line alphabet long enough to repeat past the chain cap', ['a', 'b'], 160],
  ] as const)('Given arbitrary sides over %s', (_label, alphabet, maxLength) => {
    describe('When diffed with the histogram algorithm', () => {
      it('Then the kept lines read the same on both sides', () => {
        // Arrange
        const sut = diffPresplitLinesForMode;
        fc.assert(
          fc.property(
            arbLines(alphabet, maxLength),
            arbLines(alphabet, maxLength),
            (ours, theirs) => {
              // Act
              const result = sut(ours.map(enc), theirs.map(enc), 'histogram');

              // Assert
              const kept = commonLines(result.hunks, ours, theirs);
              expect(kept.ours).toEqual(kept.theirs);
            },
          ),
          { numRuns: 60 },
        );
      });

      it('Then the hunks cover every line of both sides exactly once', () => {
        // Arrange
        const sut = diffPresplitLinesForMode;
        fc.assert(
          fc.property(
            arbLines(alphabet, maxLength),
            arbLines(alphabet, maxLength),
            (ours, theirs) => {
              // Act
              const result = sut(ours.map(enc), theirs.map(enc), 'histogram');

              // Assert
              expect(covered(result.hunks)).toEqual({ ours: ours.length, theirs: theirs.length });
            },
          ),
          { numRuns: 60 },
        );
      });
    });
  });

  describe('Given identical sides', () => {
    describe('When diffed with the histogram algorithm', () => {
      it('Then no line is changed', () => {
        // Arrange
        const sut = diffPresplitLinesForMode;
        fc.assert(
          fc.property(arbLines(['a', 'b', 'c'], 80), (lines) => {
            // Act
            const result = sut(lines.map(enc), lines.map(enc), 'histogram');

            // Assert
            expect(result.hunks.every((hunk) => hunk.kind === 'common')).toBe(true);
          }),
          { numRuns: 60 },
        );
      });
    });
  });
});
