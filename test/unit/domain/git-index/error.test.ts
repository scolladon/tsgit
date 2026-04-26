import { describe, expect, it } from 'vitest';
import type { TsgitErrorData } from '../../../../src/domain/error.js';
import { invalidIndexEntry, invalidIndexHeader } from '../../../../src/domain/git-index/error.js';
import { assertExhaustiveSwitch } from '../exhaustiveness.js';

describe('git-index error', () => {
  describe('factory functions', () => {
    it("Given invalidIndexHeader('bad magic'), When checking error.data, Then code is 'INVALID_INDEX_HEADER' and reason matches", () => {
      // Arrange & Act
      const sut = invalidIndexHeader('bad magic');

      // Assert
      expect(sut.data).toEqual({ code: 'INVALID_INDEX_HEADER', reason: 'bad magic' });
    });

    it("Given invalidIndexEntry(42, 'truncated'), When checking error.data, Then offset is 42 and reason matches", () => {
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

  describe('TsgitError class', () => {
    it('Given an index TsgitError, When checking instanceof Error, Then returns true', () => {
      // Arrange & Act
      const sut = invalidIndexHeader('bad');

      // Assert
      expect(sut).toBeInstanceOf(Error);
    });

    it("Given an index TsgitError, When accessing .name, Then equals 'TsgitError'", () => {
      // Arrange & Act
      const sut = invalidIndexHeader('bad');

      // Assert
      expect(sut.name).toBe('TsgitError');
    });

    it('Given an index TsgitError, When accessing .message, Then contains the error code', () => {
      // Arrange & Act
      const sut = invalidIndexHeader('bad');

      // Assert
      expect(sut.message).toContain('INVALID_INDEX_HEADER');
    });

    it('Given an index TsgitError, When switching on data.code in exhaustive switch, Then all 29 cases handleable', () => {
      // Arrange
      const sut = invalidIndexHeader('test');

      // Act & Assert
      const data: TsgitErrorData = sut.data;
      assertExhaustiveSwitch(data);
    });
  });
});
