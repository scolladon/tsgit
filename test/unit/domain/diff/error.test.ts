import { describe, expect, it } from 'vitest';
import { invalidDiffInput, invalidTreeForDiff } from '../../../../src/domain/diff/error.js';
import type { TsgitErrorData } from '../../../../src/domain/error.js';
import { assertExhaustiveSwitch } from '../exhaustiveness.js';

describe('diff error', () => {
  describe('factory functions', () => {
    it("Given invalidTreeForDiff('too many entries'), When checking error.data, Then code is 'INVALID_TREE_FOR_DIFF' and reason preserved", () => {
      // Arrange & Act
      const sut = invalidTreeForDiff('too many entries');

      // Assert
      expect(sut.data).toEqual({
        code: 'INVALID_TREE_FOR_DIFF',
        reason: 'too many entries',
      });
    });

    it("Given invalidDiffInput('duplicate conflict path'), When checking error.data, Then code is 'INVALID_DIFF_INPUT' and reason preserved", () => {
      // Arrange & Act
      const sut = invalidDiffInput('duplicate conflict path');

      // Assert
      expect(sut.data).toEqual({
        code: 'INVALID_DIFF_INPUT',
        reason: 'duplicate conflict path',
      });
    });
  });

  describe('TsgitError class', () => {
    it('Given a diff TsgitError, When checking instanceof Error, Then returns true', () => {
      // Arrange & Act
      const sut = invalidTreeForDiff('bad');

      // Assert
      expect(sut).toBeInstanceOf(Error);
    });

    it("Given a diff TsgitError, When accessing .name, Then equals 'TsgitError'", () => {
      // Arrange & Act
      const sut = invalidTreeForDiff('bad');

      // Assert
      expect(sut.name).toBe('TsgitError');
    });

    it('Given a diff TsgitError, When accessing .message, Then contains the error code', () => {
      // Arrange & Act
      const sut = invalidTreeForDiff('bad');

      // Assert
      expect(sut.message).toContain('INVALID_TREE_FOR_DIFF');
    });

    it('Given a diff TsgitError, When accessing .message, Then contains reason text', () => {
      // Arrange & Act
      const sut = invalidTreeForDiff('over MAX_FLAT_TREE_ENTRIES');

      // Assert
      expect(sut.message).toContain('invalid tree for diff: over MAX_FLAT_TREE_ENTRIES');
    });

    it('Given a diff TsgitError, When switching on data.code in exhaustive switch, Then all 29 cases handleable', () => {
      // Arrange
      const sut = invalidTreeForDiff('test');

      // Act & Assert
      const data: TsgitErrorData = sut.data;
      // Assert
      assertExhaustiveSwitch(data);
    });
  });
});
