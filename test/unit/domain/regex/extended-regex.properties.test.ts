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

const QUANTIFIERS = ['*', '+', '?', '{2}', '{0,2}', '{1,}', '{,1}', '{0}', '{1}'];
const QUANTIFIER = fc.constantFrom(...QUANTIFIERS);

const alphanumeric = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789');

/** A small pattern and its ECMAScript spelling, written apart from the parser under test. */
interface Spelling {
  readonly ere: string;
  readonly ecma: string;
}

const spelt = (ere: string, ecma = ere): Spelling => ({ ere, ecma });

const joined =
  (separator: string) =>
  (spellings: ReadonlyArray<Spelling>): Spelling =>
    spelt(
      spellings.map(({ ere }) => ere).join(separator),
      spellings.map(({ ecma }) => ecma).join(separator),
    );

const WORD = '[\\p{L}\\p{N}_]';
const WORD_START = `(?<!${WORD})(?=${WORD})`;
const WORD_END = `(?<=${WORD})(?!${WORD})`;
/**
 * RegExp also tries the position inside a surrogate pair, where no lookaround
 * reads a character; git only stands between characters.
 */
const BETWEEN_CHARACTERS = '(?:^|(?<=[^]))';

const SPELT_QUANTIFIER = fc.constantFrom(
  ...QUANTIFIERS.map((quantifier) => spelt(quantifier, quantifier.replace('{,', '{0,'))),
);
const LEAF_ATOM = fc.constantFrom(
  spelt('a'),
  spelt('b'),
  spelt('é'),
  spelt('\u{1F600}'),
  spelt('.'),
  spelt('[ab]'),
  spelt('[^a]'),
  spelt('\\w', WORD),
  spelt('\\W', '[^\\p{L}\\p{N}_]'),
  spelt('\\s'),
);
const ANCHOR = fc.constantFrom(
  spelt('^'),
  spelt('$'),
  spelt('\\<', WORD_START),
  spelt('\\>', WORD_END),
  spelt('\\b', `(?:${WORD_START}|${WORD_END})`),
  spelt('\\B', `(?:(?<=${WORD})(?=${WORD})|${BETWEEN_CHARACTERS}(?<!${WORD})(?!${WORD}))`),
);
const NESTING = 2;
/**
 * Repetitions stacked on one atom. RegExp backtracks through every nested
 * loop, so deeper stacks time it out on a subject; stacking itself has its own
 * property below.
 */
const MAX_STACKED = 1;

/** Each repetition applies to everything before it: `a*?` is `(?:(?:a)*)?`. */
const repeated = ([atom, quantifiers]: [Spelling, ReadonlyArray<Spelling>]): Spelling =>
  quantifiers.reduce(
    (inner, quantifier) =>
      spelt(`${inner.ere}${quantifier.ere}`, `(?:${inner.ecma})${quantifier.ecma}`),
    atom,
  );

/** Small extended regexes without back-references, over a few letters, groups nested up to `depth`. */
const smallPattern = (depth: number): fc.Arbitrary<Spelling> => {
  const atom =
    depth === 0
      ? LEAF_ATOM
      : fc.oneof(
          LEAF_ATOM,
          smallPattern(depth - 1).map(({ ere, ecma }) => spelt(`(${ere})`, `(${ecma})`)),
        );
  const expression = fc.oneof(
    { arbitrary: ANCHOR, weight: 1 },
    {
      arbitrary: fc
        .tuple(atom, fc.array(SPELT_QUANTIFIER, { maxLength: MAX_STACKED }))
        .map(repeated),
      weight: 4,
    },
  );
  const branch = fc.array(expression, { maxLength: 4 }).map(joined(''));
  return fc.array(branch, { minLength: 1, maxLength: 3 }).map(joined('|'));
};

/** Expressions over the leaf atoms and back-references to the first `groups` groups, each maybe repeated. */
const backreferencing = (groups: number): fc.Arbitrary<Spelling> => {
  const references = Array.from({ length: groups }, (_, index) => spelt(`\\${index + 1}`));
  const atom = fc.oneof(LEAF_ATOM, fc.constantFrom(...references));
  const expression = fc
    .tuple(atom, fc.array(SPELT_QUANTIFIER, { maxLength: MAX_STACKED }))
    .map(repeated);
  return fc.array(expression, { maxLength: 3 }).map(joined(''));
};

/**
 * `(P)Q(R)S`: Q may read group 1 again, S groups 1 and 2. P holds no group,
 * so both named groups stand outside every repetition and alternative: every
 * path through them sets them, once — where RegExp, which reads an unset
 * group as empty and forgets a group each repetition copy, answers as glibc
 * does. Groups nest one level inside R and repetitions do not stack, so
 * RegExp settles each small subject in few steps.
 */
const backreferencePattern: fc.Arbitrary<Spelling> = fc
  .tuple(smallPattern(0), backreferencing(1), smallPattern(1), backreferencing(2))
  .map(([first, between, second, after]) =>
    spelt(
      `(${first.ere})${between.ere}(${second.ere})${after.ere}`,
      `(${first.ecma})${between.ecma}(${second.ecma})${after.ecma}`,
    ),
  );

const answers = (ecma: string, subject: string): boolean => new RegExp(ecma, 'su').test(subject);

/** A subject over the characters the small patterns tell apart, a word character past the BMP among them. */
const smallSubject = fc
  .array(fc.constantFrom('a', 'b', 'é', '\u{1F600}', '\u{1D400}', ' ', '\n'), { maxLength: 8 })
  .map((characters) => characters.join(''));

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
    describe('When the compiled matcher and RegExp match it', () => {
      it('Then both answer alike', () => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act / Assert
        fc.assert(
          fc.property(smallPattern(NESTING), smallSubject, ({ ere, ecma }, subject) => {
            const result = sut(ere)?.test(subject);
            return result === answers(ecma, subject);
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given a small pattern followed by a back-reference to it and a small subject', () => {
    describe('When the compiled matcher and RegExp match it', () => {
      it('Then both answer alike', () => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act / Assert
        fc.assert(
          fc.property(smallPattern(NESTING), smallSubject, ({ ere, ecma }, subject) => {
            const result = sut(`(${ere})\\1`)?.test(subject);
            return result === answers(`(${ecma})\\1`, subject);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given small patterns reading groups again, repeated or not, and a small subject', () => {
    describe('When the compiled matcher and RegExp match it', () => {
      it('Then both answer alike', () => {
        // Arrange
        const sut = compileExtendedRegex;

        // Act / Assert
        fc.assert(
          fc.property(backreferencePattern, smallSubject, ({ ere, ecma }, subject) => {
            const result = sut(ere)?.test(subject);
            return result === answers(ecma, subject);
          }),
          { numRuns: 100 },
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
