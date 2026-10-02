import { describe, expect, it } from 'vitest';
import { expandFormatSubst } from '../../../../src/domain/pretty/format-subst.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

const upperCaseFormat = (accumulated: Uint8Array, fmt: Uint8Array): Uint8Array =>
  concat(accumulated, encode(`<${decode(fmt)}>`));

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
