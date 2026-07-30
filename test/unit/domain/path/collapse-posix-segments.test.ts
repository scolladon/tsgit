import { describe, expect, it } from 'vitest';
import { collapsePosixSegments } from '../../../../src/domain/path/collapse-posix-segments.js';

describe('collapsePosixSegments', () => {
  describe('Given a path with a duplicate-slash (empty) segment', () => {
    describe('When collapsed', () => {
      it('Then the empty segment is dropped', () => {
        // Arrange
        const sut = collapsePosixSegments;

        // Act
        const result = sut('/a//b');

        // Assert
        expect(result).toBe('/a/b');
      });
    });
  });

  describe('Given a path with a "." segment', () => {
    describe('When collapsed', () => {
      it('Then the dot segment is dropped', () => {
        // Arrange
        const sut = collapsePosixSegments;

        // Act
        const result = sut('/a/./b');

        // Assert
        expect(result).toBe('/a/b');
      });
    });
  });

  describe('Given a path with a ".." segment', () => {
    describe('When collapsed', () => {
      it('Then the preceding segment is popped', () => {
        // Arrange
        const sut = collapsePosixSegments;

        // Act
        const result = sut('/a/b/../c');

        // Assert
        expect(result).toBe('/a/c');
      });
    });
  });

  describe('Given a ".." segment with nothing left to pop at the root', () => {
    describe('When collapsed', () => {
      it('Then the pop is clamped and the result stays rooted', () => {
        // Arrange
        const sut = collapsePosixSegments;

        // Act
        const result = sut('/../a');

        // Assert
        expect(result).toBe('/a');
      });
    });
  });

  describe('Given a path made only of plain segments', () => {
    describe('When collapsed', () => {
      it('Then it is returned unchanged', () => {
        // Arrange
        const sut = collapsePosixSegments;

        // Act
        const result = sut('/a/b/c');

        // Assert
        expect(result).toBe('/a/b/c');
      });
    });
  });
});
