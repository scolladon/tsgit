import { describe, expect, it } from 'vitest';
import { resolveBinaryOverride } from '../../../../src/application/primitives/resolve-binary-override.js';

describe('resolveBinaryOverride', () => {
  describe('Given diff attribute is false (binary macro / -diff)', () => {
    describe('When rawIsBinary and textconvConfigured are any values', () => {
      it('Then returns patch:binary and numstat:binary', () => {
        // Arrange
        const value = false as const;
        const named = { textconvConfigured: false, rawIsBinary: false };

        // Act
        const result = resolveBinaryOverride(value, named);

        // Assert
        expect(result).toStrictEqual({ patch: 'binary', numstat: 'binary' });
      });
    });
  });

  describe('Given diff attribute is true (bare diff)', () => {
    describe('When rawIsBinary and textconvConfigured are any values', () => {
      it('Then returns patch:text and numstat:text', () => {
        // Arrange
        const value = true as const;
        const named = { textconvConfigured: false, rawIsBinary: true };

        // Act
        const result = resolveBinaryOverride(value, named);

        // Assert
        expect(result).toStrictEqual({ patch: 'text', numstat: 'text' });
      });
    });
  });

  describe('Given diff attribute is unspecified', () => {
    describe('When rawIsBinary and textconvConfigured are any values', () => {
      it('Then returns empty override pair (no patch, no numstat)', () => {
        // Arrange
        const value = 'unspecified' as const;
        const named = { textconvConfigured: true, rawIsBinary: true };

        // Act
        const result = resolveBinaryOverride(value, named);

        // Assert
        expect(result.patch).toBeUndefined();
        expect(result.numstat).toBeUndefined();
      });
    });
  });

  describe('Given diff attribute is a named driver', () => {
    describe('When textconv is configured and rawIsBinary is false', () => {
      it('Then returns patch:text and numstat:text', () => {
        // Arrange
        const value = { set: 'exif' } as const;
        const named = { textconvConfigured: true, rawIsBinary: false };

        // Act
        const result = resolveBinaryOverride(value, named);

        // Assert
        expect(result).toStrictEqual({ patch: 'text', numstat: 'text' });
      });
    });

    describe('When textconv is configured and rawIsBinary is true', () => {
      it('Then returns patch:text and numstat:binary', () => {
        // Arrange
        const value = { set: 'exif' } as const;
        const named = { textconvConfigured: true, rawIsBinary: true };

        // Act
        const result = resolveBinaryOverride(value, named);

        // Assert
        expect(result).toStrictEqual({ patch: 'text', numstat: 'binary' });
      });
    });

    describe('When textconv is not configured and rawIsBinary is true', () => {
      it('Then returns empty override pair (no patch, no numstat)', () => {
        // Arrange
        const value = { set: 'nodiff' } as const;
        const named = { textconvConfigured: false, rawIsBinary: true };

        // Act
        const result = resolveBinaryOverride(value, named);

        // Assert
        expect(result.patch).toBeUndefined();
        expect(result.numstat).toBeUndefined();
      });
    });

    describe('When textconv is not configured and rawIsBinary is false', () => {
      it('Then returns empty override pair (no patch, no numstat)', () => {
        // Arrange
        const value = { set: 'nodiff' } as const;
        const named = { textconvConfigured: false, rawIsBinary: false };

        // Act
        const result = resolveBinaryOverride(value, named);

        // Assert
        expect(result.patch).toBeUndefined();
        expect(result.numstat).toBeUndefined();
      });
    });
  });
});
