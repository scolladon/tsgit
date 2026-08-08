import { describe, expect, it } from 'vitest';
import type { TsgitErrorData } from '../../../../src/domain/error.js';
import {
  deltaChainTooDeep,
  invalidDelta,
  invalidMultiPackIndex,
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
          const result = invalidPackHeader('bad magic');

          // Assert
          expect(result.data).toEqual({ code: 'INVALID_PACK_HEADER', reason: 'bad magic' });
        });
      });
    });

    describe("Given invalidPackIndex('fanout')", () => {
      describe('When checking error.data.code', () => {
        it("Then equals 'INVALID_PACK_INDEX'", () => {
          // Arrange & Act
          const result = invalidPackIndex('fanout');

          // Assert
          expect(result.data).toEqual({ code: 'INVALID_PACK_INDEX', reason: 'fanout' });
        });
      });
    });

    describe("Given invalidPackEntry(42, 'truncated')", () => {
      describe('When checking error.data', () => {
        it("Then offset is 42 and reason is 'truncated'", () => {
          // Arrange & Act
          const result = invalidPackEntry(42, 'truncated');

          // Assert
          expect(result.data).toEqual({
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
          const result = invalidDelta('source mismatch');

          // Assert
          expect(result.data).toEqual({ code: 'INVALID_DELTA', reason: 'source mismatch' });
        });
      });
    });

    describe('Given deltaChainTooDeep(depth)', () => {
      describe('When checking error.data', () => {
        it('Then code and depth are set', () => {
          // Arrange & Act
          const result = deltaChainTooDeep(51);

          // Assert
          expect(result.data).toEqual({ code: 'DELTA_CHAIN_TOO_DEEP', depth: 51 });
        });
      });
    });

    describe("Given invalidMultiPackIndex('fanout', 'non-monotonic')", () => {
      describe('When checking error.data', () => {
        it("Then code, check and reason are set to 'INVALID_MULTI_PACK_INDEX', 'fanout' and 'non-monotonic'", () => {
          // Arrange & Act
          const result = invalidMultiPackIndex('fanout', 'non-monotonic');

          // Assert
          expect(result.data).toEqual({
            code: 'INVALID_MULTI_PACK_INDEX',
            check: 'fanout',
            reason: 'non-monotonic',
          });
        });
      });
    });
  });

  describe('TsgitError class', () => {
    describe('Given a storage TsgitError', () => {
      describe('When checking instanceof Error', () => {
        it('Then returns true', () => {
          // Arrange & Act
          const result = invalidPackHeader('bad');

          // Assert
          expect(result).toBeInstanceOf(Error);
        });
      });
      describe('When accessing .name', () => {
        it("Then equals 'TsgitError'", () => {
          // Arrange & Act
          const result = invalidPackHeader('bad');

          // Assert
          expect(result.name).toBe('TsgitError');
        });
      });
      describe('When accessing .message', () => {
        it('Then contains the error code', () => {
          // Arrange & Act
          const result = invalidPackHeader('bad');

          // Assert
          expect(result.message).toContain('INVALID_PACK_HEADER');
        });
      });
      describe('When switching on data.code in exhaustive switch', () => {
        it('Then all 29 cases handleable', () => {
          // Arrange
          const result = invalidPackHeader('test');

          // Act
          const data: TsgitErrorData = result.data;

          // Assert
          assertExhaustiveSwitch(data);
        });
      });
    });
  });
});
