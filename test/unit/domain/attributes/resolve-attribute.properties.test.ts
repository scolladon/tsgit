import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { AttributeSource } from '../../../../src/domain/attributes/index.js';
import {
  BUILTIN_MACROS,
  parseGitattributes,
  resolveAttribute,
} from '../../../../src/domain/attributes/index.js';
import { arbAttributeName } from './arbitraries.js';

const arbValue = (): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...'abc012'.split('')), { minLength: 1, maxLength: 6 })
    .map((c) => c.join(''));

const sourcesFrom = (text: string): ReadonlyArray<AttributeSource> => [
  { basedir: '', rules: parseGitattributes(text).rules },
];

describe('resolve-attribute properties', () => {
  describe('Given no sources', () => {
    describe('When resolving any attribute name', () => {
      it("Then the verdict is always 'unspecified' (identity)", () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbAttributeName(), (name) => {
            expect(resolveAttribute([], 'a.txt', name, BUILTIN_MACROS)).toBe('unspecified');
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a single `* <name>=<value>` rule', () => {
    describe('When resolving that name', () => {
      it('Then the verdict is the set value', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbAttributeName(), arbValue(), (name, value) => {
            const sources = sourcesFrom(`* ${name}=${value}`);
            expect(resolveAttribute(sources, 'a.txt', name, BUILTIN_MACROS)).toEqual({
              set: value,
            });
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a set rule followed by a negating (`!name`) rule', () => {
    describe('When resolving that name', () => {
      it("Then the trailing negation flips the verdict back to 'unspecified'", () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbAttributeName(), arbValue(), (name, value) => {
            const sources = sourcesFrom(`* ${name}=${value}\n* !${name}`);
            expect(resolveAttribute(sources, 'a.txt', name, BUILTIN_MACROS)).toBe('unspecified');
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
