import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { detectRuntime, isBrowser, isNode } from '../../src/adapter-detect.js';

describe('isNode', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Given typeof process is 'object' AND process.versions.node is set, When isNode runs, Then returns true", () => {
    // Arrange
    vi.stubGlobal('process', { versions: { node: '20.3.0' } });
    const sut = isNode;

    // Assert
    expect(sut()).toBe(true);
  });

  it("Given typeof process is 'undefined', When isNode runs, Then returns false", () => {
    // Arrange
    vi.stubGlobal('process', undefined);
    const sut = isNode;

    // Assert
    expect(sut()).toBe(false);
  });

  it('Given process.versions is set but lacks own `node` property, When isNode runs, Then returns false (Object.hasOwn rejects inherited)', () => {
    // Arrange — attacker-style prototype pollution: `node` lives on the prototype, not the own object.
    const polluted = Object.create({ node: 'fake' }) as Record<string, unknown>;
    vi.stubGlobal('process', { versions: polluted });
    const sut = isNode;

    // Assert
    expect(sut()).toBe(false);
  });

  it('Given process exists but lacks own `versions` property, When isNode runs, Then returns false', () => {
    // Arrange — `versions` lives on the prototype only.
    const polluted = Object.create({ versions: { node: 'fake' } }) as Record<string, unknown>;
    vi.stubGlobal('process', polluted);
    const sut = isNode;

    // Assert
    expect(sut()).toBe(false);
  });

  it('Given process.versions is undefined, When isNode runs, Then returns false (no crash on missing versions)', () => {
    // Arrange
    vi.stubGlobal('process', { versions: undefined });
    const sut = isNode;

    // Assert
    expect(sut()).toBe(false);
  });
});

describe('isBrowser', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Given typeof window is 'object' AND typeof navigator is 'object', When isBrowser runs, Then returns true", () => {
    // Arrange
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {});
    const sut = isBrowser;

    // Assert
    expect(sut()).toBe(true);
  });

  it('Given window is undefined, When isBrowser runs, Then returns false', () => {
    // Arrange
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('navigator', {});
    const sut = isBrowser;

    // Assert
    expect(sut()).toBe(false);
  });

  it('Given navigator is undefined, When isBrowser runs, Then returns false', () => {
    // Arrange
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', undefined);
    const sut = isBrowser;

    // Assert
    expect(sut()).toBe(false);
  });

  it('Given both window and navigator are undefined, When isBrowser runs, Then returns false', () => {
    // Arrange
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('navigator', undefined);
    const sut = isBrowser;

    // Assert
    expect(sut()).toBe(false);
  });
});

describe('detectRuntime', () => {
  beforeEach(() => {
    // Default: nothing stubbed; tests stub explicitly to set up scenarios.
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Given a Node-like environment, When detectRuntime runs, Then returns 'node'", () => {
    // Arrange
    vi.stubGlobal('process', { versions: { node: '20.3.0' } });
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('navigator', undefined);
    const sut = detectRuntime;

    // Assert
    expect(sut()).toBe('node');
  });

  it("Given a browser-like environment (window + navigator, no process), When detectRuntime runs, Then returns 'browser'", () => {
    // Arrange
    vi.stubGlobal('process', undefined);
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {});
    const sut = detectRuntime;

    // Assert
    expect(sut()).toBe('browser');
  });

  it("Given neither node nor browser environment, When detectRuntime runs, Then returns 'memory'", () => {
    // Arrange
    vi.stubGlobal('process', undefined);
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('navigator', undefined);
    const sut = detectRuntime;

    // Assert
    expect(sut()).toBe('memory');
  });

  it("Given BOTH a Node process AND a window, When detectRuntime runs, Then returns 'node' (node takes precedence)", () => {
    // Arrange — covers the order of the if-branches in detectRuntime; mutating return order would flip this case.
    vi.stubGlobal('process', { versions: { node: '20.3.0' } });
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {});
    const sut = detectRuntime;

    // Assert
    expect(sut()).toBe('node');
  });
});
