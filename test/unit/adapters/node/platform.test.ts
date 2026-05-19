import { describe, expect, it } from 'vitest';

import { isWindows } from '../../../../src/adapters/node/platform.js';

describe('platform indirection', () => {
  describe('isWindows', () => {
    it('Given the host platform, When isWindows is called, Then it reflects process.platform', () => {
      // Arrange
      const sut = isWindows;

      // Act
      const result = sut();

      // Assert — true on win32, false elsewhere; we don't depend on the actual host.
      expect(result).toBe(process.platform === 'win32');
    });
  });
});
