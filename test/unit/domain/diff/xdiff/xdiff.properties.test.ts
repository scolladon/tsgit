import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  diffPresplitLinesForMode,
  type LineHunk,
} from '../../../../../src/domain/diff/line-diff.js';
import type { SearchMode } from '../../../../../src/domain/diff/xdiff/xdl-prepare.js';

// A small, collision-prone alphabet so repeated content (the substance the
// search matches, and compaction slides on) is common even at a small array
// size — mirroring xdl-compact.properties.test.ts's approach. Bounded at 12
// lines per side: the LCS oracle below is O(M·N), and this is the whole
// pipeline (classify, prepare, split, compact), not one isolated stage.
const LINE_BODIES = ['a', 'b', 'c', 'd'] as const;
const MAX_LINES_PER_SIDE = 12;

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const decoder = new TextDecoder();

function arbLines(): fc.Arbitrary<ReadonlyArray<string>> {
  return fc.array(fc.constantFrom(...LINE_BODIES), { minLength: 0, maxLength: MAX_LINES_PER_SIDE });
}

function arbMode(): fc.Arbitrary<SearchMode> {
  return fc.constantFrom<SearchMode>('git-default', 'minimal');
}

function encodeAll(lines: ReadonlyArray<string>): ReadonlyArray<Uint8Array> {
  return lines.map(enc);
}

/**
 * Independent LCS-length oracle: a plain O(M·N) dynamic program over string
 * equality, not a copy of the production search — so comparing against it is
 * a real check on the minimal search's output rather than a tautology (see
 * property-testing.md's caution on oracle reuse).
 */
function lcsLength(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      table[i]![j] =
        a[i - 1] === b[j - 1]
          ? table[i - 1]![j - 1]! + 1
          : Math.max(table[i - 1]![j]!, table[i]![j - 1]!);
    }
  }
  return table[a.length]![b.length]!;
}

function reconstruct(
  hunks: ReadonlyArray<LineHunk>,
  oursLines: ReadonlyArray<Uint8Array>,
  theirsLines: ReadonlyArray<Uint8Array>,
): { readonly ours: ReadonlyArray<string>; readonly theirs: ReadonlyArray<string> } {
  const ours: string[] = [];
  const theirs: string[] = [];
  for (const hunk of hunks) {
    for (let i = hunk.oursStart; i < hunk.oursEnd; i++) ours.push(decoder.decode(oursLines[i]!));
    for (let j = hunk.theirsStart; j < hunk.theirsEnd; j++)
      theirs.push(decoder.decode(theirsLines[j]!));
  }
  return { ours, theirs };
}

/** Total changed lines on both sides: `M + N - 2·commonCount`, where
 *  `commonCount` is how many lines the script actually matched. */
function changedCount(hunks: ReadonlyArray<LineHunk>, M: number, N: number): number {
  let common = 0;
  for (const hunk of hunks) {
    if (hunk.kind === 'common') common += hunk.oursEnd - hunk.oursStart;
  }
  return M + N - 2 * common;
}

describe('the xdiff pipeline properties', () => {
  describe('Given arbitrary ours/theirs line arrays, under either search mode', () => {
    describe('When diffPresplitLinesForMode runs', () => {
      it('Then re-walking the hunks in order reproduces both original sequences', () => {
        // Arrange
        fc.assert(
          fc.property(arbLines(), arbLines(), arbMode(), (oursText, theirsText, mode) => {
            // Act
            const result = diffPresplitLinesForMode(
              encodeAll(oursText),
              encodeAll(theirsText),
              mode,
            );
            const rebuilt = reconstruct(result.hunks, result.oursLines, result.theirsLines);

            // Assert
            expect(rebuilt.ours).toEqual(oursText);
            expect(rebuilt.theirs).toEqual(theirsText);
          }),
          { numRuns: 100 },
        );
      });

      it('Then compaction preserves the added/deleted line counts of the raw script', () => {
        // Arrange
        fc.assert(
          fc.property(arbLines(), arbLines(), arbMode(), (oursText, theirsText, mode) => {
            // Act
            const oursLines = encodeAll(oursText);
            const theirsLines = encodeAll(theirsText);
            const result = diffPresplitLinesForMode(oursLines, theirsLines, mode);

            // Assert — every hunk kind partitions oursLines/theirsLines exactly once
            let oursCovered = 0;
            let theirsCovered = 0;
            for (const hunk of result.hunks) {
              if (hunk.kind !== 'theirs-only') oursCovered += hunk.oursEnd - hunk.oursStart;
              if (hunk.kind !== 'ours-only') theirsCovered += hunk.theirsEnd - hunk.theirsStart;
            }
            expect(oursCovered).toBe(oursLines.length);
            expect(theirsCovered).toBe(theirsLines.length);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given arbitrary ours/theirs line arrays', () => {
    describe('When diffPresplitLinesForMode runs under mode "minimal"', () => {
      it('Then the changed line count equals the M + N - 2·LCS bound exactly', () => {
        // Arrange — under 'minimal', cleanupRecords only ever discards
        // lines with literally no match on the other side (never a
        // genuine LCS member), so the search below it is provably minimal
        fc.assert(
          fc.property(arbLines(), arbLines(), (oursText, theirsText) => {
            // Act
            const result = diffPresplitLinesForMode(
              encodeAll(oursText),
              encodeAll(theirsText),
              'minimal',
            );
            const bound = oursText.length + theirsText.length - 2 * lcsLength(oursText, theirsText);

            // Assert
            expect(changedCount(result.hunks, oursText.length, theirsText.length)).toBe(bound);
          }),
          { numRuns: 100 },
        );
      });
    });

    describe('When diffPresplitLinesForMode runs under mode "git-default"', () => {
      it('Then the changed line count is never below the minimal M + N - 2·LCS bound', () => {
        // Arrange — the multi-match discard rule and the split's snake
        // heuristic/cost cap can only ever match fewer lines than the true
        // LCS, never more
        fc.assert(
          fc.property(arbLines(), arbLines(), (oursText, theirsText) => {
            // Act
            const result = diffPresplitLinesForMode(
              encodeAll(oursText),
              encodeAll(theirsText),
              'git-default',
            );
            const bound = oursText.length + theirsText.length - 2 * lcsLength(oursText, theirsText);

            // Assert
            expect(
              changedCount(result.hunks, oursText.length, theirsText.length),
            ).toBeGreaterThanOrEqual(bound);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
