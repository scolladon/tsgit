import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { diffLines } from '../../../../src/domain/diff/line-diff.js';
import { buildMergeSegments, changesFromHunks } from '../../../../src/domain/merge/region-merge.js';
import { mergeContent } from '../../../../src/domain/merge/three-way-content.js';
import { arbDisjointThreeWay, arbThreeWay } from './arbitraries.js';

const RUNS = 100;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const joined = (lines: ReadonlyArray<Uint8Array>): string => lines.map(dec).join('');

const segmentsOf = (base: string, ours: string, theirs: string) => {
  const oursDiff = diffLines(enc(base), enc(ours));
  const theirsDiff = diffLines(enc(base), enc(theirs));
  return buildMergeSegments(
    oursDiff.oursLines.length,
    { lines: oursDiff.theirsLines, changes: changesFromHunks(oursDiff.hunks) },
    { lines: theirsDiff.theirsLines, changes: changesFromHunks(theirsDiff.hunks) },
  );
};

describe('region-merge properties', () => {
  describe('Given an arbitrary 3-way input, When merged with favor union', () => {
    it('Then it always resolves clean with no conflict markers', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbThreeWay(), ({ base, ours, theirs }) => {
          const result = mergeContent(enc(base), enc(ours), enc(theirs), { favor: 'union' });
          expect(result.status).toBe('clean');
          if (result.status === 'clean') {
            expect(dec(result.bytes).includes('<<<<<<<')).toBe(false);
          }
        }),
        { numRuns: RUNS },
      );
    });
  });

  describe('Given disjoint edit scripts, When merged', () => {
    it('Then favor union and favor none produce the same clean bytes', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbDisjointThreeWay(), ({ base, ours, theirs }) => {
          const union = mergeContent(enc(base), enc(ours), enc(theirs), { favor: 'union' });
          const none = mergeContent(enc(base), enc(ours), enc(theirs));
          expect(none.status).toBe('clean');
          expect(union.status).toBe('clean');
          if (union.status === 'clean' && none.status === 'clean') {
            expect(dec(union.bytes)).toBe(dec(none.bytes));
          }
        }),
        { numRuns: RUNS },
      );
    });
  });

  describe('Given an arbitrary 3-way input, When its segments are built', () => {
    it('Then no conflict is left with identical sides', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbThreeWay(), ({ base, ours, theirs }) => {
          for (const segment of segmentsOf(base, ours, theirs)) {
            if (segment.kind === 'conflict') {
              expect(joined(segment.ours)).not.toBe(joined(segment.theirs));
            }
          }
        }),
        { numRuns: RUNS },
      );
    });

    it('Then taking ours in every conflict rebuilds ours wherever theirs changed nothing', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbThreeWay(), ({ base, ours }) => {
          const rebuilt = segmentsOf(base, ours, base)
            .map((segment) => joined(segment.kind === 'clean' ? segment.lines : segment.ours))
            .join('');
          expect(rebuilt).toBe(ours);
        }),
        { numRuns: RUNS },
      );
    });
  });
});
