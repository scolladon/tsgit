import { describe, expect, it } from 'vitest';
import { padValue, parsePadding } from '../../../../src/domain/pretty/padding.js';
import { FORMATTING_LIMIT } from '../../../../src/domain/pretty/wrap.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('parsePadding', () => {
  describe('Given a well-formed placeholder, When parsing', () => {
    it.each([
      ['<(8)', { width: 8, fromColumn: false, align: 'text-left' }, undefined, 4],
      ['>(8)', { width: 8, fromColumn: false, align: 'text-right' }, undefined, 4],
      ['><(9)', { width: 9, fromColumn: false, align: 'centered' }, undefined, 5],
      ['>>(7)', { width: 7, fromColumn: false, align: 'text-right-stealing' }, undefined, 5],
      ['<|(12)', { width: 12, fromColumn: true, align: 'text-left' }, undefined, 6],
      ['<(3,trunc)', { width: 3, fromColumn: false, align: 'text-left' }, 'right', 10],
      ['<(3,ltrunc)', { width: 3, fromColumn: false, align: 'text-left' }, 'left', 11],
      ['<(3,mtrunc)', { width: 3, fromColumn: false, align: 'text-left' }, 'middle', 11],
      ['<(8x)', { width: 8, fromColumn: false, align: 'text-left' }, undefined, 5],
      ['<( +8)', { width: 8, fromColumn: false, align: 'text-left' }, undefined, 6],
    ])('Then %s is a request with its truncation', (source, request, truncate, length) => {
      // Arrange
      const sut = parsePadding;

      // Act
      const result = sut(encode(`${source}tail`), 0);

      // Assert
      expect(result).toEqual({ request, truncate, length });
    });
  });

  describe('Given a width the placeholder cannot honour, When parsing', () => {
    it.each([
      '<(0)',
      '<(x)',
      '<()',
      '<(-3)',
      '<(8',
      '<',
      '<8',
      '>x',
      '<(16385)',
      '<(-16385)',
      'x',
      '<(-99999999999999999999)',
    ])('Then %s is not a placeholder at all', (source) => {
      // Arrange
      const sut = parsePadding;

      // Act
      const result = sut(encode(source), 0);

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('Given the formatting limit, When parsing', () => {
    it('Then the positive limit is accepted', () => {
      // Arrange
      const sut = parsePadding;

      // Act
      const result = sut(encode(`<|(${FORMATTING_LIMIT})`), 0);

      // Assert
      expect(result?.request.width).toBe(FORMATTING_LIMIT);
    });

    it('Then the negative limit is read but has no column to reach', () => {
      // Arrange
      const sut = parsePadding;

      // Act
      const result = sut(encode(`<|(-${FORMATTING_LIMIT})`), 0);

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('Given a column relative to the terminal, When parsing', () => {
    it('Then a negative column counts back from 80 columns', () => {
      // Arrange
      const sut = parsePadding;

      // Act
      const result = sut(encode('<|(-70)'), 0);

      // Assert
      expect(result?.request).toEqual({ width: 10, fromColumn: true, align: 'text-left' });
    });

    it('Then a column landing on zero is no column at all', () => {
      // Arrange
      const sut = parsePadding;

      // Act
      const result = sut(encode('<|(-80)'), 0);

      // Assert
      expect(result?.request).toEqual({ width: 0, fromColumn: false, align: 'text-left' });
    });

    it('Then a column left of the margin is not a placeholder', () => {
      // Arrange
      const sut = parsePadding;

      // Act
      const result = sut(encode('<|(-81)'), 0);

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('Given a malformed truncation, When parsing', () => {
    it.each(['<(8,foo)', '<(8,)', '<(8,trunc', '<(8,trunc )'])(
      'Then %s sets the request yet stays literal',
      (source) => {
        // Arrange
        const sut = parsePadding;

        // Act
        const result = sut(encode(source), 0);

        // Assert
        expect(result).toEqual({
          request: { width: 8, fromColumn: false, align: 'text-left' },
          truncate: undefined,
          length: 0,
        });
      },
    );
  });

  describe('Given a long number, When parsing', () => {
    it('Then the width wraps to a C int as git stores it', () => {
      // Arrange
      const sut = parsePadding;

      // Act
      const result = sut(encode('<(4294967304)'), 0);

      // Assert
      expect(result?.request.width).toBe(8);
    });

    it('Then a number past a C long reads as minus one', () => {
      // Arrange
      const sut = parsePadding;

      // Act
      const result = sut(encode('<(99999999999999999999)'), 0);

      // Assert
      expect(result).toBeUndefined();
    });
  });
});

const padded = (
  head: string,
  value: string,
  request: Parameters<typeof padValue>[2],
  truncate: Parameters<typeof padValue>[3] = 'none',
): string => {
  const result = padValue(encode(head), encode(value), request, truncate);
  return decode(result.head) + decode(result.body);
};

const request = (
  width: number,
  align: Parameters<typeof padValue>[2]['align'] = 'text-left',
  fromColumn = false,
): Parameters<typeof padValue>[2] => ({ width, fromColumn, align });

describe('padValue', () => {
  describe('Given a value narrower than the width, When padding', () => {
    it.each([
      ['text-left', 'Alice   '],
      ['text-right', '   Alice'],
      ['centered', ' Alice  '],
    ] as const)('Then %s places it with the rest as spaces', (align, expected) => {
      // Arrange
      const sut = padded;

      // Act
      const result = sut('', 'Alice', request(8, align));

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe('Given a value wider than the width, When padding', () => {
    it('Then without truncation it stays whole', () => {
      // Arrange
      const sut = padded;

      // Act
      const result = sut('', 'Alice', request(3));

      // Assert
      expect(result).toBe('Alice');
    });

    it.each([
      [3, 'A..'],
      [4, 'Al..'],
      [2, '..'],
      [1, '..'],
    ])('Then trunc to %i columns ends in two dots', (width, expected) => {
      // Arrange
      const sut = padded;

      // Act
      const result = sut('', 'Alice', request(width), 'right');

      // Assert
      expect(result).toBe(expected);
    });

    it('Then a value exactly the width is neither padded nor truncated', () => {
      // Arrange
      const sut = padded;

      // Act
      const result = sut('', 'Alice', request(5), 'right');

      // Assert
      expect(result).toBe('Alice');
    });
  });

  describe('Given a column, When padding', () => {
    it.each([
      ['xy', 'abc', 6, 1],
      ['xy', 'abc', 5, 0],
      ['xy', 'abc', 4, 0],
      ['xy\ncd', 'q', 6, 3],
    ])('Then %j before %j reaches column %i', (head, value, column, trailing) => {
      // Arrange
      const sut = padded;

      // Act
      const result = sut(head, value, request(column, 'text-left', true));

      // Assert
      expect(result).toBe(`${head}${value}${' '.repeat(trailing)}`);
    });
  });

  describe('Given East-Asian wide input, When padding', () => {
    const NAME = '日本語テスト';

    it.each([
      [5, 'right', '日本..'],
      [6, 'right', '日本..'],
      [7, 'left', '..スト'],
      [7, 'middle', '日..ト'],
      [8, 'middle', '日本..ト'],
    ] as const)(
      'Then %i columns of %s truncation never split a character',
      (width, how, expected) => {
        // Arrange
        const sut = padded;

        // Act
        const result = sut('', NAME, request(width), how);

        // Assert
        expect(result).toBe(expected);
      },
    );

    it('Then padding counts two columns per wide character', () => {
      // Arrange
      const sut = padded;

      // Act
      const result = sut('', NAME, request(14, 'text-right'));

      // Assert
      expect(result).toBe(`  ${NAME}`);
    });
  });

  describe('Given colour escapes, When padding', () => {
    const RED = '\x1b[31m';
    const RESET = '\x1b[m';

    it('Then they take no column and survive truncation', () => {
      // Arrange
      const sut = padded;

      // Act
      const result = sut('', `${RED}日本語テスト`, request(5), 'left');

      // Assert
      expect(result).toBe(`${RED}..ト`);
    });

    it('Then a column ignores the escapes already emitted', () => {
      // Arrange
      const sut = padded;

      // Act
      const result = sut(`${RED}ab${RESET}`, 'c', request(5, 'text-left', true));

      // Assert
      expect(result).toBe(`${RED}ab${RESET}c  `);
    });
  });

  describe('Given invalid UTF-8, When padding', () => {
    it('Then each byte counts one column', () => {
      // Arrange
      const sut = padValue;

      // Act
      const result = sut(new Uint8Array(), Uint8Array.of(0xff, 0xfe), request(4), 'none');

      // Assert
      expect(result.body).toEqual(Uint8Array.of(0xff, 0xfe, 0x20, 0x20));
    });

    it('Then truncation leaves the value alone', () => {
      // Arrange
      const sut = padValue;

      // Act
      const result = sut(new Uint8Array(), Uint8Array.of(0xff, 0xfe, 0xfd), request(2), 'right');

      // Assert
      expect(result.body).toEqual(Uint8Array.of(0xff, 0xfe, 0xfd));
    });
  });

  describe('Given trailing spaces before a stealing pad, When padding', () => {
    it.each([
      ['ab     ', 'abcd', 2, 'ab   '],
      ['ab  ', 'abcd', 2, 'ab'],
      ['a    ', 'abcd', 2, 'a  '],
      ['ab   ', 'tuv', 4, 'ab    '],
      ['ab', 'tuv', 4, 'ab '],
      ['', 'tuv', 6, '   '],
      ['ab', 'abcd', 2, 'ab'],
      ['abm', 'abcd', 2, 'abm'],
    ])('Then %j before %j at %i keeps %j', (head, value, width, kept) => {
      // Arrange
      const sut = padded;

      // Act
      const result = sut(head, value, request(width, 'text-right-stealing'));

      // Assert
      expect(result).toBe(`${kept}${value}`);
    });

    it('Then the escapes before the stolen spaces move with the value', () => {
      // Arrange
      const sut = padded;

      // Act
      const result = sut('ab  \x1b[31m ', 'abcd', request(2, 'text-right-stealing'));

      // Assert
      expect(result).toBe('ab \x1b[31m' + 'abcd');
    });
  });
});
