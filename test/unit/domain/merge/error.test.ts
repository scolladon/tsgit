import { describe, expect, it } from 'vitest';
import type { TsgitErrorData } from '../../../../src/domain/error.js';
import { invalidMergeInput, invalidMergeTree } from '../../../../src/domain/merge/error.js';

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
      switch (data.code) {
        case 'INVALID_OBJECT_ID':
        case 'INVALID_OBJECT_HEADER':
        case 'INVALID_TREE_ENTRY':
        case 'INVALID_COMMIT':
        case 'INVALID_TAG':
        case 'INVALID_FILE_MODE':
        case 'INVALID_IDENTITY':
        case 'INVALID_PACK_HEADER':
        case 'INVALID_PACK_INDEX':
        case 'INVALID_PACK_ENTRY':
        case 'INVALID_DELTA':
        case 'INVALID_REF':
        case 'INVALID_PACKED_REFS':
        case 'INVALID_INDEX_HEADER':
        case 'INVALID_INDEX_ENTRY':
        case 'FILE_NOT_FOUND':
        case 'FILE_EXISTS':
        case 'NOT_A_DIRECTORY':
        case 'PERMISSION_DENIED':
        case 'UNSUPPORTED_OPERATION':
        case 'HASH_FAILED':
        case 'COMPRESS_FAILED':
        case 'DECOMPRESS_FAILED':
        case 'HTTP_ERROR':
        case 'NETWORK_ERROR':
        case 'INVALID_TREE_FOR_DIFF':
        case 'INVALID_DIFF_INPUT':
        case 'INVALID_MERGE_TREE':
        case 'INVALID_MERGE_INPUT':
        case 'OBJECT_NOT_FOUND':
        case 'OBJECT_HASH_MISMATCH':
        case 'UNEXPECTED_OBJECT_TYPE':
        case 'TREE_CYCLE_DETECTED':
        case 'TREE_DEPTH_EXCEEDED':
        case 'TREE_ENTRY_LIMIT_EXCEEDED':
        case 'DELTA_CHAIN_TOO_DEEP':
        case 'REF_NOT_FOUND':
        case 'REF_CHAIN_TOO_DEEP':
        case 'REF_CYCLE_DETECTED':
        case 'REF_LOCKED':
        case 'REF_UPDATE_CONFLICT':
        case 'INVALID_WALK_INPUT':
        case 'OPERATION_ABORTED':
          break;
        default: {
          const _exhaustive: never = data;
          throw new Error(`Unhandled case: ${_exhaustive}`);
        }
      }
    });
  });
});
