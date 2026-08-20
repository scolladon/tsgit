import { describe, expect, it } from 'vitest';

import { SHA1_CONFIG, SHA256_CONFIG } from '../../../../src/domain/objects/hash-config.js';

describe('hash-config', () => {
  describe('Given SHA1_CONFIG', () => {
    describe('When reading digestLength', () => {
      it('Then returns 20', () => {
        // Arrange & Act
        const result = SHA1_CONFIG;

        // Assert
        expect(result.digestLength).toBe(20);
      });
    });
    describe('When reading hexLength', () => {
      it('Then returns 40', () => {
        // Arrange & Act
        const result = SHA1_CONFIG;

        // Assert
        expect(result.hexLength).toBe(40);
      });
    });
  });

  describe('Given SHA256_CONFIG', () => {
    describe('When reading digestLength', () => {
      it('Then returns 32', () => {
        // Arrange & Act
        const result = SHA256_CONFIG;

        // Assert
        expect(result.digestLength).toBe(32);
      });
    });
    describe('When reading hexLength', () => {
      it('Then returns 64', () => {
        // Arrange & Act
        const result = SHA256_CONFIG;

        // Assert
        expect(result.hexLength).toBe(64);
      });
    });
  });

  describe('Given SHA1_CONFIG', () => {
    describe('When reading algorithm', () => {
      it("Then returns 'sha1'", () => {
        // Arrange & Act
        const result = SHA1_CONFIG;

        // Assert
        expect(result.algorithm).toBe('sha1');
      });
    });
  });

  describe('Given SHA256_CONFIG', () => {
    describe('When reading algorithm', () => {
      it("Then returns 'sha256'", () => {
        // Arrange & Act
        const result = SHA256_CONFIG;

        // Assert
        expect(result.algorithm).toBe('sha256');
      });
    });
  });

  describe('Given the frozen hash configs', () => {
    describe('When comparing hexLength to digestLength', () => {
      it('Then SHA1_CONFIG hexLength is exactly twice digestLength', () => {
        // Arrange & Act
        const result = SHA1_CONFIG;

        // Assert
        expect(result.hexLength).toBe(result.digestLength * 2);
      });

      it('Then SHA256_CONFIG hexLength is exactly twice digestLength', () => {
        // Arrange & Act
        const result = SHA256_CONFIG;

        // Assert
        expect(result.hexLength).toBe(result.digestLength * 2);
      });
    });
  });
});
