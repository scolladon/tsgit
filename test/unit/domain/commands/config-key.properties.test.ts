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

  describe('Given an arbitrary key with an empty section and a subsection', () => {
    describe('When parseConfigKey runs', () => {
      it('Then it never throws (totality), maps subsection and name structurally, and re-parses identically', () => {
        // Arrange — generator produces ..name and .sub.name forms, carrying
        // the expected structural parts alongside the raw key
        const arbEmptySectionKey = fc.oneof(
          arbSafeSection().map((name) => ({ key: `..${name}`, subsection: '', name })),
          fc
            .tuple(arbSafeSection(), arbSafeSection())
            .map(([sub, name]) => ({ key: `.${sub}.${name}`, subsection: sub, name })),
        );

        // Act + Assert
        fc.assert(
          fc.property(arbEmptySectionKey, ({ key, subsection, name }) => {
            // Totality: must not throw
            const first = parseConfigKey(key);

            // Structural mapping: empty section, verbatim subsection, name
            expect(first.section).toBe('');
            expect(first.subsection).toBe(subsection);
            expect(first.name).toBe(name);

            // Determinism: parsing the same key twice yields the same result
            const second = parseConfigKey(key);
            expect(first).toEqual(second);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
