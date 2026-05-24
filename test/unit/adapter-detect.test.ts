import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { detectRuntime, isBrowser, isNode } from '../../src/adapter-detect.js';

describe('isNode', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("Given typeof process is 'object' AND process.versions.node is set", () => {
    describe('When isNode runs', () => {
      it('Then returns true', () => {
        // Arrange
        vi.stubGlobal('process', { versions: { node: '20.3.0' } });
        const sut = isNode;

        // Assert
        expect(sut()).toBe(true);
      });
    });
  });

  describe("Given typeof process is 'undefined'", () => {
    describe('When isNode runs', () => {
      it('Then returns false', () => {
        // Arrange
        vi.stubGlobal('process', undefined);
        const sut = isNode;

        // Assert
        expect(sut()).toBe(false);
      });
    });
  });

  describe('Given process.versions is set but lacks own `node` property', () => {
    describe('When isNode runs', () => {
      it('Then returns false (Object.hasOwn rejects inherited)', () => {
        // Arrange — attacker-style prototype pollution: `node` lives on the prototype, not the own object.
        const polluted = Object.create({ node: 'fake' }) as Record<string, unknown>;
        vi.stubGlobal('process', { versions: polluted });
        const sut = isNode;

        // Assert
        expect(sut()).toBe(false);
      });
    });
  });

  describe('Given process exists but lacks own `versions` property', () => {
    describe('When isNode runs', () => {
      it('Then returns false', () => {
        // Arrange — `versions` lives on the prototype only.
        const polluted = Object.create({ versions: { node: 'fake' } }) as Record<string, unknown>;
        vi.stubGlobal('process', polluted);
        const sut = isNode;

        // Assert
        expect(sut()).toBe(false);
      });
    });
  });

  describe('Given process.versions is undefined', () => {
    describe('When isNode runs', () => {
      it('Then returns false (no crash on missing versions)', () => {
        // Arrange
        vi.stubGlobal('process', { versions: undefined });
        const sut = isNode;

        // Assert
        expect(sut()).toBe(false);
      });
    });
  });
});

describe('isBrowser', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("Given typeof window is 'object' AND typeof navigator is 'object'", () => {
    describe('When isBrowser runs', () => {
      it('Then returns true', () => {
        // Arrange
        vi.stubGlobal('window', {});
        vi.stubGlobal('navigator', {});
        const sut = isBrowser;

        // Assert
        expect(sut()).toBe(true);
      });
    });
  });

  describe('Given window is undefined', () => {
    describe('When isBrowser runs', () => {
      it('Then returns false', () => {
        // Arrange
        vi.stubGlobal('window', undefined);
        vi.stubGlobal('navigator', {});
        const sut = isBrowser;

        // Assert
        expect(sut()).toBe(false);
      });
    });
  });

  describe('Given navigator is undefined', () => {
    describe('When isBrowser runs', () => {
      it('Then returns false', () => {
        // Arrange
        vi.stubGlobal('window', {});
        vi.stubGlobal('navigator', undefined);
        const sut = isBrowser;

        // Assert
        expect(sut()).toBe(false);
      });
    });
  });

  describe('Given both window and navigator are undefined', () => {
    describe('When isBrowser runs', () => {
      it('Then returns false', () => {
        // Arrange
        vi.stubGlobal('window', undefined);
        vi.stubGlobal('navigator', undefined);
        const sut = isBrowser;

        // Assert
        expect(sut()).toBe(false);
      });
    });
  });
});

describe('detectRuntime', () => {
  beforeEach(() => {
    // Default: nothing stubbed; tests stub explicitly to set up scenarios.
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('Given a Node-like environment', () => {
    describe('When detectRuntime runs', () => {
      it("Then returns 'node'", () => {
        // Arrange
        vi.stubGlobal('process', { versions: { node: '20.3.0' } });
        vi.stubGlobal('window', undefined);
        vi.stubGlobal('navigator', undefined);
        const sut = detectRuntime;

        // Assert
        expect(sut()).toBe('node');
      });
    });
  });

  describe('Given a browser-like environment (window + navigator, no process)', () => {
    describe('When detectRuntime runs', () => {
      it("Then returns 'browser'", () => {
        // Arrange
        vi.stubGlobal('process', undefined);
        vi.stubGlobal('window', {});
        vi.stubGlobal('navigator', {});
        const sut = detectRuntime;

        // Assert
        expect(sut()).toBe('browser');
      });
    });
  });

  describe('Given neither node nor browser environment', () => {
    describe('When detectRuntime runs', () => {
      it("Then returns 'memory'", () => {
        // Arrange
        vi.stubGlobal('process', undefined);
        vi.stubGlobal('window', undefined);
        vi.stubGlobal('navigator', undefined);
        const sut = detectRuntime;

        // Assert
        expect(sut()).toBe('memory');
      });
    });
  });

  describe('Given BOTH a Node process AND a window', () => {
    describe('When detectRuntime runs', () => {
      it("Then returns 'node' (node takes precedence)", () => {
        // Arrange — covers the order of the if-branches in detectRuntime; mutating return order would flip this case.
        vi.stubGlobal('process', { versions: { node: '20.3.0' } });
        vi.stubGlobal('window', {});
        vi.stubGlobal('navigator', {});
        const sut = detectRuntime;

        // Assert
        expect(sut()).toBe('node');
      });
    });
  });
});
