import { describe, expect, it } from 'vitest';
import { parseColorSpec } from '../../../../src/domain/pretty/color.js';

const ESC = '\x1b';
const sgr = (code: string): string => `${ESC}[${code}m`;

describe('parseColorSpec', () => {
  describe('Given a named colour, When parsing', () => {
    it.each([
      ['black', '30'],
      ['red', '31'],
      ['green', '32'],
      ['yellow', '33'],
      ['blue', '34'],
      ['magenta', '35'],
      ['cyan', '36'],
      ['white', '37'],
      ['default', '39'],
      ['RED', '31'],
    ])('Then %s is SGR %s', (spec, code) => {
      // Arrange
      const sut = parseColorSpec;

      // Act
      const result = sut(spec);

      // Assert
      expect(result).toBe(sgr(code));
    });
  });

  describe('Given a bright colour, When parsing', () => {
    it.each([
      ['brightred', '91'],
      ['brightblack', '90'],
      ['BrightWhite', '97'],
    ])('Then %s is SGR %s', (spec, code) => {
      // Arrange
      const sut = parseColorSpec;

      // Act
      const result = sut(spec);

      // Assert
      expect(result).toBe(sgr(code));
    });

    it.each(['bright', 'brightdefault'])('Then %s is rejected', (spec) => {
      // Arrange
      const sut = parseColorSpec;

      // Act
      const result = sut(spec);

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('Given a numeric colour, When parsing', () => {
    it.each([
      ['0', '30'],
      ['7', '37'],
      ['8', '90'],
      ['15', '97'],
      ['16', '38;5;16'],
      ['255', '38;5;255'],
    ])('Then %s is SGR %s', (spec, code) => {
      // Arrange
      const sut = parseColorSpec;

      // Act
      const result = sut(spec);

      // Assert
      expect(result).toBe(sgr(code));
    });

    it.each(['256', '-2', '1x'])('Then %s is rejected', (spec) => {
      // Arrange
      const sut = parseColorSpec;

      // Act
      const result = sut(spec);

      // Assert
      expect(result).toBeUndefined();
    });

    it.each(['normal', '-1'])('Then %s emits nothing', (spec) => {
      // Arrange
      const sut = parseColorSpec;

      // Act
      const result = sut(spec);

      // Assert
      expect(result).toBe('');
    });
  });

  describe('Given an RGB colour, When parsing', () => {
    it.each([
      ['#ff8000', '38;2;255;128;0'],
      ['#f80', '38;2;255;136;0'],
      ['#FF8000', '38;2;255;128;0'],
    ])('Then %s is SGR %s', (spec, code) => {
      // Arrange
      const sut = parseColorSpec;

      // Act
      const result = sut(spec);

      // Assert
      expect(result).toBe(sgr(code));
    });

    it.each(['#ff80', '#gg0000', '#12345', '#ggg'])('Then %s is rejected', (spec) => {
      // Arrange
      const sut = parseColorSpec;

      // Act
      const result = sut(spec);

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('Given a foreground and a background, When parsing', () => {
    it.each([
      ['red blue', '31;44'],
      ['red 16', '31;48;5;16'],
      ['#000 #fff', '38;2;0;0;0;48;2;255;255;255'],
      ['normal red', '41'],
      ['red normal', '31'],
    ])('Then %s is SGR %s', (spec, code) => {
      // Arrange
      const sut = parseColorSpec;

      // Act
      const result = sut(spec);

      // Assert
      expect(result).toBe(sgr(code));
    });

    it('Then a third colour is rejected', () => {
      // Arrange
      const sut = parseColorSpec;

      // Act
      const result = sut('red green blue');

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('Given attributes, When parsing', () => {
    it.each([
      ['bold', '1'],
      ['dim', '2'],
      ['italic', '3'],
      ['ul', '4'],
      ['blink', '5'],
      ['reverse', '7'],
      ['strike', '9'],
      ['nobold', '22'],
      ['no-dim', '22'],
      ['noitalic', '23'],
      ['no-ul', '24'],
      ['noblink', '25'],
      ['noreverse', '27'],
      ['nostrike', '29'],
    ])('Then %s is SGR %s', (spec, code) => {
      // Arrange
      const sut = parseColorSpec;

      // Act
      const result = sut(spec);

      // Assert
      expect(result).toBe(sgr(code));
    });

    it('Then attributes come first in ascending order, then the colors', () => {
      // Arrange
      const sut = parseColorSpec;

      // Act
      const result = sut('ul bold red blue');

      // Assert
      expect(result).toBe(sgr('1;4;31;44'));
    });

    it.each(['bogus', 'no', 'no-', 'bol'])('Then %s is rejected', (spec) => {
      // Arrange
      const sut = parseColorSpec;

      // Act
      const result = sut(spec);

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('Given reset, When parsing', () => {
    it.each([
      ['reset', sgr('')],
      ['reset red', sgr(';31')],
      ['reset bold red', sgr(';1;31')],
      ['RESET', sgr('')],
    ])('Then %s is %j', (spec, expected) => {
      // Arrange
      const sut = parseColorSpec;

      // Act
      const result = sut(spec);

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe('Given blank input, When parsing', () => {
    it.each(['', '   ', '\t'])('Then %j emits nothing', (spec) => {
      // Arrange
      const sut = parseColorSpec;

      // Act
      const result = sut(spec);

      // Assert
      expect(result).toBe('');
    });

    it('Then surrounding and repeated whitespace is ignored', () => {
      // Arrange
      const sut = parseColorSpec;

      // Act
      const result = sut('  bold \t red  ');

      // Assert
      expect(result).toBe(sgr('1;31'));
    });
  });
});
