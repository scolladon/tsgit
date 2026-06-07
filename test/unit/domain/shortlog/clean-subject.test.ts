import { describe, expect, it } from 'vitest';
import { cleanShortlogSubject } from '../../../../src/domain/shortlog/clean-subject.js';

describe('cleanShortlogSubject', () => {
  describe('Given a plain single-line subject, When cleaned', () => {
    it('Then it is returned verbatim', () => {
      // Arrange
      const sut = cleanShortlogSubject;

      // Act
      const result = sut('a normal subject');

      // Assert
      expect(result).toBe('a normal subject');
    });
  });

  describe('Given a multi-line subject paragraph, When cleaned', () => {
    it('Then the lines are folded with a single space', () => {
      // Arrange
      const sut = cleanShortlogSubject;

      // Act
      const result = sut('Add\nfeature\n\nbody');

      // Assert
      expect(result).toBe('Add feature');
    });
  });

  describe('Given a message with leading blank lines, When cleaned', () => {
    it('Then the leading blanks are skipped', () => {
      // Arrange
      const sut = cleanShortlogSubject;

      // Act
      const result = sut('\n\n  x');

      // Assert
      expect(result).toBe('x');
    });
  });

  describe('Given a "[PATCH]" prefix, When cleaned', () => {
    it('Then the bracketed prefix is stripped', () => {
      // Arrange
      const sut = cleanShortlogSubject;

      // Act
      const result = sut('[PATCH] x');

      // Assert
      expect(result).toBe('x');
    });
  });

  describe('Given a "[PATCH v2]" prefix, When cleaned', () => {
    it('Then the whole bracket is stripped', () => {
      // Arrange
      const sut = cleanShortlogSubject;

      // Act
      const result = sut('[PATCH v2] x');

      // Assert
      expect(result).toBe('x');
    });
  });

  describe('Given a "[PATCH...]" prefix with a later bracket, When cleaned', () => {
    it('Then it strips through the first close bracket only', () => {
      // Arrange
      const sut = cleanShortlogSubject;

      // Act
      const result = sut('[PATCHwork] y] z');

      // Assert
      expect(result).toBe('y] z');
    });
  });

  describe('Given "[PATCHv2]" immediately followed by content, When cleaned', () => {
    it('Then it strips to the first close bracket', () => {
      // Arrange
      const sut = cleanShortlogSubject;

      // Act
      const result = sut('[PATCHv2]x] w');

      // Assert
      expect(result).toBe('x] w');
    });
  });

  describe('Given a non-PATCH bracketed prefix, When cleaned', () => {
    it('Then it is left untouched', () => {
      // Arrange
      const sut = cleanShortlogSubject;

      // Act
      const result = sut('[BUGFIX] x');

      // Assert
      expect(result).toBe('[BUGFIX] x');
    });
  });

  describe('Given a lowercase "[patch]" prefix, When cleaned', () => {
    it('Then it is left untouched (case-sensitive)', () => {
      // Arrange
      const sut = cleanShortlogSubject;

      // Act
      const result = sut('[patch] x');

      // Assert
      expect(result).toBe('[patch] x');
    });
  });

  describe('Given a "[PATCH" prefix with no closing bracket, When cleaned', () => {
    it('Then it is left untouched', () => {
      // Arrange
      const sut = cleanShortlogSubject;

      // Act
      const result = sut('[PATCH no-close');

      // Assert
      expect(result).toBe('[PATCH no-close');
    });
  });

  describe('Given "[PATCH]" then a blank line then a body, When cleaned', () => {
    it('Then the subject is empty (body excluded)', () => {
      // Arrange
      const sut = cleanShortlogSubject;

      // Act
      const result = sut('[PATCH]\n\nbody');

      // Assert
      expect(result).toBe('');
    });
  });

  describe('Given "[PATCH]" then a single newline then a body, When cleaned', () => {
    it('Then the folded body becomes the subject', () => {
      // Arrange
      const sut = cleanShortlogSubject;

      // Act
      const result = sut('[PATCH]\nbody');

      // Assert
      expect(result).toBe('body');
    });
  });

  describe('Given "[PATCH]" with trailing spaces then an indented next line, When cleaned', () => {
    it('Then the prefix and intervening whitespace are stripped', () => {
      // Arrange
      const sut = cleanShortlogSubject;

      // Act
      const result = sut('[PATCH]   \n  next');

      // Assert
      expect(result).toBe('next');
    });
  });

  describe('Given a bare "[PATCH]" with no content, When cleaned', () => {
    it('Then the subject is empty', () => {
      // Arrange
      const sut = cleanShortlogSubject;

      // Act
      const result = sut('[PATCH]');

      // Assert
      expect(result).toBe('');
    });
  });

  describe('Given an empty message, When cleaned', () => {
    it('Then the subject is empty', () => {
      // Arrange
      const sut = cleanShortlogSubject;

      // Act
      const result = sut('');

      // Assert
      expect(result).toBe('');
    });
  });
});
