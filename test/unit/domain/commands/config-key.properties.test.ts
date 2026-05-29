import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseConfigKey } from '../../../../src/domain/commands/config-key.js';

const arbSafeSection = (): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'),
      fc.string({
        minLength: 0,
        maxLength: 15,
        unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'),
      }),
    )
    .map(([head, tail]) => `${head}${tail}`);

const arbSafeKey = (): fc.Arbitrary<string> =>
  fc.tuple(arbSafeSection(), arbSafeSection()).map(([section, name]) => `${section}.${name}`);

describe('parseConfigKey properties', () => {
  describe('Given an arbitrary key in the safe two-part subset', () => {
    describe('When parseConfigKey runs', () => {
      it('Then it returns a result without throwing (totality)', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbSafeKey(), (key) => {
            expect(() => parseConfigKey(key)).not.toThrow();
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given the same arbitrary key parsed twice', () => {
    describe('When the two results are compared', () => {
      it('Then they are deeply equal (idempotence)', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbSafeKey(), (key) => {
            const first = parseConfigKey(key);
            const second = parseConfigKey(key);
            expect(first).toEqual(second);
          }),
          { numRuns: 50 },
        );
      });
    });
  });
});
