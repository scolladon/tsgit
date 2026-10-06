import { describe, expect, it } from 'vitest';
import {
  diffPresplitLinesForMode,
  type LineHunk,
} from '../../../../../src/domain/diff/line-diff.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const linesOf = (bodies: ReadonlyArray<string>): ReadonlyArray<Uint8Array> =>
  bodies.map((body) => enc(`${body}\n`));

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

describe('the patience line diff', () => {
  describe('Given unique lines that anchor a different alignment than Myers', () => {
    describe('When diffing with the patience algorithm', () => {
      it('Then it changes the lines git diff --patience changes', () => {
        // Arrange
        const sut = diffPresplitLinesForMode;
        const ours = linesOf(['c', 'e', 'e', 'f', 'c', 'b', 'c', 'b']);
        const theirs = linesOf(['d', 'e', 'd', 'g', 'c', 'f', 'c', 'a', 'h']);

        // Act
        const result = sut(ours, theirs, 'patience');

        // Assert
        expect(changedLines(result.hunks)).toEqual({
          deleted: [2, 3, 6, 7, 8],
          inserted: [1, 2, 3, 4, 8, 9],
        });
      });
    });
  });

  describe('Given a unique line Myers matches elsewhere', () => {
    describe('When diffing with the patience algorithm', () => {
      it('Then it changes the lines git diff --patience changes', () => {
        // Arrange
        const sut = diffPresplitLinesForMode;
        const ours = linesOf(['f', 'c', 'h', 'c', 'h', 'g', 'c']);
        const theirs = linesOf(['f', 'c', 'h', 'a', 'h', 'h', 'e', 'g']);

        // Act
        const result = sut(ours, theirs, 'patience');

        // Assert
        expect(changedLines(result.hunks)).toEqual({ deleted: [4, 7], inserted: [4, 6, 7] });
      });
    });
  });

  describe('Given repeated lines around the unique anchors', () => {
    describe('When diffing with the patience algorithm', () => {
      it('Then it changes the lines git diff --patience changes', () => {
        // Arrange
        const sut = diffPresplitLinesForMode;
        const ours = linesOf(['f', 'e', 'c', 'b', 'f', 'd', 'h']);
        const theirs = linesOf(['f', 'b', 'b', 'b', 'c', 'f', 'c', 'g', 'h']);

        // Act
        const result = sut(ours, theirs, 'patience');

        // Assert
        expect(changedLines(result.hunks)).toEqual({
          deleted: [2, 4, 6],
          inserted: [2, 3, 4, 7, 8],
        });
      });
    });
  });

  describe('Given one line unique on both sides amid repeats', () => {
    describe('When diffing with the patience algorithm', () => {
      it('Then it changes the lines git diff --patience changes', () => {
        // Arrange
        const sut = diffPresplitLinesForMode;
        const ours = linesOf(['a', 'b', 'a', 'c']);
        const theirs = linesOf(['c', 'b', 'a', 'b']);

        // Act
        const result = sut(ours, theirs, 'patience');

        // Assert
        expect(changedLines(result.hunks)).toEqual({ deleted: [1, 2, 3], inserted: [2, 3, 4] });
      });
    });
  });

  describe('Given matching lines none of which is unique on both sides', () => {
    describe('When diffing with the patience algorithm', () => {
      it('Then the region falls back to the classic diff as git does', () => {
        // Arrange
        const sut = diffPresplitLinesForMode;
        const ours = linesOf(['a', 'b', 'a', 'x']);
        const theirs = linesOf(['b', 'a', 'b', 'y']);

        // Act
        const result = sut(ours, theirs, 'patience');

        // Assert
        expect(changedLines(result.hunks)).toEqual({ deleted: [1, 4], inserted: [3, 4] });
      });
    });
  });

  describe('Given sides with no line in common', () => {
    describe('When diffing with the patience algorithm', () => {
      it('Then every line of both sides is changed', () => {
        // Arrange
        const sut = diffPresplitLinesForMode;
        const ours = linesOf(['x', 'y']);
        const theirs = linesOf(['z']);

        // Act
        const result = sut(ours, theirs, 'patience');

        // Assert
        expect(changedLines(result.hunks)).toEqual({ deleted: [1, 2], inserted: [1] });
      });
    });
  });
});
