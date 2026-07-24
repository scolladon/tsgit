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
  objectTooLarge,
  type TsgitError,
  treeCycleDetected,
  treeDepthExceeded,
} from '../../../../src/domain/objects/error.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import { assertExhaustiveSwitch } from '../exhaustiveness.js';

describe('error', () => {
  describe('factory functions', () => {
    describe("Given invalidObjectId('xyz')", () => {
      describe('When checking error.data.value', () => {
        it("Then equals 'xyz'", () => {
          // Arrange & Act
          const sut = invalidObjectId('xyz');

          // Assert
          expect(sut.data).toEqual({ code: 'INVALID_OBJECT_ID', value: 'xyz' });
        });
      });
    });

    describe("Given invalidObjectHeader('bad')", () => {
      describe('When checking error.data.code', () => {
        it("Then equals 'INVALID_OBJECT_HEADER'", () => {
          // Arrange & Act
          const sut = invalidObjectHeader('bad');

          // Assert
          expect(sut.data).toEqual({
            code: 'INVALID_OBJECT_HEADER',
            reason: 'bad',
          });
        });
      });
    });

    describe("Given invalidTreeEntry(5, 'truncated')", () => {
      describe('When checking error.data', () => {
        it("Then offset is 5 and reason is 'truncated'", () => {
          // Arrange & Act
          const sut = invalidTreeEntry(5, 'truncated');

          // Assert
          expect(sut.data).toEqual({
            code: 'INVALID_TREE_ENTRY',
            offset: 5,
            reason: 'truncated',
          });
        });
      });
    });

    describe("Given invalidCommit('missing tree')", () => {
      describe('When checking error.data.code', () => {
        it("Then equals 'INVALID_COMMIT'", () => {
          // Arrange & Act
          const sut = invalidCommit('missing tree');

          // Assert
          expect(sut.data).toEqual({
            code: 'INVALID_COMMIT',
            reason: 'missing tree',
          });
        });
      });
    });

    describe("Given invalidTag('missing object')", () => {
      describe('When checking error.data.code', () => {
        it("Then equals 'INVALID_TAG'", () => {
          // Arrange & Act
          const sut = invalidTag('missing object');

          // Assert
          expect(sut.data).toEqual({
            code: 'INVALID_TAG',
            reason: 'missing object',
          });
        });
      });
    });

    describe("Given invalidFileMode('999')", () => {
      describe('When checking error.data.code', () => {
        it("Then equals 'INVALID_FILE_MODE'", () => {
          // Arrange & Act
          const sut = invalidFileMode('999');

          // Assert
          expect(sut.data).toEqual({ code: 'INVALID_FILE_MODE', value: '999' });
        });
      });
    });

    describe("Given invalidIdentity('bad', 'no email')", () => {
      describe('When checking error.data', () => {
        it('Then line and reason correct', () => {
          // Arrange & Act
          const sut = invalidIdentity('bad', 'no email');

          // Assert
          expect(sut.data).toEqual({
            code: 'INVALID_IDENTITY',
            line: 'bad',
            reason: 'no email',
          });
        });
      });
    });

    describe('Given treeCycleDetected(id)', () => {
      describe('When checking error.data', () => {
        it('Then code and id are set', () => {
          // Arrange & Act
          const id = 'a'.repeat(40) as ObjectId;
          const sut = treeCycleDetected(id);

          // Assert
          expect(sut.data).toEqual({ code: 'TREE_CYCLE_DETECTED', id });
        });
      });
    });

    describe('Given treeDepthExceeded(depth)', () => {
      describe('When checking error.data', () => {
        it('Then code and depth are set', () => {
          // Arrange & Act
          const sut = treeDepthExceeded(42);

          // Assert
          expect(sut.data).toEqual({ code: 'TREE_DEPTH_EXCEEDED', depth: 42 });
        });
      });
    });

    describe('Given objectTooLarge(id, actualSize, limit)', () => {
      describe('When checking error.data', () => {
        it('Then code, id, actualSize, limit are set', () => {
          // Arrange & Act
          const id = 'b'.repeat(40) as ObjectId;
          const sut = objectTooLarge(id, 200, 100);

          // Assert
          expect(sut.data).toEqual({
            code: 'OBJECT_TOO_LARGE',
            id,
            actualSize: 200,
            limit: 100,
          });
        });
      });
    });

    describe('Given an OBJECT_TOO_LARGE error', () => {
      describe('When reading .message', () => {
        it('Then contains id, size, and limit', () => {
          // Arrange & Act
          const id = 'c'.repeat(40) as ObjectId;
          const sut = objectTooLarge(id, 999, 100);

          // Assert
          expect(sut.message).toContain('object too large');
          expect(sut.message).toContain(id);
          expect(sut.message).toContain('size=999');
          expect(sut.message).toContain('limit=100');
        });
      });
    });
  });

  describe('TsgitError class', () => {
    describe('Given a TsgitError', () => {
      describe('When checking instanceof Error', () => {
        it('Then returns true', () => {
          // Arrange & Act
          const sut = invalidObjectId('xyz');

          // Assert
          expect(sut).toBeInstanceOf(Error);
        });
      });
      describe('When accessing .name', () => {
        it("Then equals 'TsgitError'", () => {
          // Arrange & Act
          const sut = invalidObjectId('xyz');

          // Assert
          expect(sut.name).toBe('TsgitError');
        });
      });
      describe('When accessing .message', () => {
        it('Then contains the error code', () => {
          // Arrange & Act
          const sut = invalidObjectId('xyz');

          // Assert
          expect(sut.message).toContain('INVALID_OBJECT_ID');
        });
      });
      describe('When accessing .stack', () => {
        it('Then stack trace exists', () => {
          // Arrange & Act
          const sut = invalidObjectId('xyz');

          // Assert
          expect(sut.stack).toBeDefined();
        });
      });
      describe('When switching on data.code in exhaustive switch', () => {
        it('Then all cases are handleable', () => {
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
            // Assert
            assertExhaustiveSwitch(data);
          }
        });
      });
    });
  });
});
