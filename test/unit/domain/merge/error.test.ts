import { describe, expect, it } from 'vitest';
import type { TsgitErrorData } from '../../../../src/domain/error.js';
import { invalidMergeInput, invalidMergeTree } from '../../../../src/domain/merge/error.js';
import { assertExhaustiveSwitch } from '../exhaustiveness.js';

describe('merge error', () => {
  describe('factory functions', () => {
    it("Given invalidMergeTree('too large'), When checking error.data, Then code is 'INVALID_MERGE_TREE' and reason preserved", () => {
      // Arrange & Act
      const sut = invalidMergeTree('too large');

      // Assert
      expect(sut.data).toEqual({
        code: 'INVALID_MERGE_TREE',
        reason: 'too large',
      });
    });

    it("Given invalidMergeInput('duplicate conflict path'), When checking error.data, Then code is 'INVALID_MERGE_INPUT' and reason preserved", () => {
      // Arrange & Act
      const sut = invalidMergeInput('duplicate conflict path');

      // Assert
      expect(sut.data).toEqual({
        code: 'INVALID_MERGE_INPUT',
        reason: 'duplicate conflict path',
      });
    });
  });

  describe('TsgitError class', () => {
    it('Given a merge TsgitError, When checking instanceof Error, Then returns true', () => {
      // Arrange & Act
      const sut = invalidMergeTree('bad');

      // Assert
      expect(sut).toBeInstanceOf(Error);
    });

    it("Given a merge TsgitError, When accessing .name, Then equals 'TsgitError'", () => {
      // Arrange & Act
      const sut = invalidMergeInput('bad');

      // Assert
      expect(sut.name).toBe('TsgitError');
    });

    it('Given invalidMergeTree, When accessing .message, Then contains code and reason', () => {
      // Arrange & Act
      const sut = invalidMergeTree('over MAX_FLAT_TREE_ENTRIES');

      // Assert
      expect(sut.message).toContain('INVALID_MERGE_TREE');
      expect(sut.message).toContain('invalid merge tree: over MAX_FLAT_TREE_ENTRIES');
    });

    it('Given invalidMergeInput, When accessing .message, Then contains code and reason', () => {
      // Arrange & Act
      const sut = invalidMergeInput('oversize content');

      // Assert
      expect(sut.message).toContain('INVALID_MERGE_INPUT');
      expect(sut.message).toContain('invalid merge input: oversize content');
    });

    it('Given a merge TsgitError, When switching on data.code in exhaustive switch, Then all 29 cases handleable', () => {
      // Arrange
      const sut = invalidMergeTree('test');

      // Act & Assert
      const data: TsgitErrorData = sut.data;
      // Assert
      assertExhaustiveSwitch(data);
    });
  });
});
