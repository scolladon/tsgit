import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultCwd } from '../../../src/repository/default-cwd.js';

describe('defaultCwd', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Given a Node-like environment, When defaultCwd runs, Then returns process.cwd()', () => {
    // Arrange
    vi.stubGlobal('process', { versions: { node: '20.3.0' }, cwd: () => '/some/dir' });
    const sut = defaultCwd;

    // Assert
    expect(sut()).toBe('/some/dir');
  });

  it("Given a non-Node environment, When defaultCwd runs, Then returns '/' as the deterministic browser/memory default", () => {
    // Arrange
    vi.stubGlobal('process', undefined);
    const sut = defaultCwd;

    // Assert
    expect(sut()).toBe('/');
  });

  it("Given process exists but lacks own 'versions' (prototype-pollution defense), When defaultCwd runs, Then returns '/'", () => {
    // Arrange — versions on prototype only.
    const polluted = Object.create({ versions: { node: 'fake' }, cwd: () => '/should-not-use' });
    vi.stubGlobal('process', polluted);
    const sut = defaultCwd;

    // Assert
    expect(sut()).toBe('/');
  });
});
