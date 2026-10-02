import { describe, expect, it } from 'vitest';
import {
  NO_WRAPPING,
  parseWrapLayout,
  rewrapTail,
  type WrapLayout,
  wrapText,
} from '../../../../src/domain/pretty/wrap.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('wrapText', () => {
  describe('Given a width, When wrapping', () => {
    it.each([
      ['the quick brown fox jumps', 2, 4, 10, '  the\n    quick\n    brown\n    fox\n    jumps'],
      ['msg subject line', 2, 4, 10, '  msg\n    subject\n    line'],
      ['aa bb cc dd ee', 0, 3, 8, 'aa bb cc\n   dd ee'],
      ['ab cd ef gh', 0, 0, 5, 'ab cd\nef gh'],
      ['ab cd ef', 1, 1, 100, ' ab cd ef'],
    ])('Then %j wraps at indents %i/%i width %i', (text, indent1, indent2, width, expected) => {
      // Arrange
      const sut = wrapText;

      // Act
      const result = sut(encode(text), indent1, indent2, width);

      // Assert
      expect(decode(result)).toBe(expected);
    });
  });

  describe('Given a line exactly as wide as the width, When wrapping', () => {
    it('Then it stays on one line', () => {
      // Arrange
      const sut = wrapText;

      // Act
      const result = sut(encode('ab cd'), 0, 0, 5);

      // Assert
      expect(decode(result)).toBe('ab cd');
    });

    it('Then one column less wraps it', () => {
      // Arrange
      const sut = wrapText;

      // Act
      const result = sut(encode('ab cd'), 0, 0, 4);

      // Assert
      expect(decode(result)).toBe('ab\ncd');
    });
  });

  describe('Given a word longer than the width, When wrapping', () => {
    it.each([
      ['abcdefgh ij', 4, 'abcdefgh\nij'],
      ['aaaaaaaaaaaaaaaaaa bb', 10, 'aaaaaaaaaaaaaaaaaa\nbb'],
    ])('Then %j overflows its line', (text, width, expected) => {
      // Arrange
      const sut = wrapText;

      // Act
      const result = sut(encode(text), 0, 0, width);

      // Assert
      expect(decode(result)).toBe(expected);
    });
  });

  describe('Given no width, When wrapping', () => {
    it.each([
      ['ab cd\nef', 2, 4, '  ab cd\n    ef'],
      ['ab cd', 0, 0, 'ab cd'],
      ['', 3, 3, ''],
      ['a\n\nb', 1, 2, ' a\n  \n  b'],
    ])('Then %j is only indented', (text, indent1, indent2, expected) => {
      // Arrange
      const sut = wrapText;

      // Act
      const result = sut(encode(text), indent1, indent2, 0);

      // Assert
      expect(decode(result)).toBe(expected);
    });
  });

  describe('Given newlines in the text, When wrapping', () => {
    it.each([
      ['ab\ncd ef gh', 5, 'ab cd\nef gh'],
      ['ab\n\ncd', 20, 'ab\n\ncd'],
      ['ab cd\n e f g h i', 5, 'ab cd\ne f g\nh i'],
      ['a\n-b c\n d', 5, 'a\n-b c\nd'],
      ['ab\n', 5, 'ab\n'],
      ['\n', 5, '\n'],
    ])('Then %j at width %i becomes %j', (text, width, expected) => {
      // Arrange
      const sut = wrapText;

      // Act
      const result = sut(encode(text), 0, 0, width);

      // Assert
      expect(decode(result)).toBe(expected);
    });
  });

  describe('Given whitespace runs, When wrapping', () => {
    it.each([
      ['a  b   c', 10, 'a  b   c'],
      ['ab\tcd ef\tgh', 5, 'ab\ncd ef\ngh'],
      ['ab\tcd ef', 6, 'ab\ncd ef'],
      [' ab cd', 3, ' ab\ncd'],
      ['ab\v cd\f ef', 10, 'ab\v cd\f ef'],
    ])('Then %j at width %i becomes %j', (text, width, expected) => {
      // Arrange
      const sut = wrapText;

      // Act
      const result = sut(encode(text), 0, 0, width);

      // Assert
      expect(decode(result)).toBe(expected);
    });
  });

  describe('Given wide and combining glyphs, When wrapping', () => {
    it.each([
      ['é é é é é é', 5, 'é é é\né é é'],
      ['日本 語語', 3, '日本\n語語'],
      ['ab́ cd ef gh', 6, 'ab́ cd\nef gh'],
    ])('Then %j at width %i becomes %j', (text, width, expected) => {
      // Arrange
      const sut = wrapText;

      // Act
      const result = sut(encode(text), 0, 0, width);

      // Assert
      expect(decode(result)).toBe(expected);
    });
  });

  describe('Given bytes that are not UTF-8, When wrapping', () => {
    it('Then every byte counts as one column', () => {
      // Arrange
      const sut = wrapText;
      const text = Uint8Array.of(0x61, 0x62, 0x80, 0x20, 0x63, 0x64, 0x20, 0x65, 0x66);

      // Act
      const result = sut(text, 0, 0, 4);

      // Assert
      expect([...result]).toEqual([0x61, 0x62, 0x80, 0x0a, 0x63, 0x64, 0x0a, 0x65, 0x66]);
    });
  });

  describe('Given control characters, When wrapping', () => {
    it('Then they take no column', () => {
      // Arrange
      const sut = wrapText;

      // Act
      const result = sut(encode('\x01\x01\x01\x01 b c'), 0, 0, 5);

      // Assert
      expect(decode(result)).toBe('\x01\x01\x01\x01 b c');
    });
  });

  describe('Given colour escapes, When wrapping', () => {
    it.each([
      ['\x1b[31mab cd ef', 4, '\x1b[31mab\ncd\nef'],
      ['a\x1b[1mb cd ef', 4, 'a\x1b[1mb\ncd\nef'],
      ['ab\x1b[31m cd', 2, 'ab\x1b[31m\ncd'],
      ['\x1b[31mab cd ef\x1b[m', 5, '\x1b[31mab cd\nef\x1b[m'],
    ])('Then %j at width %i takes no column', (text, width, expected) => {
      // Arrange
      const sut = wrapText;

      // Act
      const result = sut(encode(text), 0, 0, width);

      // Assert
      expect(decode(result)).toBe(expected);
    });
  });

  describe('Given an escape that is not a colour sequence, When wrapping', () => {
    it.each([
      ['\x1b[31 ab', 4, '\x1b[31\nab'],
      ['\x1b[3;1xab cd', 5, '\x1b[3;1xab\ncd'],
      ['\x1bab cd', 4, '\x1bab cd'],
      ['\x1bab cd', 3, '\x1bab\ncd'],
    ])('Then %j counts its bytes at width %i', (text, width, expected) => {
      // Arrange
      const sut = wrapText;

      // Act
      const result = sut(encode(text), 0, 0, width);

      // Assert
      expect(decode(result)).toBe(expected);
    });
  });

  describe('Given a NUL byte, When wrapping', () => {
    it('Then the text ends there', () => {
      // Arrange
      const sut = wrapText;

      // Act
      const result = sut(encode('ab cd ef\0gh ij'), 0, 0, 5);

      // Assert
      expect(decode(result)).toBe('ab cd\nef');
    });

    it('Then it ends an unwrapped text as well', () => {
      // Arrange
      const sut = wrapText;

      // Act
      const result = sut(encode('ab\0cd'), 1, 1, 0);

      // Assert
      expect(decode(result)).toBe(' ab');
    });
  });
});

describe('parseWrapLayout', () => {
  const parse = (format: string) => parseWrapLayout(encode(format), 0);

  describe('Given a well-formed argument list, When parsing', () => {
    it.each([
      ['w(10,2,4)', { width: 10, indent1: 2, indent2: 4 }],
      ['w(10,2)', { width: 10, indent1: 2, indent2: 0 }],
      ['w(10)', { width: 10, indent1: 0, indent2: 0 }],
      ['w()', { width: 0, indent1: 0, indent2: 0 }],
      ['w(,2)', { width: 0, indent1: 2, indent2: 0 }],
      ['w( 5,0,0)', { width: 5, indent1: 0, indent2: 0 }],
      ['w(+5)', { width: 5, indent1: 0, indent2: 0 }],
      ['w(-0,1)', { width: 0, indent1: 1, indent2: 0 }],
      ['w(16384,16384,16384)', { width: 16384, indent1: 16384, indent2: 16384 }],
    ])('Then %s yields %j', (format, layout) => {
      // Arrange
      const sut = parse;

      // Act
      const result = sut(format);

      // Assert
      expect(result).toEqual({ layout, length: format.length });
    });

    it('Then the length stops at the first closing parenthesis', () => {
      // Arrange
      const sut = parse;

      // Act
      const result = sut('w(5)ab)');

      // Assert
      expect(result?.length).toBe(4);
    });
  });

  describe('Given a malformed argument list, When parsing', () => {
    it.each([
      'w',
      'w5',
      'w(5',
      'w(5,0,0',
      'w(5,x)',
      'w(5,0,0,1)',
      'w(5x)',
      'w(16385)',
      'w(1,16385)',
      'w(1,1,16385)',
      'w(-5)',
      'w(1000000)',
    ])('Then %s is declined', (format) => {
      // Arrange
      const sut = parse;

      // Act
      const result = sut(format);

      // Assert
      expect(result).toBeUndefined();
    });
  });
});

describe('rewrapTail', () => {
  const layout = (width: number, indent1: number, indent2: number): WrapLayout => ({
    width,
    indent1,
    indent2,
  });

  describe('Given the same layout as the current one, When rewrapping', () => {
    it('Then nothing is wrapped and the state is unchanged', () => {
      // Arrange
      const sut = rewrapTail;
      const pieces = [encode('ab cd ef')];

      // Act
      const result = sut(pieces, NO_WRAPPING, layout(0, 0, 0));

      // Assert
      expect(result).toBe(NO_WRAPPING);
      expect(pieces.map(decode)).toEqual(['ab cd ef']);
    });
  });

  describe('Given text since the last layout, When rewrapping', () => {
    it('Then only that tail is wrapped and the next tail starts after it', () => {
      // Arrange
      const sut = rewrapTail;
      const pieces = [encode('xx'), encode('ab cd')];
      const current = { layout: layout(4, 1, 1), start: 2 };

      // Act
      const result = sut(pieces, current, layout(0, 0, 0));

      // Assert
      expect(decode(Uint8Array.from(pieces.flatMap((piece) => [...piece])))).toBe('xx ab\n cd');
      expect(result).toEqual({ layout: layout(0, 0, 0), start: 9 });
    });

    it('Then a tail already consumed is left alone', () => {
      // Arrange
      const sut = rewrapTail;
      const pieces = [encode('ab cd')];
      const current = { layout: layout(2, 0, 0), start: 5 };

      // Act
      const result = sut(pieces, current, layout(3, 0, 0));

      // Assert
      expect(pieces.map(decode)).toEqual(['ab cd']);
      expect(result).toEqual({ layout: layout(3, 0, 0), start: 5 });
    });
  });
});
