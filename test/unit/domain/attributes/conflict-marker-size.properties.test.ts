import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type AttributeValue, resolveMarkerSize } from '../../../../src/domain/attributes/index.js';

/** Any of the four attribute states a `conflict-marker-size` value can resolve to. */
const arbAttributeValue = (): fc.Arbitrary<AttributeValue> =>
  fc.oneof(
    fc.constant(true as const),
    fc.constant(false as const),
    fc.constant('unspecified' as const),
    fc.string().map((set) => ({ set })),
  );

describe('resolveMarkerSize (properties)', () => {
  describe('Given an arbitrary attribute value', () => {
    describe('When resolved', () => {
      it('Then it always returns a positive integer and never throws', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbAttributeValue(), (value) => {
            const result = resolveMarkerSize(value);
            return Number.isInteger(result) && result > 0;
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary positive integer string', () => {
    describe('When resolved', () => {
      it('Then the parsed integer is returned verbatim', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(fc.integer({ min: 1, max: 2147483647 }), (n) => {
            const result = resolveMarkerSize({ set: String(n) });
            expect(result).toBe(n);
          }),
          { numRuns: 200 },
        );
      });
    });
  });
});
