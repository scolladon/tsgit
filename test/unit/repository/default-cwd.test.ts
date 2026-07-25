import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultCwd } from '../../../src/repository/default-cwd.js';

describe('defaultCwd', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('Given a Node-like environment', () => {
    describe('When defaultCwd runs', () => {
      it('Then returns process.cwd()', () => {
        // Arrange
        vi.stubGlobal('process', { versions: { node: '20.3.0' }, cwd: () => '/some/dir' });

        // Act
        const result = defaultCwd();

        // Assert
        expect(result).toBe('/some/dir');
      });
    });
  });

  describe('Given a non-Node environment', () => {
    describe('When defaultCwd runs', () => {
      it("Then returns '/' as the deterministic browser/memory default", () => {
        // Arrange
        vi.stubGlobal('process', undefined);

        // Act
        const result = defaultCwd();

        // Assert
        expect(result).toBe('/');
      });
    });
  });

  describe("Given process exists but lacks own 'versions' (prototype-pollution defense)", () => {
    describe('When defaultCwd runs', () => {
      it("Then returns '/'", () => {
        // Arrange — versions on prototype only.
        const polluted = Object.create({
          versions: { node: 'fake' },
          cwd: () => '/should-not-use',
        });
        vi.stubGlobal('process', polluted);

        // Act
        const result = defaultCwd();

        // Assert
        expect(result).toBe('/');
      });
    });
  });
});
