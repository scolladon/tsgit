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

const QUANTIFIER = fc.constantFrom('*', '+', '?', '{2}', '{0,2}', '{1,}', '{,1}', '{0}', '{1}');

const alphanumeric = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789');

const LEAF_ATOM = fc.constantFrom('a', 'b', '.', '[ab]', '[^a]', '\\w', '\\W', '\\s');
const ANCHOR = fc.constantFrom('^', '$', '\\<', '\\>', '\\b', '\\B');
const NESTING = 2;

/** Small extended regexes without back-references over `a` and `b`, groups nested up to `depth`. */
const smallPattern = (depth: number): fc.Arbitrary<string> => {
  const atom =
    depth === 0
      ? LEAF_ATOM
      : fc.oneof(
          LEAF_ATOM,
          smallPattern(depth - 1).map((inner) => `(${inner})`),
        );
  const expression = fc.oneof(
    { arbitrary: ANCHOR, weight: 1 },
    {
      arbitrary: fc
        .tuple(atom, fc.array(QUANTIFIER, { maxLength: 2 }))
        .map(([repeated, quantifiers]) => `${repeated}${quantifiers.join('')}`),
      weight: 4,
    },
  );
  const branch = fc.array(expression, { maxLength: 4 }).map((pieces) => pieces.join(''));
  return fc.array(branch, { minLength: 1, maxLength: 3 }).map((branches) => branches.join('|'));
};

/** A subject over the characters the small patterns tell apart. */
const smallSubject = fc
  .array(fc.constantFrom('a', 'b', ' ', '\n'), { maxLength: 8 })
  .map((characters) => characters.join(''));

/** The same pattern with a back-reference in front, so it runs as its ECMAScript translation. */
const backtracking = (pattern: string): string => `()\\1(${pattern})`;

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
            return result === undefined || typeof result.test('') === 'boolean';
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

  describe('Given a small pattern without back-references and a small subject', () => {
    describe('When the automaton and the backtracking translation match it', () => {
      it('Then both answer alike', () => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act / Assert
        fc.assert(
          fc.property(smallPattern(NESTING), smallSubject, (pattern, subject) => {
            const result = sut(pattern)?.test(subject);
            return result === sut(backtracking(pattern))?.test(subject);
          }),
          { numRuns: 300 },
        );
      });
    });
  });

  describe('Given two stacked repetitions of a character', () => {
    describe('When a run is matched against them stacked and with the inner one grouped', () => {
      it('Then both answer alike', () => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act / Assert
        fc.assert(
          fc.property(QUANTIFIER, QUANTIFIER, fc.nat(6), (inner, outer, length) => {
            const run = 'a'.repeat(length);
            const result = sut(`^a${inner}${outer}$`)?.test(run);
            return result === sut(`^(a${inner})${outer}$`)?.test(run);
          }),
        );
      });
    });
  });
});
