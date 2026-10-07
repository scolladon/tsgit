import { describe, expect, it } from 'vitest';
import { asciiLower, isAsciiDigit, isAsciiSpace } from '../../../../src/domain/pretty/ascii.js';

describe('isAsciiSpace', () => {
  describe('Given a byte around the C-locale whitespace ranges, When classified', () => {
    it.each([
      { hex: '0x08', expected: false },
      { hex: '0x09', expected: true },
      { hex: '0x0a', expected: true },
      { hex: '0x0b', expected: true },
      { hex: '0x0c', expected: true },
      { hex: '0x0d', expected: true },
      { hex: '0x0e', expected: false },
      { hex: '0x1f', expected: false },
      { hex: '0x20', expected: true },
      { hex: '0x21', expected: false },
    ])('Then $hex is whitespace=$expected', ({ hex, expected }) => {
      // Arrange
      const sut = isAsciiSpace;

      // Act
      const result = sut(Number.parseInt(hex, 16));

      // Assert
      expect(result).toBe(expected);
    });
  });
});

describe('isAsciiDigit', () => {
  describe('Given a byte around the digit range, When classified', () => {
    it.each([
      { char: '/', expected: false },
      { char: '0', expected: true },
      { char: '5', expected: true },
      { char: '9', expected: true },
      { char: ':', expected: false },
    ])("Then '$char' is a digit=$expected", ({ char, expected }) => {
      // Arrange
      const sut = isAsciiDigit;

      // Act
      const result = sut(char.charCodeAt(0));

      // Assert
      expect(result).toBe(expected);
    });
  });
});

describe('asciiLower', () => {
  describe('Given text mixing ASCII letters, their neighbours and non-ASCII letters, When lowered', () => {
    it.each([
      { text: 'AZ', expected: 'az' },
      { text: '@[`{', expected: '@[`{' },
      { text: 'Hello-World 9', expected: 'hello-world 9' },
      { text: 'É', expected: 'É' },
      { text: 'ÀB', expected: 'Àb' },
    ])("Then '$text' reads '$expected'", ({ text, expected }) => {
      // Arrange
      const sut = asciiLower;

      // Act
      const result = sut(text);

      // Assert
      expect(result).toBe(expected);
    });
  });
});
