import { describe, expect, it } from 'vitest';

import { SHA1_CONFIG, SHA256_CONFIG } from '../../../../src/domain/objects/hash-config.js';
import { isOid, oidPattern } from '../../../../src/domain/objects/oid-pattern.js';

const HEX_39 = 'a'.repeat(39);
const HEX_40 = 'a'.repeat(40);
const HEX_41 = 'a'.repeat(41);
const HEX_63 = 'a'.repeat(63);
const HEX_64 = 'a'.repeat(64);
const HEX_65 = 'a'.repeat(65);
const UPPER_40 = 'A'.repeat(40);
const NON_HEX_40 = 'g'.repeat(40);
const EMPTY = '';

describe('isOid', () => {
  describe('Given SHA1_CONFIG', () => {
    describe('When value is exactly 40 lower-case hex characters', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = isOid;

        // Act
        const result = sut(HEX_40, SHA1_CONFIG);

        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When value is 64 lower-case hex characters (SHA-256 width)', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = isOid;

        // Act
        const result = sut(HEX_64, SHA1_CONFIG);

        // Assert
        expect(result).toBe(false);
      });
    });

    describe('When value is 39 characters', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = isOid;

        // Act
        const result = sut(HEX_39, SHA1_CONFIG);

        // Assert
        expect(result).toBe(false);
      });
    });

    describe('When value is 41 characters', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = isOid;

        // Act
        const result = sut(HEX_41, SHA1_CONFIG);

        // Assert
        expect(result).toBe(false);
      });
    });

    describe('When value is upper-case hex at the correct width', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = isOid;

        // Act
        const result = sut(UPPER_40, SHA1_CONFIG);

        // Assert
        expect(result).toBe(false);
      });
    });

    describe('When value is non-hex characters at the correct width', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = isOid;

        // Act
        const result = sut(NON_HEX_40, SHA1_CONFIG);

        // Assert
        expect(result).toBe(false);
      });
    });

    describe('When value is empty', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = isOid;

        // Act
        const result = sut(EMPTY, SHA1_CONFIG);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given SHA256_CONFIG', () => {
    describe('When value is exactly 64 lower-case hex characters', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = isOid;

        // Act
        const result = sut(HEX_64, SHA256_CONFIG);

        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When value is 40 lower-case hex characters (a valid SHA-256 prefix, not a full oid)', () => {
      it('Then returns false', () => {
        // Arrange — the central trap: a 40-hex string resolves as a prefix
        // in a SHA-256 repository, so width alone must not make it match.
        const sut = isOid;

        // Act
        const result = sut(HEX_40, SHA256_CONFIG);

        // Assert
        expect(result).toBe(false);
      });
    });

    describe('When value is 63 characters', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = isOid;

        // Act
        const result = sut(HEX_63, SHA256_CONFIG);

        // Assert
        expect(result).toBe(false);
      });
    });

    describe('When value is 65 characters', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = isOid;

        // Act
        const result = sut(HEX_65, SHA256_CONFIG);

        // Assert
        expect(result).toBe(false);
      });
    });

    describe('When value is empty', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = isOid;

        // Act
        const result = sut(EMPTY, SHA256_CONFIG);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});

describe('oidPattern', () => {
  describe('Given SHA1_CONFIG', () => {
    describe('When building the pattern', () => {
      it('Then it matches exactly 40 lower-case hex characters', () => {
        // Arrange
        const sut = oidPattern;

        // Act
        const result = sut(SHA1_CONFIG);

        // Assert
        expect(result.test(HEX_40)).toBe(true);
        expect(result.test(HEX_64)).toBe(false);
      });
    });
  });

  describe('Given SHA256_CONFIG', () => {
    describe('When building the pattern', () => {
      it('Then it matches exactly 64 lower-case hex characters', () => {
        // Arrange
        const sut = oidPattern;

        // Act
        const result = sut(SHA256_CONFIG);

        // Assert
        expect(result.test(HEX_64)).toBe(true);
        expect(result.test(HEX_40)).toBe(false);
      });
    });
  });
});
