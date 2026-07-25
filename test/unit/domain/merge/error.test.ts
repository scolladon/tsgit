import { describe, expect, it } from 'vitest';
import type { TsgitErrorData } from '../../../../src/domain/error.js';
import { invalidMergeInput, invalidMergeTree } from '../../../../src/domain/merge/error.js';
import { assertExhaustiveSwitch } from '../exhaustiveness.js';

describe('merge error', () => {
  describe('factory functions', () => {
    describe("Given invalidMergeTree('too large')", () => {
      describe('When checking error.data', () => {
        it("Then code is 'INVALID_MERGE_TREE' and reason preserved", () => {
          // Arrange & Act
          const result = invalidMergeTree('too large');

          // Assert
          expect(result.data).toEqual({
            code: 'INVALID_MERGE_TREE',
            reason: 'too large',
          });
        });
      });
    });

    describe("Given invalidMergeInput('duplicate conflict path')", () => {
      describe('When checking error.data', () => {
        it("Then code is 'INVALID_MERGE_INPUT' and reason preserved", () => {
          // Arrange & Act
          const result = invalidMergeInput('duplicate conflict path');

          // Assert
          expect(result.data).toEqual({
            code: 'INVALID_MERGE_INPUT',
            reason: 'duplicate conflict path',
          });
        });
      });
    });
  });

  describe('TsgitError class', () => {
    describe('Given a merge TsgitError', () => {
      describe('When checking instanceof Error', () => {
        it('Then returns true', () => {
          // Arrange & Act
          const result = invalidMergeTree('bad');

          // Assert
          expect(result).toBeInstanceOf(Error);
        });
      });
      describe('When accessing .name', () => {
        it("Then equals 'TsgitError'", () => {
          // Arrange & Act
          const result = invalidMergeInput('bad');

          // Assert
          expect(result.name).toBe('TsgitError');
        });
      });
      describe('When switching on data.code in exhaustive switch', () => {
        it('Then all 29 cases handleable', () => {
          // Arrange
          const result = invalidMergeTree('test');

          // Act
          const data: TsgitErrorData = result.data;

          // Assert
          assertExhaustiveSwitch(data);
        });
      });
    });

    describe('Given invalidMergeTree', () => {
      describe('When accessing .message', () => {
        it('Then contains code and reason', () => {
          // Arrange & Act
          const result = invalidMergeTree('over MAX_FLAT_TREE_ENTRIES');

          // Assert
          expect(result.message).toContain('INVALID_MERGE_TREE');
          expect(result.message).toContain('invalid merge tree: over MAX_FLAT_TREE_ENTRIES');
        });
      });
    });

    describe('Given invalidMergeInput', () => {
      describe('When accessing .message', () => {
        it('Then contains code and reason', () => {
          // Arrange & Act
          const result = invalidMergeInput('oversize content');

          // Assert
          expect(result.message).toContain('INVALID_MERGE_INPUT');
          expect(result.message).toContain('invalid merge input: oversize content');
        });
      });
    });
  });
});
