import { describe, expect, it } from 'vitest';
import type { TsgitErrorData } from '../../../../src/domain/error.js';
import {
  invalidPackedRefs,
  invalidRef,
  invalidReftable,
  reftableLocked,
} from '../../../../src/domain/refs/error.js';
import { assertExhaustiveSwitch } from '../exhaustiveness.js';

describe('refs error', () => {
  describe('factory functions', () => {
    describe("Given invalidRef('bad sha')", () => {
      describe('When checking error.data', () => {
        it("Then code is 'INVALID_REF' and reason matches", () => {
          // Arrange & Act
          const result = invalidRef('bad sha');

          // Assert
          expect(result.data).toEqual({ code: 'INVALID_REF', reason: 'bad sha' });
        });
      });
    });

    describe("Given invalidPackedRefs('corrupt line')", () => {
      describe('When checking error.data', () => {
        it("Then code is 'INVALID_PACKED_REFS' and reason matches", () => {
          // Arrange & Act
          const result = invalidPackedRefs('corrupt line');

          // Assert
          expect(result.data).toEqual({ code: 'INVALID_PACKED_REFS', reason: 'corrupt line' });
        });
      });
    });

    describe("Given invalidReftable('magic', 'bad')", () => {
      describe('When checking error.data', () => {
        it("Then code is 'INVALID_REFTABLE', check is 'magic' and reason matches", () => {
          // Arrange & Act
          const result = invalidReftable('magic', 'bad');

          // Assert
          expect(result.data).toEqual({ code: 'INVALID_REFTABLE', check: 'magic', reason: 'bad' });
        });
      });
    });

    describe("Given reftableLocked('.git/reftable', 'held by another writer')", () => {
      describe('When checking error.data', () => {
        it("Then code is 'REFTABLE_LOCKED', stack and reason match", () => {
          // Arrange & Act
          const result = reftableLocked('.git/reftable', 'held by another writer');

          // Assert
          expect(result.data).toEqual({
            code: 'REFTABLE_LOCKED',
            stack: '.git/reftable',
            reason: 'held by another writer',
          });
        });
      });
    });
  });

  describe('TsgitError class', () => {
    describe('Given a refs TsgitError', () => {
      describe('When checking instanceof Error', () => {
        it('Then returns true', () => {
          // Arrange & Act
          const result = invalidRef('bad');

          // Assert
          expect(result).toBeInstanceOf(Error);
        });
      });
      describe('When accessing .name', () => {
        it("Then equals 'TsgitError'", () => {
          // Arrange & Act
          const result = invalidRef('bad');

          // Assert
          expect(result.name).toBe('TsgitError');
        });
      });
      describe('When accessing .message', () => {
        it('Then contains the error code', () => {
          // Arrange & Act
          const result = invalidRef('bad');

          // Assert
          expect(result.message).toContain('INVALID_REF');
        });
      });
      describe('When switching on data.code in exhaustive switch', () => {
        it('Then all 29 cases handleable', () => {
          // Arrange
          const result = invalidRef('test');

          // Act & Assert
          const data: TsgitErrorData = result.data;
          // Assert
          assertExhaustiveSwitch(data);
        });
      });
    });
  });
});
