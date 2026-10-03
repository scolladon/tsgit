import fc from 'fast-check';
import { describe, it } from 'vitest';
import { compileExtendedRegex } from '../../../../src/domain/regex/extended-regex.js';

/** The characters an extended regex gives a meaning to outside a bracket. */
const ERE_SPECIALS = new Set([
  '.',
  '[',
  ']',
  '(',
  ')',
  '*',
  '+',
  '?',
  '{',
  '}',
  '|',
  '^',
  '$',
  '\\',
]);

/** Independent oracle: backslash every special, leaving every other character as itself. */
const escapeLiterally = (text: string): string =>
  Array.from(text, (ch) => (ERE_SPECIALS.has(ch) ? `\\${ch}` : ch)).join('');

const alphanumeric = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789');

describe('compileExtendedRegex properties', () => {
  describe('Given an arbitrary pattern', () => {
    describe('When it is compiled', () => {
      it('Then it yields a matcher or a refusal, never a throw', () => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act / Assert
        fc.assert(
          fc.property(fc.string({ unit: 'binary' }), (pattern) => {
            const result = sut(pattern);
            return result === undefined || result instanceof RegExp;
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary text spelt literally', () => {
    describe('When the anchored pattern is matched against that text', () => {
      it('Then it matches it and refuses the text with one more character', () => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act / Assert
        fc.assert(
          fc.property(fc.string({ unit: 'binary' }), (text) => {
            const result = sut(`^${escapeLiterally(text)}$`);
            return result?.test(text) === true && !result.test(`${text}x`);
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary bracket of alphanumerics', () => {
    describe('When a character is matched against it and its negation', () => {
      it('Then exactly one of them matches, the bracket iff it lists the character', () => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act / Assert
        fc.assert(
          fc.property(fc.array(alphanumeric, { minLength: 1 }), alphanumeric, (members, ch) => {
            const listed = sut(`[${members.join('')}]`)?.test(ch);
            const unlisted = sut(`[^${members.join('')}]`)?.test(ch);
            return listed === members.includes(ch) && unlisted === !listed;
          }),
        );
      });
    });
  });

  describe('Given an arbitrary interval bound and run length', () => {
    describe('When the run is matched against the anchored interval', () => {
      it('Then it matches iff the run length equals the bound', () => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act / Assert
        fc.assert(
          fc.property(fc.nat(40), fc.nat(40), (bound, length) => {
            const result = sut(`^a{${bound}}$`)?.test('a'.repeat(length));
            return result === (bound === length);
          }),
        );
      });
    });
  });
});
