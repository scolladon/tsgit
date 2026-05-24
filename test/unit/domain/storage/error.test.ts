import { describe, expect, it } from 'vitest';
import type { TsgitErrorData } from '../../../../src/domain/error.js';
import {
  deltaChainTooDeep,
  invalidDelta,
  invalidPackEntry,
  invalidPackHeader,
  invalidPackIndex,
} from '../../../../src/domain/storage/error.js';
import { assertExhaustiveSwitch } from '../exhaustiveness.js';

describe('storage error', () => {
  describe('factory functions', () => {
    describe("Given invalidPackHeader('bad magic')", () => {
      describe('When checking error.data.code', () => {
        it("Then equals 'INVALID_PACK_HEADER'", () => {
          // Arrange & Act
          const sut = invalidPackHeader('bad magic');

          // Assert
          expect(sut.data).toEqual({ code: 'INVALID_PACK_HEADER', reason: 'bad magic' });
        });
      });
    });

    describe("Given invalidPackIndex('fanout')", () => {
      describe('When checking error.data.code', () => {
        it("Then equals 'INVALID_PACK_INDEX'", () => {
          // Arrange & Act
          const sut = invalidPackIndex('fanout');

          // Assert
          expect(sut.data).toEqual({ code: 'INVALID_PACK_INDEX', reason: 'fanout' });
        });
      });
    });

    describe("Given invalidPackEntry(42, 'truncated')", () => {
      describe('When checking error.data', () => {
        it("Then offset is 42 and reason is 'truncated'", () => {
          // Arrange & Act
          const sut = invalidPackEntry(42, 'truncated');

          // Assert
          expect(sut.data).toEqual({
            code: 'INVALID_PACK_ENTRY',
            offset: 42,
            reason: 'truncated',
          });
        });
      });
    });

    describe("Given invalidDelta('source mismatch')", () => {
      describe('When checking error.data.code', () => {
        it("Then equals 'INVALID_DELTA'", () => {
          // Arrange & Act
          const sut = invalidDelta('source mismatch');

          // Assert
          expect(sut.data).toEqual({ code: 'INVALID_DELTA', reason: 'source mismatch' });
        });
      });
    });

    describe('Given deltaChainTooDeep(depth)', () => {
      describe('When checking error.data', () => {
        it('Then code and depth are set', () => {
          // Arrange & Act
          const sut = deltaChainTooDeep(51);

          // Assert
          expect(sut.data).toEqual({ code: 'DELTA_CHAIN_TOO_DEEP', depth: 51 });
        });
      });
    });
  });

  describe('TsgitError class', () => {
    describe('Given a storage TsgitError', () => {
      describe('When checking instanceof Error', () => {
        it('Then returns true', () => {
          // Arrange & Act
          const sut = invalidPackHeader('bad');

          // Assert
          expect(sut).toBeInstanceOf(Error);
        });
      });
      describe('When accessing .name', () => {
        it("Then equals 'TsgitError'", () => {
          // Arrange & Act
          const sut = invalidPackHeader('bad');

          // Assert
          expect(sut.name).toBe('TsgitError');
        });
      });
      describe('When accessing .message', () => {
        it('Then contains the error code', () => {
          // Arrange & Act
          const sut = invalidPackHeader('bad');

          // Assert
          expect(sut.message).toContain('INVALID_PACK_HEADER');
        });
      });
      describe('When switching on data.code in exhaustive switch', () => {
        it('Then all 29 cases handleable', () => {
          // Arrange
          const sut = invalidPackHeader('test');

          // Act & Assert
          const data: TsgitErrorData = sut.data;
          // Assert
          assertExhaustiveSwitch(data);
        });
      });
    });
  });
});
