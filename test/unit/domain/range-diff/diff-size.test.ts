import { describe, expect, it } from 'vitest';
import { diffSize } from '../../../../src/domain/range-diff/diff-size.js';

const seq = (from: number, to: number): string => {
  const lines: string[] = [];
  for (let n = from; n <= to; n++) lines.push(`${n}`);
  return `${lines.join('\n')}\n`;
};

describe('diffSize', () => {
  describe('Given a pair of texts, When measured', () => {
    it.each([
      {
        before: 'alpha\nbeta\n',
        after: 'alpha\nbeta\n',
        expected: 0,
        label: 'the size is zero for identical texts',
      },
      {
        before: 'foo\n',
        after: 'bar\n',
        expected: 3,
        label: 'the size is the hunk header plus the removed and added lines for a one-line change',
      },
      {
        before: '',
        after: 'L1\nL2\nL3\n',
        expected: 4,
        label:
          'the size is the hunk header plus every added line for an insertion against an empty text',
      },
      {
        before: seq(1, 20),
        after: `${seq(1, 9)}NINE.5\n${seq(10, 20)}`,
        expected: 8,
        label:
          'the size counts the header, bounded context, and the change for a single insertion inside a long text',
      },
      {
        before: seq(1, 20),
        after: `${seq(1, 5)}${seq(12, 20)}`,
        expected: 13,
        label:
          'the size counts the header, bounded context, and every deletion for a multi-line deletion inside a long text',
      },
    ])('Then $label', ({ before, after, expected }) => {
      // Arrange
      const sut = diffSize;

      // Act
      const result = sut(before, after);

      // Assert
      expect(result).toBe(expected);
    });
  });
});
