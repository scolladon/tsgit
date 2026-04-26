import { describe, expect, it, vi } from 'vitest';

import { noopLogger, wrapLoggerSanitizer } from '../../../src/ports/logger.js';

describe('Logger port — noopLogger', () => {
  it('Given noopLogger, When inspecting it, Then it is frozen', () => {
    expect(Object.isFrozen(noopLogger)).toBe(true);
  });

  it('Given noopLogger, When reading any level method, Then it is undefined', () => {
    expect(noopLogger.debug).toBeUndefined();
    expect(noopLogger.info).toBeUndefined();
    expect(noopLogger.warn).toBeUndefined();
    expect(noopLogger.error).toBeUndefined();
  });
});

describe('wrapLoggerSanitizer — passthrough', () => {
  it('Given a logger with all four levels, When the wrapper is created, Then every level is present and the wrapper is frozen', () => {
    const inner = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const sut = wrapLoggerSanitizer(inner);

    expect(typeof sut.debug).toBe('function');
    expect(typeof sut.info).toBe('function');
    expect(typeof sut.warn).toBe('function');
    expect(typeof sut.error).toBe('function');
    expect(Object.isFrozen(sut)).toBe(true);
  });

  it('Given a logger with only `warn`, When the wrapper is created, Then only `warn` is present (other levels stay absent)', () => {
    const inner = { warn: vi.fn() };

    const sut = wrapLoggerSanitizer(inner);

    expect(sut.warn).toBeDefined();
    expect(sut.debug).toBeUndefined();
    expect(sut.info).toBeUndefined();
    expect(sut.error).toBeUndefined();
  });
});

describe('wrapLoggerSanitizer — sanitization', () => {
  it('Given a message with control bytes, When the wrapped logger is invoked, Then the inner sink receives the sanitized form', () => {
    const inner = { warn: vi.fn() };
    const sut = wrapLoggerSanitizer(inner);

    sut.warn?.('hello\x07world');

    expect(inner.warn).toHaveBeenCalledWith('hello\\x07world', undefined);
  });

  it('Given a context with string values containing control bytes, When the wrapped logger is invoked, Then string values are sanitized in-place', () => {
    const inner = { error: vi.fn() };
    const sut = wrapLoggerSanitizer(inner);

    sut.error?.('msg', { user: 'evil\x1bdata', count: 42 });

    expect(inner.error).toHaveBeenCalledWith('msg', { user: 'evil\\x1Bdata', count: 42 });
  });

  it('Given an undefined context, When the wrapped logger is invoked, Then the inner sink receives undefined for context', () => {
    const inner = { info: vi.fn() };
    const sut = wrapLoggerSanitizer(inner);

    sut.info?.('msg');

    expect(inner.info).toHaveBeenCalledWith('msg', undefined);
  });
});

describe('wrapLoggerSanitizer — robustness', () => {
  it('Given an inner sink that throws, When the wrapper is invoked, Then no exception escapes the wrapper', () => {
    const inner = {
      warn: vi.fn(() => {
        throw new Error('boom');
      }),
    };
    const sut = wrapLoggerSanitizer(inner);

    expect(() => sut.warn?.('any')).not.toThrow();
  });
});
