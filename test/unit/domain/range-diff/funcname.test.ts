import { describe, expect, it } from 'vitest';
import { findFuncLine, matchFuncRec } from '../../../../src/domain/range-diff/funcname.js';

const line = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('matchFuncRec', () => {
  describe('Given a line beginning with a valid identifier byte, When matched', () => {
    it.each([
      ['a letter', 'int main(void)'],
      ['an underscore', '_private(void)'],
      ['a dollar', '$vms_routine'],
      ['an uppercase A boundary', 'Apply()'],
      ['an uppercase Z boundary', 'Zero()'],
      ['a lowercase a boundary', 'apply()'],
      ['a lowercase z boundary', 'zip()'],
    ])('Then a line beginning with %s is returned as the heading', (_label, text) => {
      // Arrange
      const sut = matchFuncRec;

      // Act
      const result = sut(line(text));

      // Assert
      expect(result).toBe(text);
    });
  });

  describe.each([
    ['an opening brace', '{'],
    ['a tab indent', '\tint a = 1;'],
    ['a space indent', '  spaced'],
    ['an empty line', ''],
    ['a digit', '0xdead'],
    ['an at-sign (just below A)', '@home'],
    ['a bracket (just above Z)', '[index]'],
    ['a backtick (just below a)', '`tick'],
  ])('Given a line beginning with %s, When matched', (_label, text) => {
    it('Then it is not a function line', () => {
      // Arrange
      const sut = matchFuncRec;

      // Act
      const result = sut(line(text));

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe.each([
    ['a space', 'void f() '],
    ['a tab', 'void f()\t'],
    ['a newline', 'void f()\n'],
    ['a carriage return', 'void f()\r'],
    ['a vertical tab', 'void f()\v'],
    ['a form feed', 'void f()\f'],
  ])('Given a function line ending with %s, When matched', (_label, text) => {
    it('Then the trailing whitespace byte is stripped', () => {
      // Arrange
      const sut = matchFuncRec;

      // Act
      const result = sut(line(text));

      // Assert
      expect(result).toBe('void f()');
    });
  });

  describe('Given a function line ending with a non-whitespace control byte, When matched', () => {
    it('Then it is kept (0x08 is below the isspace range)', () => {
      // Arrange
      const sut = matchFuncRec;

      // Act
      const result = sut(line('void f()\b'));

      // Assert
      expect(result).toBe('void f()\b');
    });
  });

  describe('Given a function line longer than 80 bytes, When matched', () => {
    it('Then the heading is capped at 80 bytes', () => {
      // Arrange
      const sut = matchFuncRec;
      const long = `a${'b'.repeat(99)}`; // 100 identifier bytes

      // Act
      const result = sut(line(long));

      // Assert
      expect(result).toBe(long.slice(0, 80));
    });
  });
});

describe('findFuncLine', () => {
  describe('Given an old file scanned backward from a hunk, When searched', () => {
    it('Then it returns the nearest preceding function line', () => {
      // Arrange
      const sut = findFuncLine;
      const lines = ['int f(void)', '{', '\tint a = 1;', '\tint b = 2;'].map(line);

      // Act — scan from index 3 down toward -1
      const result = sut(lines, 3, -1);

      // Assert
      expect(result).toEqual({ index: 0, heading: 'int f(void)' });
    });
  });

  describe('Given a scan that finds no function line, When searched', () => {
    it.each([
      {
        lines: ['{', '\tx', '\ty'],
        start: 2,
        limit: -1,
        label: 'it returns undefined',
      },
      {
        lines: ['fn a()', '\tbody', '\tmore'],
        start: 2,
        limit: 0,
        label: 'the limit boundary line is not scanned',
      },
      {
        lines: ['{', '\tbody', '\tmore', 'fn z()'],
        start: 0,
        limit: 3,
        label: 'the limit boundary stops the scan before reaching it',
      },
      {
        lines: ['{', '\tbody', '\tmore'],
        start: 0,
        limit: 99,
        label: 'the upper bound stops the scan at the last line',
      },
      {
        lines: ['\tbody', '\tmore'],
        start: 1,
        limit: -5,
        label: 'the lower bound stops the scan at the first line',
      },
    ])('Then $label', ({ lines, start, limit }) => {
      // Arrange
      const sut = findFuncLine;
      const encoded = lines.map(line);

      // Act
      const result = sut(encoded, start, limit);

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('Given a forward scan (start below limit), When searched', () => {
    it('Then it steps upward and returns the first function line ahead', () => {
      // Arrange
      const sut = findFuncLine;
      const lines = ['{', '\tbody', 'int g(void)', '\tmore'].map(line);

      // Act — scan from index 0 up toward limit 4
      const result = sut(lines, 0, 4);

      // Assert
      expect(result).toEqual({ index: 2, heading: 'int g(void)' });
    });
  });
});
