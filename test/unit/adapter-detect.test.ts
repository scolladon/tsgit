import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { detectRuntime, isBrowser, isNode } from '../../src/adapter-detect.js';

describe('isNode', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('Given a process global shape', () => {
    describe('When isNode runs', () => {
      it.each([
        {
          process: { versions: { node: '20.3.0' } },
          expected: true,
          label: "typeof process is 'object' AND process.versions.node is set → returns true",
        },
        {
          process: undefined,
          expected: false,
          label: "typeof process is 'undefined' → returns false",
        },
        {
          process: { versions: Object.create({ node: 'fake' }) as Record<string, unknown> },
          expected: false,
          label:
            'process.versions is set but lacks own `node` property → returns false (Object.hasOwn rejects inherited)',
        },
        {
          process: Object.create({ versions: { node: 'fake' } }) as Record<string, unknown>,
          expected: false,
          label: 'process exists but lacks own `versions` property → returns false',
        },
        {
          process: { versions: undefined },
          expected: false,
          label: 'process.versions is undefined → returns false (no crash on missing versions)',
        },
      ])('Then $label', ({ process, expected }) => {
        // Arrange — attacker-style prototype pollution rows plant `node`/`versions`
        // on the prototype instead of the own object.
        vi.stubGlobal('process', process);
        const sut = isNode;

        // Assert
        expect(sut()).toBe(expected);
      });
    });
  });
});

describe('isBrowser', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('Given a window/navigator global shape', () => {
    describe('When isBrowser runs', () => {
      it.each([
        {
          window: {},
          navigator: {},
          expected: true,
          label: "typeof window is 'object' AND typeof navigator is 'object' → returns true",
        },
        {
          window: undefined,
          navigator: {},
          expected: false,
          label: 'window is undefined → returns false',
        },
        {
          window: {},
          navigator: undefined,
          expected: false,
          label: 'navigator is undefined → returns false',
        },
        {
          window: undefined,
          navigator: undefined,
          expected: false,
          label: 'both window and navigator are undefined → returns false',
        },
      ])('Then $label', ({ window, navigator, expected }) => {
        // Arrange
        vi.stubGlobal('window', window);
        vi.stubGlobal('navigator', navigator);
        const sut = isBrowser;

        // Assert
        expect(sut()).toBe(expected);
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

  describe('Given a process/window/navigator global shape', () => {
    describe('When detectRuntime runs', () => {
      it.each([
        {
          process: { versions: { node: '20.3.0' } },
          window: undefined,
          navigator: undefined,
          expected: 'node',
          label: "a Node-like environment → returns 'node'",
        },
        {
          process: undefined,
          window: {},
          navigator: {},
          expected: 'browser',
          label: "a browser-like environment (window + navigator, no process) → returns 'browser'",
        },
        {
          process: undefined,
          window: undefined,
          navigator: undefined,
          expected: 'memory',
          label: "neither node nor browser environment → returns 'memory'",
        },
        {
          process: { versions: { node: '20.3.0' } },
          window: {},
          navigator: {},
          expected: 'node',
          label: "BOTH a Node process AND a window → returns 'node' (node takes precedence)",
        },
      ])('Then $label', ({ process, window, navigator, expected }) => {
        // Arrange — the last row covers the order of the if-branches in
        // detectRuntime; mutating return order would flip that case.
        vi.stubGlobal('process', process);
        vi.stubGlobal('window', window);
        vi.stubGlobal('navigator', navigator);
        const sut = detectRuntime;

        // Assert
        expect(sut()).toBe(expected);
      });
    });
  });
});
