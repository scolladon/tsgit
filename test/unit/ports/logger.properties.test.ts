/**
 * Property tests for the logger sanitiser's context walk: whatever shape a
 * payload takes within the walked depth, no key or string reaching the sink
 * carries a control byte, and a payload that is already printable passes
 * through structurally unchanged.
 */
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { wrapLoggerSanitizer } from '../../../src/ports/logger.js';

const INVARIANT_NUM_RUNS = 100;
const WALKED_DEPTH = 10;
const SINK_SAFE = /^[\t\n\x20-\x7e]*$/;
const PRINTABLE_UNIT = fc
  .integer({ min: 0x20, max: 0x7e })
  .map((code) => String.fromCharCode(code));

const collectStrings = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...collectStrings(child)]);
};

const deliver = (payload: unknown): unknown => {
  const inner = { warn: vi.fn() };
  const sut = wrapLoggerSanitizer(inner);
  sut.warn?.('m', { payload });
  return inner.warn.mock.calls[0]?.[1];
};

describe('Given an arbitrary nested payload of binary strings', () => {
  describe('When the wrapped logger forwards it', () => {
    it('Then every key and string the sink receives is free of control bytes', () => {
      // Arrange
      const payloads = fc.jsonValue({ maxDepth: WALKED_DEPTH, stringUnit: 'binary' });

      // Act + Assert
      fc.assert(
        fc.property(payloads, (payload) =>
          collectStrings(deliver(payload)).every((text) => SINK_SAFE.test(text)),
        ),
        { numRuns: INVARIANT_NUM_RUNS },
      );
    });
  });
});

describe('Given an arbitrary nested payload of printable strings', () => {
  describe('When the wrapped logger forwards it', () => {
    it('Then the sink receives a structurally equal payload', () => {
      // Arrange
      const payloads = fc.jsonValue({ maxDepth: WALKED_DEPTH, stringUnit: PRINTABLE_UNIT });

      // Act + Assert
      fc.assert(
        fc.property(payloads, (payload) => {
          expect(deliver(payload)).toStrictEqual({ payload });
        }),
        { numRuns: INVARIANT_NUM_RUNS },
      );
    });
  });
});
