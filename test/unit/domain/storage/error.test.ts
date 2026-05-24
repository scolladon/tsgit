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

    it('Given deltaChainTooDeep(depth), When checking error.data, Then code and depth are set', () => {
      // Arrange & Act
      const sut = deltaChainTooDeep(51);

      // Assert
      expect(sut.data).toEqual({ code: 'DELTA_CHAIN_TOO_DEEP', depth: 51 });
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

    it('Given a storage TsgitError, When switching on data.code in exhaustive switch, Then all 29 cases handleable', () => {
      // Arrange
      const sut = invalidPackHeader('test');

      // Act & Assert
      const data: TsgitErrorData = sut.data;
      // Assert
      assertExhaustiveSwitch(data);
    });
  });
});
