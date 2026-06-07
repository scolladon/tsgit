import { describe, expect, it } from 'vitest';
import { diffSize } from '../../../../src/domain/range-diff/diff-size.js';

const seq = (from: number, to: number): string => {
  const lines: string[] = [];
  for (let n = from; n <= to; n++) lines.push(`${n}`);
  return `${lines.join('\n')}\n`;
};

describe('diffSize', () => {
  describe('Given two identical texts, When measured', () => {
    it('Then the size is zero', () => {
      // Arrange
      const sut = diffSize;

      // Act
      const result = sut('alpha\nbeta\n', 'alpha\nbeta\n');

      // Assert
      expect(result).toBe(0);
    });
  });

  describe('Given a one-line change, When measured', () => {
    it('Then the size is the hunk header plus the removed and added lines', () => {
      // Arrange
      const sut = diffSize;

      // Act
      const result = sut('foo\n', 'bar\n');

      // Assert — @@ + -foo + +bar
      expect(result).toBe(3);
    });
  });

  describe('Given an insertion against an empty text, When measured', () => {
    it('Then the size is the hunk header plus every added line', () => {
      // Arrange
      const sut = diffSize;

      // Act
      const result = sut('', 'L1\nL2\nL3\n');

      // Assert — @@ + three additions
      expect(result).toBe(4);
    });
  });

  describe('Given a single insertion inside a long text, When measured', () => {
    it('Then the size counts the header, bounded context, and the change', () => {
      // Arrange
      const sut = diffSize;
      const before = seq(1, 20);
      const after = `${seq(1, 9)}NINE.5\n${seq(10, 20)}`;

      // Act
      const result = sut(before, after);

      // Assert — @@ + 3 context + 1 insertion + 3 context
      expect(result).toBe(8);
    });
  });

  describe('Given a multi-line deletion inside a long text, When measured', () => {
    it('Then the size counts the header, bounded context, and every deletion', () => {
      // Arrange
      const sut = diffSize;
      const before = seq(1, 20);
      const after = `${seq(1, 5)}${seq(12, 20)}`;

      // Act
      const result = sut(before, after);

      // Assert — @@ + 3 context + 6 deletions + 3 context
      expect(result).toBe(13);
    });
  });
});
