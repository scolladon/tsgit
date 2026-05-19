import { describe, expect, it } from 'vitest';

import { isWindows } from '../../../../src/adapters/node/platform.js';

describe('platform indirection', () => {
  describe('isWindows', () => {
    it('Given the host platform, When isWindows is called, Then it reflects process.platform', () => {
      // Arrange — no setup; isWindows is a pure function over the global.

      // Act
      const sut = isWindows();

      // Assert — true on win32, false elsewhere; we don't depend on the actual host.
      expect(sut).toBe(process.platform === 'win32');
    });
  });
});
