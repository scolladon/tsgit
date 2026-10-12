import { describe, expect, it, vi } from 'vitest';

import { noopLogger, wrapLoggerSanitizer } from '../../../src/ports/logger.js';

describe('Logger port — noopLogger', () => {
  describe('Given noopLogger', () => {
    describe('When inspecting it', () => {
      it('Then it is frozen', () => {
        // Arrange & Act
        const result = Object.isFrozen(noopLogger);

        // Assert
        expect(result).toBe(true);
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

        // Act
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

        // Act
        const sut = wrapLoggerSanitizer(inner);
        sut.warn?.('m');

        // Assert — only the supplied level is exposed; the wrapper preserves
        // the optional-method contract by omitting levels that were not
        // supplied.
        expect(typeof sut.warn).toBe('function');
        expect(sut.debug).toBeUndefined();
        expect(sut.info).toBeUndefined();
        expect(sut.error).toBeUndefined();
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

        // Act
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

        // Act
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

        // Act
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

const nestObjects = (levels: number, leaf: unknown): unknown =>
  levels === 0 ? leaf : { next: nestObjects(levels - 1, leaf) };

describe('wrapLoggerSanitizer — nested context', () => {
  describe('Given a context whose array of objects carries attacker-controlled strings', () => {
    describe('When the wrapped logger is invoked', () => {
      it('Then every nested string reaches the sink sanitized', () => {
        // Arrange
        const inner = { error: vi.fn() };
        const sut = wrapLoggerSanitizer(inner);

        // Act
        sut.error?.('ambiguous', {
          candidates: [{ oid: 'abc', subject: 'evil\x1b[31m' }, ['deep\r']],
        });

        // Assert
        expect(inner.error).toHaveBeenCalledWith('ambiguous', {
          candidates: [{ oid: 'abc', subject: 'evil\\x1B[31m' }, ['deep\\x0D']],
        });
      });
    });
  });

  describe('Given a context nesting objects down to the depth bound', () => {
    describe('When the wrapped logger is invoked', () => {
      it('Then the string at the bound is sanitized', () => {
        // Arrange
        const inner = { info: vi.fn() };
        const sut = wrapLoggerSanitizer(inner);

        // Act
        sut.info?.('m', { root: nestObjects(15, 'x\x07') });

        // Assert
        expect(inner.info).toHaveBeenCalledWith('m', { root: nestObjects(15, 'x\\x07') });
      });
    });
  });

  describe('Given a context nesting objects past the depth bound', () => {
    describe('When the wrapped logger is invoked', () => {
      it('Then the container past the bound is replaced by the truncation marker', () => {
        // Arrange
        const inner = { info: vi.fn() };
        const sut = wrapLoggerSanitizer(inner);

        // Act
        sut.info?.('m', { root: nestObjects(16, 'x\x07') });

        // Assert
        expect(inner.info).toHaveBeenCalledWith('m', { root: nestObjects(15, '[Truncated]') });
      });
    });
  });

  describe('Given a context holding a cycle', () => {
    describe('When the wrapped logger is invoked', () => {
      it('Then the back-reference is replaced by the circular marker', () => {
        // Arrange
        const inner = { warn: vi.fn() };
        const sut = wrapLoggerSanitizer(inner);
        const looped: { s: string; self?: unknown; list?: unknown[] } = { s: 'a\x07' };
        looped.self = looped;
        looped.list = [looped];

        // Act
        sut.warn?.('m', { looped });

        // Assert
        expect(inner.warn).toHaveBeenCalledWith('m', {
          looped: { s: 'a\\x07', self: '[Circular]', list: ['[Circular]'] },
        });
      });
    });
  });

  describe('Given a context referencing one object from two siblings', () => {
    describe('When the wrapped logger is invoked', () => {
      it('Then both occurrences are sanitized rather than marked circular', () => {
        // Arrange
        const inner = { warn: vi.fn() };
        const sut = wrapLoggerSanitizer(inner);
        const shared = { s: 'b\x07' };

        // Act
        sut.warn?.('m', { left: shared, right: [shared] });

        // Assert
        expect(inner.warn).toHaveBeenCalledWith('m', {
          left: { s: 'b\\x07' },
          right: [{ s: 'b\\x07' }],
        });
      });
    });
  });

  describe('Given a context holding non-plain objects', () => {
    describe('When the wrapped logger is invoked', () => {
      it('Then they reach the sink by identity, not walked', () => {
        // Arrange
        const inner = { debug: vi.fn() };
        const sut = wrapLoggerSanitizer(inner);
        const bytes = new Uint8Array([7]);
        const when = new Date(0);

        // Act
        sut.debug?.('m', { nested: { bytes, when } });

        // Assert
        const received = inner.debug.mock.calls[0]?.[1] as { nested: Record<string, unknown> };
        expect(received.nested.bytes).toBe(bytes);
        expect(received.nested.when).toBe(when);
      });
    });
  });

  describe('Given a context nesting a null-prototype record', () => {
    describe('When the wrapped logger is invoked', () => {
      it('Then the record is walked like a plain object', () => {
        // Arrange
        const inner = { debug: vi.fn() };
        const sut = wrapLoggerSanitizer(inner);
        const bare: Record<string, unknown> = Object.create(null);
        bare.s = 'n\x07';

        // Act
        sut.debug?.('m', { bare });

        // Assert
        expect(inner.debug).toHaveBeenCalledWith('m', { bare: { s: 'n\\x07' } });
      });
    });
  });

  describe('Given a nested key that names the prototype slot or carries control bytes', () => {
    describe('When the wrapped logger is invoked', () => {
      it('Then the key stays an own property, sanitized, without touching the prototype', () => {
        // Arrange
        const inner = { debug: vi.fn() };
        const sut = wrapLoggerSanitizer(inner);
        const hostile = JSON.parse('{"__proto__":{"v":"p\\u0007"},"k\\u001b":"x"}') as unknown;

        // Act
        sut.debug?.('m', { hostile });

        // Assert
        const received = inner.debug.mock.calls[0]?.[1] as { hostile: object };
        expect(Object.getPrototypeOf(received.hostile)).toBe(Object.prototype);
        expect(Object.getOwnPropertyDescriptor(received.hostile, '__proto__')?.value).toEqual({
          v: 'p\\x07',
        });
        expect(Object.keys(received.hostile)).toEqual(['__proto__', 'k\\x1B']);
      });
    });
  });
});
