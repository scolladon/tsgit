import { describe, expect, it } from 'vitest';
import type { TsgitErrorData } from '../../../../src/domain/error.js';
import {
  invalidDelta,
  invalidPackEntry,
  invalidPackHeader,
  invalidPackIndex,
} from '../../../../src/domain/storage/error.js';

describe('storage error', () => {
  describe('factory functions', () => {
    it("Given invalidPackHeader('bad magic'), When checking error.data.code, Then equals 'INVALID_PACK_HEADER'", () => {
      // Arrange & Act
      const sut = invalidPackHeader('bad magic');

      // Assert
      expect(sut.data).toEqual({ code: 'INVALID_PACK_HEADER', reason: 'bad magic' });
    });

    it("Given invalidPackIndex('fanout'), When checking error.data.code, Then equals 'INVALID_PACK_INDEX'", () => {
      // Arrange & Act
      const sut = invalidPackIndex('fanout');

      // Assert
      expect(sut.data).toEqual({ code: 'INVALID_PACK_INDEX', reason: 'fanout' });
    });

    it("Given invalidPackEntry(42, 'truncated'), When checking error.data, Then offset is 42 and reason is 'truncated'", () => {
      // Arrange & Act
      const sut = invalidPackEntry(42, 'truncated');

      // Assert
      expect(sut.data).toEqual({
        code: 'INVALID_PACK_ENTRY',
        offset: 42,
        reason: 'truncated',
      });
    });

    it("Given invalidDelta('source mismatch'), When checking error.data.code, Then equals 'INVALID_DELTA'", () => {
      // Arrange & Act
      const sut = invalidDelta('source mismatch');

      // Assert
      expect(sut.data).toEqual({ code: 'INVALID_DELTA', reason: 'source mismatch' });
    });
  });

  describe('TsgitError class', () => {
    it('Given a storage TsgitError, When checking instanceof Error, Then returns true', () => {
      // Arrange & Act
      const sut = invalidPackHeader('bad');

      // Assert
      expect(sut).toBeInstanceOf(Error);
    });

    it("Given a storage TsgitError, When accessing .name, Then equals 'TsgitError'", () => {
      // Arrange & Act
      const sut = invalidPackHeader('bad');

      // Assert
      expect(sut.name).toBe('TsgitError');
    });

    it('Given a storage TsgitError, When accessing .message, Then contains the error code', () => {
      // Arrange & Act
      const sut = invalidPackHeader('bad');

      // Assert
      expect(sut.message).toContain('INVALID_PACK_HEADER');
    });

    it('Given a storage TsgitError, When switching on data.code in exhaustive switch, Then all 25 cases handleable', () => {
      // Arrange
      const sut = invalidPackHeader('test');

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
