import { describe, expect, it } from 'vitest';
import {
  AllowlistError,
  type LoadAllowlistConfig,
  parseAllowlist,
} from '../../../audit-write-surfaces/load-allowlist.js';

const sutConfig = (): LoadAllowlistConfig => ({
  surfaceRegex: /^[a-z][a-zA-Z0-9.-]{1,40}$/,
});

const expectError = (
  fn: () => unknown,
  expectedReason: string,
): void => {
  try {
    fn();
    throw new Error('expected AllowlistError, got success');
  } catch (err) {
    expect(err).toBeInstanceOf(AllowlistError);
    if (err instanceof AllowlistError) {
      expect(err.reason).toBe(expectedReason);
    }
  }
};

describe('parseAllowlist', () => {
  describe('Given an empty surfaces array', () => {
    describe('When parsed', () => {
      it('Then returns an empty list', () => {
        // Arrange
        const sutContent = '{ "surfaces": [] }';

        // Act
        const sut = parseAllowlist(sutContent, sutConfig());

        // Assert
        expect(sut).toEqual([]);
      });
    });
  });

  describe('Given one well-formed entry', () => {
    describe('When parsed', () => {
      it('Then returns the entry as an AllowEntry', () => {
        // Arrange
        const sutContent = JSON.stringify({
          surfaces: [{ surface: 'tree', reason: 'because', deferredTo: '20.x' }],
        });

        // Act
        const sut = parseAllowlist(sutContent, sutConfig());

        // Assert
        expect(sut).toEqual([
          { surface: 'tree', reason: 'because', deferredTo: '20.x' },
        ]);
      });
    });
  });

  describe('Given a deferredTo of null', () => {
    describe('When parsed', () => {
      it('Then null is preserved (permanent exemption)', () => {
        // Arrange
        const sutContent = JSON.stringify({
          surfaces: [{ surface: 'tree', reason: 'forever', deferredTo: null }],
        });

        // Act
        const sut = parseAllowlist(sutContent, sutConfig());

        // Assert
        expect(sut[0]?.deferredTo).toBeNull();
      });
    });
  });

  describe('Given malformed JSON', () => {
    describe('When parsed', () => {
      it('Then throws AllowlistError with reason=invalid-json', () => {
        // Arrange
        const sutContent = '{ surfaces: not-json';

        // Act + Assert
        expectError(() => parseAllowlist(sutContent, sutConfig()), 'invalid-json');
      });
    });
  });

  describe('Given valid JSON that is not an object', () => {
    describe('When parsed', () => {
      it('Then throws AllowlistError with reason=not-an-object', () => {
        // Arrange
        const sutContent = '[]';

        // Act + Assert
        expectError(() => parseAllowlist(sutContent, sutConfig()), 'not-an-object');
      });
    });
  });

  describe('Given an object missing the surfaces array', () => {
    describe('When parsed', () => {
      it('Then throws AllowlistError with reason=missing-surfaces-array', () => {
        // Arrange
        const sutContent = '{ "other": [] }';

        // Act + Assert
        expectError(
          () => parseAllowlist(sutContent, sutConfig()),
          'missing-surfaces-array',
        );
      });
    });
  });

  describe('Given an entry that is not an object', () => {
    describe('When parsed', () => {
      it('Then throws AllowlistError with reason=entry-not-an-object', () => {
        // Arrange
        const sutContent = '{ "surfaces": ["plain-string"] }';

        // Act + Assert
        expectError(
          () => parseAllowlist(sutContent, sutConfig()),
          'entry-not-an-object',
        );
      });
    });
  });

  describe('Given an entry missing the reason field', () => {
    describe('When parsed', () => {
      it('Then throws AllowlistError with reason=missing-field', () => {
        // Arrange
        const sutContent = JSON.stringify({
          surfaces: [{ surface: 'tree', deferredTo: null }],
        });

        // Act + Assert
        expectError(() => parseAllowlist(sutContent, sutConfig()), 'missing-field');
      });
    });
  });

  describe('Given an entry with a numeric reason', () => {
    describe('When parsed', () => {
      it('Then throws AllowlistError with reason=wrong-field-type', () => {
        // Arrange
        const sutContent = JSON.stringify({
          surfaces: [{ surface: 'tree', reason: 42, deferredTo: null }],
        });

        // Act + Assert
        expectError(
          () => parseAllowlist(sutContent, sutConfig()),
          'wrong-field-type',
        );
      });
    });
  });

  describe('Given an entry with a whitespace-only reason', () => {
    describe('When parsed', () => {
      it('Then throws AllowlistError with reason=empty-string', () => {
        // Arrange
        const sutContent = JSON.stringify({
          surfaces: [{ surface: 'tree', reason: '   ', deferredTo: null }],
        });

        // Act + Assert
        expectError(() => parseAllowlist(sutContent, sutConfig()), 'empty-string');
      });
    });
  });

  describe('Given a surface name that violates surfaceRegex', () => {
    describe('When parsed', () => {
      it('Then throws AllowlistError with reason=bad-surface-format', () => {
        // Arrange
        const sutContent = JSON.stringify({
          surfaces: [{ surface: 'NotKebab', reason: 'ok', deferredTo: null }],
        });

        // Act + Assert
        expectError(
          () => parseAllowlist(sutContent, sutConfig()),
          'bad-surface-format',
        );
      });
    });
  });

  describe('Given a deferredTo that is neither string nor null', () => {
    describe('When parsed', () => {
      it('Then throws AllowlistError with reason=wrong-field-type', () => {
        // Arrange
        const sutContent = JSON.stringify({
          surfaces: [{ surface: 'tree', reason: 'ok', deferredTo: 99 }],
        });

        // Act + Assert
        expectError(
          () => parseAllowlist(sutContent, sutConfig()),
          'wrong-field-type',
        );
      });
    });
  });
});
