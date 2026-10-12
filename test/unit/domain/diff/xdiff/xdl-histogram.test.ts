import { describe, expect, it } from 'vitest';
import {
  diffPresplitLinesForMode,
  type LineHunk,
} from '../../../../../src/domain/diff/line-diff.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const linesOf = (bodies: ReadonlyArray<string>): ReadonlyArray<Uint8Array> =>
  bodies.map((body) => enc(`${body}\n`));
const repeat = (body: string, count: number): ReadonlyArray<string> =>
  Array.from({ length: count }, () => body);

interface ChangedLines {
  readonly deleted: ReadonlyArray<number>;
  readonly inserted: ReadonlyArray<number>;
}

/** 1-based changed line numbers per side — what `git diff -U0` hunk headers name. */
function changedLines(hunks: ReadonlyArray<LineHunk>): ChangedLines {
  const deleted: number[] = [];
  const inserted: number[] = [];
  for (const hunk of hunks) {
    if (hunk.kind === 'ours-only') {
      for (let i = hunk.oursStart; i < hunk.oursEnd; i++) deleted.push(i + 1);
    }
    if (hunk.kind === 'theirs-only') {
      for (let j = hunk.theirsStart; j < hunk.theirsEnd; j++) inserted.push(j + 1);
    }
  }
  return { deleted, inserted };
}

describe('the histogram line diff', () => {
  describe('Given a pair where the rarest common line anchors differently than Myers', () => {
    describe('When diffing with the histogram algorithm', () => {
      it('Then it changes the lines git diff --histogram changes', () => {
        // Arrange
        const sut = diffPresplitLinesForMode;
        const ours = linesOf(['d', 'd', 'b', 'd', 'a', 'c', 'd', 'c']);
        const theirs = linesOf(['d', '}', 'b', 'b', 'd', 'c', 'b']);

        // Act
        const result = sut(ours, theirs, 'histogram');

        // Assert
        expect(changedLines(result.hunks)).toEqual({ deleted: [2, 5, 6, 7], inserted: [2, 3, 7] });
      });
    });
  });

  describe('Given a pair whose unique closing line splits the regions', () => {
    describe('When diffing with the histogram algorithm', () => {
      it('Then it changes the lines git diff --histogram changes', () => {
        // Arrange
        const sut = diffPresplitLinesForMode;
        const ours = linesOf(['d', 'b', 'b', 'b', 'b', '}', 'c', 'd']);
        const theirs = linesOf(['b', 'c', 'd', 'b', '}', 'a', 'a', 'd']);

        // Act
        const result = sut(ours, theirs, 'histogram');

        // Assert
        expect(changedLines(result.hunks)).toEqual({
          deleted: [1, 3, 4, 5, 6],
          inserted: [4, 5, 6, 7, 8],
        });
      });
    });
  });

  describe('Given a region whose only common line occurs more than 64 times', () => {
    describe('When diffing with the histogram algorithm', () => {
      it('Then that region falls back to the classic diff as git does', () => {
        // Arrange
        const sut = diffPresplitLinesForMode;
        const ours = linesOf([...repeat('a', 70), 'x', 'b', 'a', 'a', 'a']);
        const theirs = linesOf(['y', ...repeat('a', 70), 'b', 'a', 'x']);

        // Act
        const result = sut(ours, theirs, 'histogram');

        // Assert
        expect(changedLines(result.hunks)).toEqual({ deleted: [71, 74, 75], inserted: [1, 74] });
      });
    });
  });

  describe('Given a slid group that ends up over a line the other side still has', () => {
    describe('When diffing with the histogram algorithm', () => {
      it('Then the slid group is re-diffed and that line kept as git does', () => {
        // Arrange
        const sut = diffPresplitLinesForMode;
        const ours = linesOf(['a', 'd', 'a', 'd']);
        const theirs = linesOf(['a', 'a', 'd']);

        // Act
        const result = sut(ours, theirs, 'histogram');

        // Assert
        expect(changedLines(result.hunks)).toEqual({ deleted: [2], inserted: [] });
      });
    });
  });

  describe('Given a slid group whose re-diff keeps part of it on both sides', () => {
    describe('When diffing with the histogram algorithm', () => {
      it('Then it changes the lines git diff --histogram changes', () => {
        // Arrange
        const sut = diffPresplitLinesForMode;
        const ours = linesOf(['c', 'd', '}', 'c', 'c', '}']);
        const theirs = linesOf(['c', 'c', 'b', '}']);

        // Act
        const result = sut(ours, theirs, 'histogram');

        // Assert
        expect(changedLines(result.hunks)).toEqual({ deleted: [2, 3, 5], inserted: [3] });
      });
    });
  });

  describe('Given one side empty', () => {
    describe('When diffing with the histogram algorithm', () => {
      it('Then every line of the other side is changed', () => {
        // Arrange
        const sut = diffPresplitLinesForMode;
        const ours = linesOf(['a', 'b']);

        // Act
        const result = sut(ours, [], 'histogram');

        // Assert
        expect(changedLines(result.hunks)).toEqual({ deleted: [1, 2], inserted: [] });
      });
    });
  });

  const lineRange = (first: number, last: number): ReadonlyArray<number> =>
    Array.from({ length: last - first + 1 }, (_, offset) => first + offset);

  describe.each([
    {
      context: 'a match that already spans the next lines of theirs',
      ours: 'b a b a a c c c a c'.split(' '),
      theirs: 'c a b a b'.split(' '),
      deleted: lineRange(4, 10),
      inserted: [1, 2],
    },
    {
      context: 'a match whose forward extension crosses a rarer line',
      ours: 'a c a c a c b c a'.split(' '),
      theirs: 'c b a b a c a'.split(' '),
      deleted: lineRange(1, 5),
      inserted: [3, 4, 5],
    },
    {
      context: 'a repeated line whose next occurrence lies inside the match it anchored',
      ours: 'e e e c a e e c e'.split(' '),
      theirs: 'e e c'.split(' '),
      deleted: [3, 4, 5, 6, 7, 9],
      inserted: [],
    },
    {
      context: 'a match whose backward extension crosses a more repeated line',
      ours: 'c c c c c c b b'.split(' '),
      theirs: 'b a c c b'.split(' '),
      deleted: [1, 2, 3, 4, 8],
      inserted: [1, 2],
    },
    {
      context: 'a match whose backward extension crosses a rarer line',
      ours: 'd b c a d a a d c a e c e c a c b d'.split(' '),
      theirs: 'c d c a d b d'.split(' '),
      deleted: [1, 2, 4, 5, 6, 7, ...lineRange(11, 16)],
      inserted: [5],
    },
    {
      context: 'a region whose rarest common line occurs exactly 64 times',
      ours: [...repeat('a', 64), ...repeat('b', 66)],
      theirs: 'b b a'.split(' '),
      deleted: lineRange(2, 130),
      inserted: [1, 2],
    },
  ])('Given $context', ({ ours, theirs, deleted, inserted }) => {
    describe('When diffing with the histogram algorithm', () => {
      it('Then it changes the lines git diff --histogram changes', () => {
        // Arrange
        const sut = diffPresplitLinesForMode;

        // Act
        const result = sut(linesOf(ours), linesOf(theirs), 'histogram');

        // Assert
        expect(changedLines(result.hunks)).toEqual({ deleted, inserted });
      });
    });
  });
});
