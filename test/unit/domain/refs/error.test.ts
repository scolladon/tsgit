import { describe, expect, it } from 'vitest';
import type { TsgitErrorData } from '../../../../src/domain/error.js';
import { invalidPackedRefs, invalidRef } from '../../../../src/domain/refs/error.js';
import { assertExhaustiveSwitch } from '../exhaustiveness.js';

describe('refs error', () => {
  describe('factory functions', () => {
    describe("Given invalidRef('bad sha')", () => {
      describe('When checking error.data', () => {
        it("Then code is 'INVALID_REF' and reason matches", () => {
          // Arrange & Act
          const sut = invalidRef('bad sha');

          // Assert
          expect(sut.data).toEqual({ code: 'INVALID_REF', reason: 'bad sha' });
        });
      });
    });

    describe("Given invalidPackedRefs('corrupt line')", () => {
      describe('When checking error.data', () => {
        it("Then code is 'INVALID_PACKED_REFS' and reason matches", () => {
          // Arrange & Act
          const sut = invalidPackedRefs('corrupt line');

          // Assert
          expect(sut.data).toEqual({ code: 'INVALID_PACKED_REFS', reason: 'corrupt line' });
        });
      });
    });
  });

  describe('TsgitError class', () => {
    describe('Given a refs TsgitError', () => {
      describe('When checking instanceof Error', () => {
        it('Then returns true', () => {
          // Arrange & Act
          const sut = invalidRef('bad');

          // Assert
          expect(sut).toBeInstanceOf(Error);
        });
      });
      describe('When accessing .name', () => {
        it("Then equals 'TsgitError'", () => {
          // Arrange & Act
          const sut = invalidRef('bad');

          // Assert
          expect(sut.name).toBe('TsgitError');
        });
      });
      describe('When accessing .message', () => {
        it('Then contains the error code', () => {
          // Arrange & Act
          const sut = invalidRef('bad');

          // Assert
          expect(sut.message).toContain('INVALID_REF');
        });
      });
      describe('When switching on data.code in exhaustive switch', () => {
        it('Then all 29 cases handleable', () => {
          // Arrange
          const sut = invalidRef('test');

          // Act & Assert
          const data: TsgitErrorData = sut.data;
          // Assert
          assertExhaustiveSwitch(data);
        });
      });
    });
  });
});
