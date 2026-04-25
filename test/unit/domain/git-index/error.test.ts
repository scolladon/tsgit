import { describe, expect, it } from 'vitest';
import type { TsgitErrorData } from '../../../../src/domain/error.js';
import { invalidIndexEntry, invalidIndexHeader } from '../../../../src/domain/git-index/error.js';

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
        case 'INVALID_PKT_LENGTH':
        case 'PKT_LENGTH_RESERVED':
        case 'PKT_TOO_LARGE':
        case 'PKT_TRUNCATED':
        case 'INVALID_BASE_URL':
        case 'MISSING_SERVICE_HEADER':
        case 'MISSING_CAPABILITIES':
        case 'INVALID_REF_LINE':
        case 'DUPLICATE_REF':
        case 'INVALID_SIDEBAND_CHANNEL':
        case 'SIDEBAND_FATAL':
        case 'UNKNOWN_ACK_STATUS':
        case 'INVALID_REPORT_STATUS':
        case 'EMPTY_WANTS':
        case 'EMPTY_RECEIVE_UPDATES':
          break;
        default: {
          const _exhaustive: never = data;
          throw new Error(`Unhandled case: ${_exhaustive}`);
        }
      }
    });
  });
});
