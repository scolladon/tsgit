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
          const result = invalidIndexHeader('bad magic');

          // Assert
          expect(result.data).toEqual({ code: 'INVALID_INDEX_HEADER', reason: 'bad magic' });
        });
      });
    });

    describe("Given invalidIndexEntry(42, 'truncated')", () => {
      describe('When checking error.data', () => {
        it('Then offset is 42 and reason matches', () => {
          // Arrange & Act
          const result = invalidIndexEntry(42, 'truncated');

          // Assert
          expect(result.data).toEqual({
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
          const result = invalidIndexHeader('bad');

          // Assert
          expect(result).toBeInstanceOf(Error);
        });
      });
      describe('When accessing .name', () => {
        it("Then equals 'TsgitError'", () => {
          // Arrange & Act
          const result = invalidIndexHeader('bad');

          // Assert
          expect(result.name).toBe('TsgitError');
        });
      });
      describe('When accessing .message', () => {
        it('Then contains the error code', () => {
          // Arrange & Act
          const result = invalidIndexHeader('bad');

          // Assert
          expect(result.message).toContain('INVALID_INDEX_HEADER');
        });
      });
      describe('When switching on data.code in exhaustive switch', () => {
        it('Then all 29 cases handleable', () => {
          // Arrange
          const result = invalidIndexHeader('test');

          // Act
          const data: TsgitErrorData = result.data;

          // Assert
          assertExhaustiveSwitch(data);
        });
      });
    });
  });
});
