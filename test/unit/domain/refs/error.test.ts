import { describe, expect, it } from 'vitest';
import type { TsgitErrorData } from '../../../../src/domain/error.js';
import { invalidPackedRefs, invalidRef } from '../../../../src/domain/refs/error.js';

describe('refs error', () => {
  describe('factory functions', () => {
    it("Given invalidRef('bad sha'), When checking error.data, Then code is 'INVALID_REF' and reason matches", () => {
      // Arrange & Act
      const sut = invalidRef('bad sha');

      // Assert
      expect(sut.data).toEqual({ code: 'INVALID_REF', reason: 'bad sha' });
    });

    it("Given invalidPackedRefs('corrupt line'), When checking error.data, Then code is 'INVALID_PACKED_REFS' and reason matches", () => {
      // Arrange & Act
      const sut = invalidPackedRefs('corrupt line');

      // Assert
      expect(sut.data).toEqual({ code: 'INVALID_PACKED_REFS', reason: 'corrupt line' });
    });
  });

  describe('TsgitError class', () => {
    it('Given a refs TsgitError, When checking instanceof Error, Then returns true', () => {
      // Arrange & Act
      const sut = invalidRef('bad');

      // Assert
      expect(sut).toBeInstanceOf(Error);
    });

    it("Given a refs TsgitError, When accessing .name, Then equals 'TsgitError'", () => {
      // Arrange & Act
      const sut = invalidRef('bad');

      // Assert
      expect(sut.name).toBe('TsgitError');
    });

    it('Given a refs TsgitError, When accessing .message, Then contains the error code', () => {
      // Arrange & Act
      const sut = invalidRef('bad');

      // Assert
      expect(sut.message).toContain('INVALID_REF');
    });

    it('Given a refs TsgitError, When switching on data.code in exhaustive switch, Then all 25 cases handleable', () => {
      // Arrange
      const sut = invalidRef('test');

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
          break;
        default: {
          const _exhaustive: never = data;
          throw new Error(`Unhandled case: ${_exhaustive}`);
        }
      }
    });
  });
});
