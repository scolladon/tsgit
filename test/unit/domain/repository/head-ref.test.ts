import { describe, expect, it } from 'vitest';
import { isValidHeadContent } from '../../../../src/domain/repository/head-ref.js';

describe('isValidHeadContent', () => {
  describe('Given content is a symbolic ref with a space and a trailing newline', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns true', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('ref: refs/heads/main\n');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given content is a symbolic ref with no trailing newline', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns true', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('ref: refs/heads/main');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given content is a symbolic ref with no space after the ref: prefix', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns true', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('ref:refs/heads/main\n');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given content is a symbolic ref with several spaces after the ref: prefix', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns true', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('ref:    refs/heads/main\n');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given content is a symbolic ref whose refname contains a directory-traversal segment', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns true because the refname is not format-checked', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('ref: refs/heads/../evil\n');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given content is 40 lowercase hex characters', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns true for a detached SHA-1-width HEAD', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('a'.repeat(40));

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given content is 64 lowercase hex characters', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns true for a detached SHA-256-width HEAD', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('a'.repeat(64));

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given content is 40 lowercase hex characters with a trailing newline', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns true — real git always writes a detached HEAD this way', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut(`${'a'.repeat(40)}\n`);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given content is 64 lowercase hex characters with a trailing newline', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns true', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut(`${'a'.repeat(64)}\n`);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given content is ref: followed by a single-level name with no refs/ prefix', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns false', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('ref: main\n');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given content is 40 non-hex characters', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns false', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('z'.repeat(40));

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given content is empty', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns false', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('');

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});
