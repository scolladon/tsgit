import { describe, expect, it } from 'vitest';

import { sqQuote } from '../../../../../src/application/primitives/internal/shell-quote.js';

describe('sqQuote', () => {
  describe('Given an empty string', () => {
    describe('When quoted', () => {
      it('Then it becomes an empty quoted token', () => {
        // Arrange
        const sut = sqQuote;

        // Act
        const result = sut('');

        // Assert
        expect(result).toBe("''");
      });
    });
  });

  describe('Given a plain value with no special characters', () => {
    describe('When quoted', () => {
      it('Then it is wrapped in single quotes', () => {
        // Arrange
        const sut = sqQuote;

        // Act
        const result = sut('plain');

        // Assert
        expect(result).toBe("'plain'");
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

  describe('Given a value containing shell redirection metacharacters', () => {
    describe('When quoted', () => {
      it('Then the angle brackets are preserved verbatim inside the quotes', () => {
        // Arrange
        const sut = sqQuote;

        // Act
        const result = sut('a <b>');

        // Assert
        expect(result).toBe("'a <b>'");
      });
    });
  });

  describe('Given a value containing a shell command-injection payload', () => {
    describe('When quoted', () => {
      it('Then the payload is wrapped as a single literal token, not executed', () => {
        // Arrange
        const sut = sqQuote;

        // Act
        const result = sut('x; rm -rf /');

        // Assert
        expect(result).toBe("'x; rm -rf /'");
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
