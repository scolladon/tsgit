import { describe, expect, it, vi } from 'vitest';

import { noopLogger, wrapLoggerSanitizer } from '../../../src/ports/logger.js';

describe('Logger port — noopLogger', () => {
  describe('Given noopLogger', () => {
    describe('When inspecting it', () => {
      it('Then it is frozen', () => {
        // Arrange
        const sut = Object.isFrozen(noopLogger);

        // Assert
        expect(sut).toBe(true);
      });
    });
    describe('When reading any level method', () => {
      it('Then it is undefined', () => {
        // Arrange + Assert
        expect(noopLogger.debug).toBeUndefined();
        expect(noopLogger.info).toBeUndefined();
        expect(noopLogger.warn).toBeUndefined();
        expect(noopLogger.error).toBeUndefined();
      });
    });
  });
});

describe('wrapLoggerSanitizer — passthrough', () => {
  describe('Given a logger with all four levels', () => {
    describe('When the wrapper is created', () => {
      it('Then every level is present and the wrapper is frozen', () => {
        // Arrange
        const inner = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

        const sut = wrapLoggerSanitizer(inner);

        // Assert
        expect(typeof sut.debug).toBe('function');
        expect(typeof sut.info).toBe('function');
        expect(typeof sut.warn).toBe('function');
        expect(typeof sut.error).toBe('function');
        expect(Object.isFrozen(sut)).toBe(true);
      });
    });
  });

  describe('Given a logger with only `warn`', () => {
    describe('When the wrapper is created', () => {
      it('Then only `warn` is present (other levels stay absent)', () => {
        // Arrange
        const inner = { warn: vi.fn() };

        const sut = wrapLoggerSanitizer(inner);

        // Assert — only the supplied level is exposed; the wrapper preserves
        // the optional-method contract by omitting levels that were not
        // supplied.
        expect(typeof sut.warn).toBe('function');
        expect(sut.debug).toBeUndefined();
        expect(sut.info).toBeUndefined();
        expect(sut.error).toBeUndefined();
        sut.warn?.('m');
        expect(inner.warn).toHaveBeenCalledWith('m', undefined);
      });
    });
  });
});

describe('wrapLoggerSanitizer — sanitization', () => {
  describe('Given a message with control bytes', () => {
    describe('When the wrapped logger is invoked', () => {
      it('Then the inner sink receives the sanitized form', () => {
        // Arrange
        const inner = { warn: vi.fn() };
        const sut = wrapLoggerSanitizer(inner);

        sut.warn?.('hello\x07world');

        // Assert
        expect(inner.warn).toHaveBeenCalledWith('hello\\x07world', undefined);
      });
    });
  });

  describe('Given a context with string values containing control bytes', () => {
    describe('When the wrapped logger is invoked', () => {
      it('Then string values are sanitized in-place', () => {
        // Arrange
        const inner = { error: vi.fn() };
        const sut = wrapLoggerSanitizer(inner);

        sut.error?.('msg', { user: 'evil\x1bdata', count: 42 });

        // Assert
        expect(inner.error).toHaveBeenCalledWith('msg', { user: 'evil\\x1Bdata', count: 42 });
      });
    });
  });

  describe('Given an undefined context', () => {
    describe('When the wrapped logger is invoked', () => {
      it('Then the inner sink receives undefined for context', () => {
        // Arrange
        const inner = { info: vi.fn() };
        const sut = wrapLoggerSanitizer(inner);

        sut.info?.('msg');

        // Assert
        expect(inner.info).toHaveBeenCalledWith('msg', undefined);
      });
    });
  });
});

describe('wrapLoggerSanitizer — robustness', () => {
  describe('Given an inner sink that throws', () => {
    describe('When the wrapper is invoked', () => {
      it('Then no exception escapes the wrapper', () => {
        // Arrange
        const inner = {
          warn: vi.fn(() => {
            throw new Error('boom');
          }),
        };
        const sut = wrapLoggerSanitizer(inner);

        // Assert
        expect(() => sut.warn?.('any')).not.toThrow();
      });
    });
  });
});
