import { describe, expect, it } from 'vitest';
import { commonAncestor } from '../../../src/repository/common-ancestor.js';

describe('commonAncestor', () => {
  describe('Given a path and a sibling', () => {
    describe('When commonAncestor runs', () => {
      it('Then it returns the shared parent', () => {
        // Arrange
        const sut = ['/tmp/repo', '/tmp/repo-wt'];

        // Act
        const result = commonAncestor(sut);

        // Assert
        expect(result).toBe('/tmp');
      });
    });
  });

  describe('Given a path and its descendant', () => {
    describe('When commonAncestor runs', () => {
      it('Then it returns the ancestor itself', () => {
        // Arrange
        const sut = ['/a/b', '/a/b/c/d'];

        // Act
        const result = commonAncestor(sut);

        // Assert
        expect(result).toBe('/a/b');
      });
    });
  });

  describe('Given paths sharing no prefix', () => {
    describe('When commonAncestor runs', () => {
      it('Then it returns the root', () => {
        // Arrange
        const sut = ['/a/x', '/b/y'];

        // Act
        const result = commonAncestor(sut);

        // Assert
        expect(result).toBe('/');
      });
    });
  });

  describe('Given a single path', () => {
    describe('When commonAncestor runs', () => {
      it('Then it returns that path', () => {
        // Arrange
        const sut = ['/a/b/c'];

        // Act
        const result = commonAncestor(sut);

        // Assert
        expect(result).toBe('/a/b/c');
      });
    });
  });

  describe('Given no paths', () => {
    describe('When commonAncestor runs', () => {
      it('Then it returns the root', () => {
        // Arrange
        const sut: ReadonlyArray<string> = [];

        // Act
        const result = commonAncestor(sut);

        // Assert
        expect(result).toBe('/');
      });
    });
  });
});
