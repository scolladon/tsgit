import { describe, expect, it } from 'vitest';
import type { TsgitErrorData } from '../../../../src/domain/error.js';
import {
  invalidCommit,
  invalidFileMode,
  invalidIdentity,
  invalidObjectHeader,
  invalidObjectId,
  invalidTag,
  invalidTreeEntry,
  type TsgitError,
  treeCycleDetected,
  treeDepthExceeded,
} from '../../../../src/domain/objects/error.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';

describe('error', () => {
  describe('factory functions', () => {
    it("Given invalidObjectId('xyz'), When checking error.data.code, Then equals 'INVALID_OBJECT_ID'", () => {
      // Arrange & Act
      const sut = invalidObjectId('xyz');

      // Assert
      expect(sut.data.code).toBe('INVALID_OBJECT_ID');
    });

    it("Given invalidObjectId('xyz'), When checking error.data.value, Then equals 'xyz'", () => {
      // Arrange & Act
      const sut = invalidObjectId('xyz');

      // Assert
      expect(sut.data).toEqual({ code: 'INVALID_OBJECT_ID', value: 'xyz' });
    });

    it("Given invalidObjectHeader('bad'), When checking error.data.code, Then equals 'INVALID_OBJECT_HEADER'", () => {
      // Arrange & Act
      const sut = invalidObjectHeader('bad');

      // Assert
      expect(sut.data).toEqual({
        code: 'INVALID_OBJECT_HEADER',
        reason: 'bad',
      });
    });

    it("Given invalidTreeEntry(5, 'truncated'), When checking error.data, Then offset is 5 and reason is 'truncated'", () => {
      // Arrange & Act
      const sut = invalidTreeEntry(5, 'truncated');

      // Assert
      expect(sut.data).toEqual({
        code: 'INVALID_TREE_ENTRY',
        offset: 5,
        reason: 'truncated',
      });
    });

    it("Given invalidCommit('missing tree'), When checking error.data.code, Then equals 'INVALID_COMMIT'", () => {
      // Arrange & Act
      const sut = invalidCommit('missing tree');

      // Assert
      expect(sut.data).toEqual({
        code: 'INVALID_COMMIT',
        reason: 'missing tree',
      });
    });

    it("Given invalidTag('missing object'), When checking error.data.code, Then equals 'INVALID_TAG'", () => {
      // Arrange & Act
      const sut = invalidTag('missing object');

      // Assert
      expect(sut.data).toEqual({
        code: 'INVALID_TAG',
        reason: 'missing object',
      });
    });

    it("Given invalidFileMode('999'), When checking error.data.code, Then equals 'INVALID_FILE_MODE'", () => {
      // Arrange & Act
      const sut = invalidFileMode('999');

      // Assert
      expect(sut.data).toEqual({ code: 'INVALID_FILE_MODE', value: '999' });
    });

    it("Given invalidIdentity('bad', 'no email'), When checking error.data, Then line and reason correct", () => {
      // Arrange & Act
      const sut = invalidIdentity('bad', 'no email');

      // Assert
      expect(sut.data).toEqual({
        code: 'INVALID_IDENTITY',
        line: 'bad',
        reason: 'no email',
      });
    });

    it('Given treeCycleDetected(id), When checking error.data, Then code and id are set', () => {
      // Arrange & Act
      const id = 'a'.repeat(40) as ObjectId;
      const sut = treeCycleDetected(id);

      // Assert
      expect(sut.data).toEqual({ code: 'TREE_CYCLE_DETECTED', id });
    });

    it('Given treeDepthExceeded(depth), When checking error.data, Then code and depth are set', () => {
      // Arrange & Act
      const sut = treeDepthExceeded(42);

      // Assert
      expect(sut.data).toEqual({ code: 'TREE_DEPTH_EXCEEDED', depth: 42 });
    });
  });

  describe('TsgitError class', () => {
    it('Given a TsgitError, When checking instanceof Error, Then returns true', () => {
      // Arrange & Act
      const sut = invalidObjectId('xyz');

      // Assert
      expect(sut).toBeInstanceOf(Error);
    });

    it("Given a TsgitError, When accessing .name, Then equals 'TsgitError'", () => {
      // Arrange & Act
      const sut = invalidObjectId('xyz');

      // Assert
      expect(sut.name).toBe('TsgitError');
    });

    it('Given a TsgitError, When accessing .message, Then contains the error code', () => {
      // Arrange & Act
      const sut = invalidObjectId('xyz');

      // Assert
      expect(sut.message).toContain('INVALID_OBJECT_ID');
    });

    it('Given a TsgitError, When accessing .stack, Then stack trace exists', () => {
      // Arrange & Act
      const sut = invalidObjectId('xyz');

      // Assert
      expect(sut.stack).toBeDefined();
    });

    it('Given a TsgitError, When switching on data.code in exhaustive switch, Then all cases are handleable', () => {
      // Arrange
      const errors: ReadonlyArray<TsgitError> = [
        invalidObjectId('x'),
        invalidObjectHeader('x'),
        invalidTreeEntry(0, 'x'),
        invalidCommit('x'),
        invalidTag('x'),
        invalidFileMode('x'),
        invalidIdentity('x', 'x'),
      ];

      // Act & Assert
      for (const error of errors) {
        const data: TsgitErrorData = error.data;
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
      }
    });
  });
});
