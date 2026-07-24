import { describe, expect, it } from 'vitest';

import { sqQuote } from '../../../../../src/application/primitives/internal/shell-quote.js';

describe('sqQuote', () => {
  describe('Given a value with no embedded single quote', () => {
    describe('When quoted', () => {
      it.each([
        { label: 'an empty string', input: '', expected: "''" },
        { label: 'a plain value with no special characters', input: 'plain', expected: "'plain'" },
        {
          label: 'shell redirection metacharacters',
          input: 'a <b>',
          expected: "'a <b>'",
        },
        {
          label: 'a shell command-injection payload',
          input: 'x; rm -rf /',
          expected: "'x; rm -rf /'",
        },
      ])('Then $label is wrapped verbatim in single quotes', ({ input, expected }) => {
        // Arrange
        const sut = sqQuote;

        // Act
        const result = sut(input);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a value containing an embedded single quote', () => {
    describe('When quoted', () => {
      it('Then the quote is escaped as close-quote, escaped-quote, reopen-quote', () => {
        // Arrange
        const sut = sqQuote;

        // Act
        const result = sut("O'Brien");

        // Assert
        expect(result).toBe("'O'\\''Brien'");
      });
    });
  });

  describe('Given a value containing two embedded single quotes', () => {
    describe('When quoted', () => {
      it('Then each quote is escaped independently', () => {
        // Arrange
        const sut = sqQuote;

        // Act
        const result = sut("it's Bob's");

        // Assert
        expect(result).toBe("'it'\\''s Bob'\\''s'");
      });
    });
  });
});
