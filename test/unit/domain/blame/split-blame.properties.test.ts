import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { splitAgainstParent } from '../../../../src/domain/blame/split-blame.js';
import type { BlameEntry } from '../../../../src/domain/blame/types.js';
import { arbDisjointCase, arbIdentityCase, arbSplitCase } from './arbitraries.js';

const totalCount = (entries: ReadonlyArray<BlameEntry>): number =>
  entries.reduce((sum, entry) => sum + entry.count, 0);

const finalLines = (entries: ReadonlyArray<BlameEntry>): ReadonlyArray<number> =>
  entries
    .flatMap((entry) => Array.from({ length: entry.count }, (_, i) => entry.finalStart + i))
    .sort((a, b) => a - b);

describe('Given an arbitrary parent/child diff and a partition of the child lines', () => {
  describe('When splitting blame against the parent', () => {
    it('Then no line is lost or duplicated (passed + kept counts conserve the input)', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbSplitCase(), ({ entries, lineDiff }) => {
          const { passed, kept } = splitAgainstParent(entries, lineDiff);
          expect(totalCount(passed) + totalCount(kept)).toBe(totalCount(entries));
        }),
        { numRuns: 100 },
      );
    });

    it('Then the output covers exactly the input final lines (a partition of the final file)', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbSplitCase(), ({ entries, lineDiff }) => {
          const { passed, kept } = splitAgainstParent(entries, lineDiff);
          expect(finalLines([...passed, ...kept])).toEqual(finalLines(entries));
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given a child identical to its parent', () => {
  describe('When splitting blame', () => {
    it('Then everything passes and nothing is kept, sourceStart tracking the final position', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbIdentityCase(), ({ entries, lineDiff, finalBase }) => {
          const { passed, kept } = splitAgainstParent(entries, lineDiff);
          expect(kept).toEqual([]);
          expect(totalCount(passed)).toBe(totalCount(entries));
          for (const entry of passed) {
            expect(entry.sourceStart).toBe(entry.finalStart - finalBase);
          }
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given a child sharing no line with its parent', () => {
  describe('When splitting blame', () => {
    it('Then nothing passes and everything is kept at the suspect (sourceStart unchanged)', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbDisjointCase(), ({ entries, lineDiff, finalBase }) => {
          const { passed, kept } = splitAgainstParent(entries, lineDiff);
          expect(passed).toEqual([]);
          expect(totalCount(kept)).toBe(totalCount(entries));
          for (const entry of kept) {
            expect(entry.sourceStart).toBe(entry.finalStart - finalBase);
          }
        }),
        { numRuns: 100 },
      );
    });
  });
});
