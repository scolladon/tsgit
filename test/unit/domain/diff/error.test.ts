import { describe, expect, it } from 'vitest';
import { invalidDiffInput, invalidTreeForDiff } from '../../../../src/domain/diff/error.js';
import type { TsgitErrorData } from '../../../../src/domain/error.js';
import { assertExhaustiveSwitch } from '../exhaustiveness.js';

describe('diff error', () => {
  describe('factory functions', () => {
    describe("Given invalidTreeForDiff('too many entries')", () => {
      describe('When checking error.data', () => {
        it("Then code is 'INVALID_TREE_FOR_DIFF' and reason preserved", () => {
          // Arrange & Act
          const result = invalidTreeForDiff('too many entries');

          // Assert
          expect(result.data).toEqual({
            code: 'INVALID_TREE_FOR_DIFF',
            reason: 'too many entries',
          });
        });
      });
    });

    describe("Given invalidDiffInput('duplicate conflict path')", () => {
      describe('When checking error.data', () => {
        it("Then code is 'INVALID_DIFF_INPUT' and reason preserved", () => {
          // Arrange & Act
          const result = invalidDiffInput('duplicate conflict path');

          // Assert
          expect(result.data).toEqual({
            code: 'INVALID_DIFF_INPUT',
            reason: 'duplicate conflict path',
          });
        });
      });
    });
  });

  describe('TsgitError class', () => {
    describe('Given a diff TsgitError', () => {
      describe('When checking instanceof Error', () => {
        it('Then returns true', () => {
          // Arrange & Act
          const result = invalidTreeForDiff('bad');

          // Assert
          expect(result).toBeInstanceOf(Error);
        });
      });
      describe('When accessing .name', () => {
        it("Then equals 'TsgitError'", () => {
          // Arrange & Act
          const result = invalidTreeForDiff('bad');

          // Assert
          expect(result.name).toBe('TsgitError');
        });
      });
      describe('When accessing .message', () => {
        it('Then contains the error code', () => {
          // Arrange & Act
          const result = invalidTreeForDiff('bad');

          // Assert
          expect(result.message).toContain('INVALID_TREE_FOR_DIFF');
        });
        it('Then contains reason text', () => {
          // Arrange & Act
          const result = invalidTreeForDiff('over MAX_FLAT_TREE_ENTRIES');

          // Assert
          expect(result.message).toContain('invalid tree for diff: over MAX_FLAT_TREE_ENTRIES');
        });
      });
      describe('When switching on data.code in exhaustive switch', () => {
        it('Then all 29 cases handleable', () => {
          // Arrange
          const result = invalidTreeForDiff('test');

          // Act
          const data: TsgitErrorData = result.data;

          // Assert
          assertExhaustiveSwitch(data);
        });
      });
    });
  });
});
