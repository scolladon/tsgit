import { describe, expect, it } from 'vitest';

import { SHA1_CONFIG, SHA256_CONFIG } from '../../../../src/domain/objects/hash-config.js';

describe('hash-config', () => {
  describe('Given SHA1_CONFIG', () => {
    describe('When reading digestLength', () => {
      it('Then returns 20', () => {
        // Arrange & Act
        const sut = SHA1_CONFIG;

        // Assert
        expect(sut.digestLength).toBe(20);
      });
    });
    describe('When reading hexLength', () => {
      it('Then returns 40', () => {
        // Arrange & Act
        const sut = SHA1_CONFIG;

        // Assert
        expect(sut.hexLength).toBe(40);
      });
    });
  });

  describe('Given SHA256_CONFIG', () => {
    describe('When reading digestLength', () => {
      it('Then returns 32', () => {
        // Arrange & Act
        const sut = SHA256_CONFIG;

        // Assert
        expect(sut.digestLength).toBe(32);
      });
    });
    describe('When reading hexLength', () => {
      it('Then returns 64', () => {
        // Arrange & Act
        const sut = SHA256_CONFIG;

        // Assert
        expect(sut.hexLength).toBe(64);
      });
    });
  });
});
