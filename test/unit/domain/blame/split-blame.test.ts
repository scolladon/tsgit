import { describe, expect, it } from 'vitest';
import { splitAgainstParent } from '../../../../src/domain/blame/split-blame.js';
import type { BlameEntry } from '../../../../src/domain/blame/types.js';
import type { LineDiff, LineHunk } from '../../../../src/domain/diff/line-diff.js';

const mkDiff = (hunks: ReadonlyArray<LineHunk>): LineDiff => ({
  hunks,
  oursLines: [],
  theirsLines: [],
  degraded: false,
});

const common = (oursStart: number, theirsStart: number, count: number): LineHunk => ({
  kind: 'common',
  oursStart,
  oursEnd: oursStart + count,
  theirsStart,
  theirsEnd: theirsStart + count,
});

const theirsOnly = (theirsStart: number, count: number, oursAt: number): LineHunk => ({
  kind: 'theirs-only',
  oursStart: oursAt,
  oursEnd: oursAt,
  theirsStart,
  theirsEnd: theirsStart + count,
});

const oursOnly = (oursStart: number, count: number, theirsAt: number): LineHunk => ({
  kind: 'ours-only',
  oursStart,
  oursEnd: oursStart + count,
  theirsStart: theirsAt,
  theirsEnd: theirsAt,
});

const entry = (finalStart: number, count: number, sourceStart: number): BlameEntry => ({
  finalStart,
  count,
  sourceStart,
});

describe('Given a diff between parent and child', () => {
  describe('When splitting blame entries against the parent', () => {
    it.each([
      {
        entries: [entry(0, 3, 0)],
        diff: mkDiff([common(0, 0, 3)]),
        expectedPassed: [entry(0, 3, 0)],
        expectedKept: [],
        label: 'a fully unchanged child: every entry passes with sourceStart unchanged',
      },
      {
        entries: [entry(0, 3, 0)],
        diff: mkDiff([oursOnly(0, 2, 0), common(2, 0, 3)]),
        expectedPassed: [entry(0, 3, 2)],
        expectedKept: [],
        label:
          'the parent inserted lines above the common region: passed entries carry the parent line numbering (offset)',
      },
      {
        entries: [entry(0, 4, 0)],
        diff: mkDiff([theirsOnly(0, 2, 0), common(0, 2, 2)]),
        expectedPassed: [entry(2, 2, 0)],
        expectedKept: [entry(0, 2, 0)],
        label:
          'the child added leading lines absent in the parent: the added lines are kept and the trailing common lines pass',
      },
      {
        entries: [entry(10, 4, 0)],
        diff: mkDiff([common(0, 0, 2), theirsOnly(2, 2, 2)]),
        expectedPassed: [entry(10, 2, 0)],
        expectedKept: [entry(12, 2, 2)],
        label:
          'an entry straddling a common→added boundary splits into one passed and one kept entry, each preserving finalStart',
      },
      {
        entries: [entry(0, 4, 0)],
        diff: mkDiff([common(0, 0, 2), oursOnly(2, 2, 2), common(4, 2, 2)]),
        expectedPassed: [entry(0, 2, 0), entry(2, 2, 4)],
        expectedKept: [],
        label:
          'two common regions split by a parent-only deletion: the non-contiguous parent numbering forces two passed entries',
      },
      {
        entries: [entry(0, 1, 0), entry(1, 1, 1)],
        diff: mkDiff([common(0, 0, 1), theirsOnly(1, 1, 1)]),
        expectedPassed: [entry(0, 1, 0)],
        expectedKept: [entry(1, 1, 1)],
        label: 'multiple independent entries are each partitioned independently',
      },
      {
        entries: [],
        diff: mkDiff([common(0, 0, 3)]),
        expectedPassed: [],
        expectedKept: [],
        label: 'no entries: both partitions are empty',
      },
      {
        entries: [entry(0, 3, 0)],
        diff: mkDiff([oursOnly(0, 3, 0), theirsOnly(0, 3, 0)]),
        expectedPassed: [],
        expectedKept: [entry(0, 3, 0)],
        label:
          'a wholly-rewritten (degraded) diff with no common region: every entry is kept at the suspect',
      },
    ])('Then $label', ({ entries, diff, expectedPassed, expectedKept }) => {
      // Arrange
      const sut = splitAgainstParent;

      // Act
      const result = sut(entries, diff);

      // Assert
      expect(result.passed).toEqual(expectedPassed);
      expect(result.kept).toEqual(expectedKept);
    });
  });
});
