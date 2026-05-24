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
          const sut = invalidMergeTree('too large');

          // Assert
          expect(sut.data).toEqual({
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
          const sut = invalidMergeInput('duplicate conflict path');

          // Assert
          expect(sut.data).toEqual({
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
          const sut = invalidMergeTree('bad');

          // Assert
          expect(sut).toBeInstanceOf(Error);
        });
      });
      describe('When accessing .name', () => {
        it("Then equals 'TsgitError'", () => {
          // Arrange & Act
          const sut = invalidMergeInput('bad');

          // Assert
          expect(sut.name).toBe('TsgitError');
        });
      });
    });

    describe('Given invalidMergeTree', () => {
      describe('When accessing .message', () => {
        it('Then contains code and reason', () => {
          // Arrange & Act
          const sut = invalidMergeTree('over MAX_FLAT_TREE_ENTRIES');

          // Assert
          expect(sut.message).toContain('INVALID_MERGE_TREE');
          expect(sut.message).toContain('invalid merge tree: over MAX_FLAT_TREE_ENTRIES');
        });
      });
    });

    describe('Given invalidMergeInput', () => {
      describe('When accessing .message', () => {
        it('Then contains code and reason', () => {
          // Arrange & Act
          const sut = invalidMergeInput('oversize content');

          // Assert
          expect(sut.message).toContain('INVALID_MERGE_INPUT');
          expect(sut.message).toContain('invalid merge input: oversize content');
        });
      });
    });

    describe('Given a merge TsgitError', () => {
      describe('When switching on data.code in exhaustive switch', () => {
        it('Then all 29 cases handleable', () => {
          // Arrange
          const sut = invalidMergeTree('test');

          // Act & Assert
          const data: TsgitErrorData = sut.data;
          // Assert
          assertExhaustiveSwitch(data);
        });
      });
    });
  });
});
