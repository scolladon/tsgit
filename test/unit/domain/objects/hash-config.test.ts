import { describe, expect, it } from 'vitest';

import { SHA1_CONFIG, SHA256_CONFIG } from '../../../../src/domain/objects/hash-config.js';

describe('hash-config', () => {
  it('Given SHA1_CONFIG, When reading digestLength, Then returns 20', () => {
    // Arrange & Act
    const sut = SHA1_CONFIG;

    // Assert
    expect(sut.digestLength).toBe(20);
  });

  it('Given SHA1_CONFIG, When reading hexLength, Then returns 40', () => {
    // Arrange & Act
    const sut = SHA1_CONFIG;

    // Assert
    expect(sut.hexLength).toBe(40);
  });

  it('Given SHA256_CONFIG, When reading digestLength, Then returns 32', () => {
    // Arrange & Act
    const sut = SHA256_CONFIG;

    // Assert
    expect(sut.digestLength).toBe(32);
  });

  it('Given SHA256_CONFIG, When reading hexLength, Then returns 64', () => {
    // Arrange & Act
    const sut = SHA256_CONFIG;

    // Assert
    expect(sut.hexLength).toBe(64);
  });
});
