import { describe, expect, it } from 'vitest';
import type { TsgitErrorData } from '../../../../src/domain/error.js';
import { invalidIndexEntry, invalidIndexHeader } from '../../../../src/domain/git-index/error.js';
import { assertExhaustiveSwitch } from '../exhaustiveness.js';

describe('git-index error', () => {
  describe('factory functions', () => {
    describe("Given invalidIndexHeader('bad magic')", () => {
      describe('When checking error.data', () => {
        it("Then code is 'INVALID_INDEX_HEADER' and reason matches", () => {
          // Arrange & Act
          const sut = invalidIndexHeader('bad magic');

          // Assert
          expect(sut.data).toEqual({ code: 'INVALID_INDEX_HEADER', reason: 'bad magic' });
        });
      });
    });

    describe("Given invalidIndexEntry(42, 'truncated')", () => {
      describe('When checking error.data', () => {
        it('Then offset is 42 and reason matches', () => {
          // Arrange & Act
          const sut = invalidIndexEntry(42, 'truncated');

          // Assert
          expect(sut.data).toEqual({
            code: 'INVALID_INDEX_ENTRY',
            offset: 42,
            reason: 'truncated',
          });
        });
      });
    });
  });

  describe('TsgitError class', () => {
    describe('Given an index TsgitError', () => {
      describe('When checking instanceof Error', () => {
        it('Then returns true', () => {
          // Arrange & Act
          const sut = invalidIndexHeader('bad');

          // Assert
          expect(sut).toBeInstanceOf(Error);
        });
      });
      describe('When accessing .name', () => {
        it("Then equals 'TsgitError'", () => {
          // Arrange & Act
          const sut = invalidIndexHeader('bad');

          // Assert
          expect(sut.name).toBe('TsgitError');
        });
      });
      describe('When accessing .message', () => {
        it('Then contains the error code', () => {
          // Arrange & Act
          const sut = invalidIndexHeader('bad');

          // Assert
          expect(sut.message).toContain('INVALID_INDEX_HEADER');
        });
      });
      describe('When switching on data.code in exhaustive switch', () => {
        it('Then all 29 cases handleable', () => {
          // Arrange
          const sut = invalidIndexHeader('test');

          // Act & Assert
          const data: TsgitErrorData = sut.data;
          // Assert
          assertExhaustiveSwitch(data);
        });
      });
    });
  });
});
