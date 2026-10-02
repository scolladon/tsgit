import { describe, expect, it } from 'vitest';
import { type Expansion, expandFormatSubst } from '../../../../src/domain/pretty/format-subst.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

const plain = (bytes: Uint8Array): Expansion => ({
  bytes,
  parsedHeader: false,
  encoding: undefined,
});

const upperCaseFormat = (accumulated: Uint8Array, fmt: Uint8Array): Expansion =>
  plain(concat(accumulated, encode(`<${decode(fmt)}>`)));

describe('Given a blob with $Format: placeholders', () => {
  describe('When the terminator is on a later line', () => {
    it('Then the format spans newlines and the next $Format: is not re-scanned', () => {
      // Arrange
      const sut = expandFormatSubst;
      const blob = encode('unterminated $Format:%H\n$Format:$ empty');

      // Act
      const result = sut(blob, upperCaseFormat);

      // Assert
      expect(decode(result)).toBe('unterminated <%H\n>Format:$ empty');
    });
  });

  describe('When no later $ exists', () => {
    it('Then the tail is kept verbatim', () => {
      // Arrange
      const sut = expandFormatSubst;
      const blob = encode('tail $Format:%H');

      // Act
      const result = sut(blob, upperCaseFormat);

      // Assert
      expect(decode(result)).toBe('tail $Format:%H');
    });
  });

  describe('When the format holds a NUL', () => {
    it('Then the format is cut at the NUL but the terminator is still the first $', () => {
      // Arrange
      const sut = expandFormatSubst;
      const blob = encode('a $Format:%h\0%H$ b');

      // Act
      const result = sut(blob, upperCaseFormat);

      // Assert
      expect(decode(result)).toBe('a <%h> b');
    });
  });

  describe('When two occurrences exist', () => {
    it('Then each is expanded with the accumulated output so far', () => {
      // Arrange
      const sut = expandFormatSubst;
      const seen: string[] = [];
      const blob = encode('x $Format:A$ y $Format:B$ z');

      // Act
      const result = sut(blob, (accumulated, fmt) => {
        seen.push(decode(accumulated));
        return upperCaseFormat(accumulated, fmt);
      });

      // Assert
      expect(decode(result)).toBe('x <A> y <B> z');
      expect(seen).toEqual(['x ', 'x <A> y ']);
    });
  });

  describe('When the placeholder is empty', () => {
    it('Then expandOne receives an empty format', () => {
      // Arrange
      const sut = expandFormatSubst;
      const blob = encode('$Format:$');

      // Act
      const result = sut(blob, upperCaseFormat);

      // Assert
      expect(decode(result)).toBe('<>');
    });
  });

  describe('When the blob is binary', () => {
    it('Then the placeholder is still expanded', () => {
      // Arrange
      const sut = expandFormatSubst;
      const blob = new Uint8Array([0, 1, ...encode('$Format:Q$'), 2, 0]);

      // Act
      const result = sut(blob, upperCaseFormat);

      // Assert
      expect([...result]).toEqual([0, 1, ...encode('<Q>'), 2, 0]);
    });
  });
});

describe('Given a commit whose encoding header is not UTF-8', () => {
  const latin1 = encode('ISO-8859-1');
  const expandWith =
    (parsedHeader: boolean, encoding: Uint8Array | undefined) =>
    (accumulated: Uint8Array, fmt: Uint8Array) => ({
      bytes: concat(accumulated, fmt.length === 0 ? new Uint8Array(0) : encode(`[${decode(fmt)}]`)),
      parsedHeader,
      encoding,
    });

  describe('When no occurrence parsed the header', () => {
    it('Then the output stays UTF-8', () => {
      // Arrange
      const sut = expandFormatSubst;
      const blob = encode('pre-é [$Format:h$] mid-é [$Format:h$]');

      // Act
      const result = sut(blob, expandWith(false, latin1));

      // Assert
      expect(decode(result)).toBe('pre-é [[h]] mid-é [[h]]');
    });
  });

  describe('When an occurrence parsed the header', () => {
    it('Then the whole accumulated buffer is transcoded and the tail stays raw', () => {
      // Arrange
      const sut = expandFormatSubst;
      const blob = encode('pre-é only\n[$Format:e$]\né');

      // Act
      const result = sut(blob, expandWith(true, latin1));

      // Assert
      expect([...result]).toEqual([
        ...encode('pre-'),
        0xe9,
        ...encode(' only\n[[e]'),
        ...encode(']\n'),
        ...encode('é'),
      ]);
    });
  });

  describe('When the commit encoding is UTF-8 in another spelling', () => {
    it('Then nothing is transcoded', () => {
      // Arrange
      const sut = expandFormatSubst;
      const blob = encode('é $Format:e$');

      // Act
      const result = sut(blob, expandWith(true, encode('utf8')));

      // Assert
      expect(decode(result)).toBe('é [e]');
    });
  });

  describe('When the commit has no encoding header', () => {
    it('Then nothing is transcoded', () => {
      // Arrange
      const sut = expandFormatSubst;
      const blob = encode('é $Format:e$');

      // Act
      const result = sut(blob, expandWith(true, undefined));

      // Assert
      expect(decode(result)).toBe('é [e]');
    });
  });

  describe('When the encoding is unknown', () => {
    it('Then the buffer is left unconverted', () => {
      // Arrange
      const sut = expandFormatSubst;
      const blob = encode('é $Format:e$');

      // Act
      const result = sut(blob, expandWith(true, encode('x-nonexistent-9')));

      // Assert
      expect(decode(result)).toBe('é [e]');
    });
  });

  describe('When the encoding is UTF-16', () => {
    it('Then the buffer gets a BOM and UTF-16 code units, the tail stays raw', () => {
      // Arrange
      const sut = expandFormatSubst;
      const blob = encode('pé $Format:e$]\n');

      // Act
      const result = sut(blob, expandWith(true, encode('UTF-16')));

      // Assert
      expect([...result]).toEqual([
        0xfe,
        0xff,
        0,
        0x70,
        0,
        0xe9,
        0,
        0x20,
        0,
        0x5b,
        0,
        0x65,
        0,
        0x5d,
        ...encode(']\n'),
      ]);
    });
  });

  describe('When a second occurrence follows a transcoded buffer', () => {
    it('Then the already converted buffer fails the UTF-8 pass and stays as is', () => {
      // Arrange
      const sut = expandFormatSubst;
      const blob = encode('é $Format:e$ $Format:e$');

      // Act
      const result = sut(blob, expandWith(true, latin1));

      // Assert
      expect([...result]).toEqual([0xe9, 0x20, ...encode('[e] [e]')]);
    });
  });
});
