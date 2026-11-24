import { describe, expect, it } from 'vitest';
import {
  matchWildmatch,
  tokenizeWildmatch,
  type WildmatchFlags,
} from '../../../../src/domain/glob/wildmatch.js';
import { encode } from '../../../../src/domain/objects/encoding.js';
import { asciiLower } from '../../../../src/domain/pretty/ascii.js';

const wildmatch = (pattern: string, text: string, flags: WildmatchFlags): boolean => {
  const tokens = tokenizeWildmatch(encode(pattern), flags);
  if (tokens === undefined) return false;
  return matchWildmatch(tokens, encode(flags.caseFold ? asciiLower(text) : text));
};

const FLAGS_0: WildmatchFlags = { pathname: false, caseFold: false };
const PATHNAME: WildmatchFlags = { pathname: true, caseFold: false };
const FOLD: WildmatchFlags = { pathname: false, caseFold: true };

describe('wildmatch', () => {
  describe('Given the flags-0 dialect', () => {
    describe('When matching', () => {
      it.each([
        ['a*b', 'a/x/b', true],
        ['?', '/', true],
        ['\\*', '*', true],
        ['\\*', 'x', false],
        ['[a-c]', 'b', true],
        ['[a-c]', 'd', false],
      ])('Then %j against %j gives %s', (pattern, text, expected) => {
        // Arrange
        const sut = wildmatch;

        // Act
        const result = sut(pattern, text, FLAGS_0);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given the WM_PATHNAME dialect', () => {
    describe('When matching', () => {
      it.each([
        ['a*b', 'a/x/b', false],
        ['?', '/', false],
        ['**/b', 'b', true],
        ['**/b', 'x/y/b', true],
        ['**\\/b', 'b', false],
        ['**\\/b', 'x/b', true],
        ['\\*', '*', true],
        ['\\*', 'x', false],
        ['[a-c]', 'b', true],
        ['[a-c]', 'd', false],
      ])('Then %j against %j gives %s', (pattern, text, expected) => {
        // Arrange
        const sut = wildmatch;

        // Act
        const result = sut(pattern, text, PATHNAME);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given the WM_PATHNAME dialect and bracket expressions', () => {
    describe('When matching negation marker', () => {
      it.each([
        ['[!a]', 'a', false],
        ['[!a]', 'b', true],
        ['[!a]', '!', true],
        ['[^a]', '^', true],
        ['[^a]', 'a', false],
        ['[a!]', '!', true],
        ['[a!]', 'b', false],
      ])('Then %j against %j gives %s', (pattern, text, expected) => {
        // Arrange
        const sut = wildmatch;

        // Act
        const result = sut(pattern, text, PATHNAME);

        // Assert
        expect(result).toBe(expected);
      });
    });
    describe('When matching a first closing bracket', () => {
      it.each([
        ['[]a]', ']', true],
        ['[]a]', 'b', false],
        ['[!]a]', ']', false],
        ['[!]a]', 'b', true],
        ['[]-a]', ']', true],
        ['[]-a]', '^', true],
        ['[]-a]', 'a', true],
        ['[]-a]', '-', false],
        ['[]-a]', 'b', false],
      ])('Then %j against %j gives %s', (pattern, text, expected) => {
        // Arrange
        const sut = wildmatch;

        // Act
        const result = sut(pattern, text, PATHNAME);

        // Assert
        expect(result).toBe(expected);
      });
    });
    describe('When matching an escaped member', () => {
      it.each([
        ['[\\]]', ']', true],
        ['[\\]]', '\\', false],
        ['[a-\\c]', 'b', true],
        ['[a-\\c]', '\\', false],
        ['[\\a-c]', 'b', true],
        ['[\\a-c]', '\\', false],
      ])('Then %j against %j gives %s', (pattern, text, expected) => {
        // Arrange
        const sut = wildmatch;

        // Act
        const result = sut(pattern, text, PATHNAME);

        // Assert
        expect(result).toBe(expected);
      });
    });
    describe('When matching a range', () => {
      it.each([
        ['[c-a]', 'c', true],
        ['[c-a]', 'a', false],
        ['[c-a]', 'b', false],
        ['[a-c-e]', 'b', true],
        ['[a-c-e]', '-', true],
        ['[a-c-e]', 'e', true],
        ['[a-c-e]', 'd', false],
        ['x[--0]', 'x.', true],
        ['x[--0]', 'x-', true],
        ['x[--0]', 'x,', false],
        ['x[--0]', 'x1', false],
      ])('Then %j against %j gives %s', (pattern, text, expected) => {
        // Arrange
        const sut = wildmatch;

        // Act
        const result = sut(pattern, text, PATHNAME);

        // Assert
        expect(result).toBe(expected);
      });
    });
    describe('When matching a class opener without a closing name', () => {
      it.each([
        ['[[:alpha]', '[', true],
        ['[[:alpha]', 'a', true],
        ['[[:alpha]', 'p', true],
        ['[[:alpha]', ':', true],
        ['[[:alpha]', 'x', false],
        ['[[:]]', '[]', true],
        ['[[:]]', ':]', true],
        ['[[:]]', '[', false],
        ['[[:]]', ']', false],
        ['[[:a]b:]]', 'ab:]]', true],
        ['[[:a]b:]]', '[b:]]', true],
        ['[[:a]b:]]', ':b:]]', true],
        ['[[:a]b:]]', 'xb:]]', false],
        ['[[:a]b:]]', 'b', false],
        ['[[:]:]]', '[:]]', true],
        ['[[:]:]]', '::]]', true],
        ['[[:]:]]', 'x:]]', false],
      ])('Then %j against %j gives %s', (pattern, text, expected) => {
        // Arrange
        const sut = wildmatch;

        // Act
        const result = sut(pattern, text, PATHNAME);

        // Assert
        expect(result).toBe(expected);
      });
    });
    describe('When matching a named class', () => {
      it.each([
        ['[[:space:]]', ' ', true],
        ['[[:space:]]', '\t', true],
        ['[[:space:]]', '\v', false],
        ['[[:space:]]', '\f', false],
        ['[[:punct:]]', '_', true],
        ['[[:punct:]]', '~', true],
        ['[[:cntrl:]]', '\x01', true],
        ['[[:cntrl:]]', '\x7f', true],
        ['[[:cntrl:]]', 'a', false],
        ['[[:digit:]-z]', '5', true],
        ['[[:digit:]-z]', '-', true],
        ['[[:digit:]-z]', 'z', true],
        ['[[:digit:]-z]', 'a', false],
        ['[a-[:digit:]]', 'a]', true],
        ['[a-[:digit:]]', 'd]', true],
        ['[a-[:digit:]]', '5', false],
        ['[a-[:digit:]]', '5]', false],
      ])('Then %j against %j gives %s', (pattern, text, expected) => {
        // Arrange
        const sut = wildmatch;

        // Act
        const result = sut(pattern, text, PATHNAME);

        // Assert
        expect(result).toBe(expected);
      });
    });
    describe('When matching a set against a slash', () => {
      it.each([
        ['a[/]b', 'a/b', false],
        ['x/a[!b]c', 'x/a/c', false],
      ])('Then %j against %j gives %s', (pattern, text, expected) => {
        // Arrange
        const sut = wildmatch;

        // Act
        const result = sut(pattern, text, PATHNAME);

        // Assert
        expect(result).toBe(expected);
      });
    });
    describe('When matching a byte above ASCII', () => {
      it.each([
        ['[é]', 'é', false],
        ['[!a][!a]', 'é', true],
        ['??', 'é', true],
        ['?', 'é', false],
      ])('Then %j against %j gives %s', (pattern, text, expected) => {
        // Arrange
        const sut = wildmatch;

        // Act
        const result = sut(pattern, text, PATHNAME);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given caseFold', () => {
    describe('When a plain pattern letter differs in case', () => {
      it.each([
        ['A', 'a', true],
        ['a*B', 'axb', true],
      ])('Then %j against %j gives %s', (pattern, text, expected) => {
        // Arrange
        const sut = wildmatch;

        // Act
        const result = sut(pattern, text, FOLD);

        // Assert
        expect(result).toBe(expected);
      });
    });

    describe('When a range or a class meets a lowered letter', () => {
      it.each([
        ['[A-Z]', 'a', true],
        ['[X-c]', 'Y', true],
        ['[X-c]', 'y', true],
        ['[X-c]', 'd', false],
        ['[X-c]', '{', false],
        ['[X-c]', '~', false],
        ['[A-A]', 'a', true],
        ['[[:upper:]]', 'a', true],
        ['[[:digit:]]', 'a', false],
        ['[[:digit:]]', '5', true],
      ])('Then %j against %j gives %s', (pattern, text, expected) => {
        // Arrange
        const sut = wildmatch;

        // Act
        const result = sut(pattern, text, FOLD);

        // Assert
        expect(result).toBe(expected);
      });
    });

    describe('When the pattern holds an escape or a set member', () => {
      it.each([
        ['\\a', 'A', true],
        ['\\A', 'A', false],
        ['\\A', 'a', false],
        ['[A]', 'a', false],
        ['[A]', 'A', false],
        ['[a]', 'A', true],
        ['[a-z]', 'A', true],
        ['[!A]', 'A', true],
        ['[!b]', 'B', false],
        ['[[:lower:]]', 'A', true],
        ['x[A]', 'xA', false],
        ['*.PY[CO]', 'm.PYC', false],
        ['*.PY[CO]', 'm.pyc', false],
      ])('Then %j against %j gives %s', (pattern, text, expected) => {
        // Arrange
        const sut = wildmatch;

        // Act
        const result = sut(pattern, text, FOLD);

        // Assert
        expect(result).toBe(expected);
      });
    });

    describe('When the fold is off', () => {
      it.each([
        ['[A]', 'A', true],
        ['[A-Z]', 'a', false],
      ])('Then %j against %j gives %s', (pattern, text, expected) => {
        // Arrange
        const sut = wildmatch;

        // Act
        const result = sut(pattern, text, FLAGS_0);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given the flags-0 dialect and a slash', () => {
    describe('When matching a slash', () => {
      it.each([
        ['[/]', '/', true],
        ['?', '/', true],
        ['[!a]', '/', true],
      ])('Then %j against %j gives %s', (pattern, text, expected) => {
        // Arrange
        const sut = wildmatch;

        // Act
        const result = sut(pattern, text, FLAGS_0);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a pattern with an unterminated or unknown bracket expression', () => {
    describe('When tokenizing', () => {
      it.each([
        '[a\\]',
        '[]',
        '[!]',
        '*[',
        '[[::]]',
        '[[:DIGIT:]]',
        '[[:foo:]]',
        '[[:digit:]',
        '[[:',
        '[[:a',
      ])('Then %j yields no tokens', (pattern) => {
        // Arrange
        const sut = tokenizeWildmatch;

        // Act
        const result = sut(encode(pattern), PATHNAME);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe.each([
    ['flags-0', FLAGS_0],
    ['WM_PATHNAME', PATHNAME],
  ])('Given the %s dialect and a class name inherited from Object.prototype', (_label, flags) => {
    describe('When tokenizing', () => {
      it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'])(
        'Then [[:%s:]] yields no tokens',
        (name) => {
          // Arrange
          const sut = tokenizeWildmatch;

          // Act
          const result = sut(encode(`[[:${name}:]]`), flags);

          // Assert
          expect(result).toBeUndefined();
        },
      );
    });
  });

  describe('Given a pattern git would abort on', () => {
    describe('When tokenizing', () => {
      it.each(['a\\', '[a', '[[:foo:]]', '[[:digit:]'])('Then %j yields no tokens', (pattern) => {
        // Arrange
        const sut = tokenizeWildmatch;

        // Act
        const result = sut(encode(pattern), FLAGS_0);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a pattern repeating bracket sets', () => {
    describe('When tokenizing sets with the same members', () => {
      it.each(['[ab]'.repeat(50), '[ab][ba]', '[a-c][abc]'])(
        'Then %j holds one shared set token',
        (pattern) => {
          // Arrange
          const sut = tokenizeWildmatch;

          // Act
          const result = sut(encode(pattern), PATHNAME);

          // Assert
          expect(new Set(result).size).toBe(1);
          expect(result?.[0]?.kind).toBe('set');
        },
      );
    });

    describe('When tokenizing sets with different members', () => {
      it('Then each keeps its own verdict', () => {
        // Arrange
        const sut = wildmatch;

        // Act
        const result = [sut('[ab][ac]', 'bc', PATHNAME), sut('[ab][ac]', 'cb', PATHNAME)];

        // Assert
        expect(result).toEqual([true, false]);
      });
    });

    describe('When two patterns are tokenized', () => {
      it('Then they share no set token', () => {
        // Arrange
        const sut = tokenizeWildmatch;

        // Act
        const first = sut(encode('[ab]'), PATHNAME);
        const second = sut(encode('[ab]'), PATHNAME);

        // Assert
        expect(first?.[0]).not.toBe(second?.[0]);
      });
    });
  });

  describe('Given a set holding one byte', () => {
    describe('When tokenizing', () => {
      it.each([
        ['[a]', PATHNAME, 0x61],
        ['[\\]]', PATHNAME, 0x5d],
        ['[]]', PATHNAME, 0x5d],
        ['[A]', FOLD, 0x41],
        ['[/]', FLAGS_0, 0x2f],
      ] as const)('Then %j is the byte token of its member', (pattern, flags, value) => {
        // Arrange
        const sut = tokenizeWildmatch;

        // Act
        const result = sut(encode(pattern), flags);

        // Assert
        expect(result).toEqual([{ kind: 'byte', value }]);
      });
    });

    describe('When the set is negated, repeats its byte or names a slash under WM_PATHNAME', () => {
      it.each(['[!a]', '[aa]', '[/]', '[a-a]', '[[:digit:]]'])(
        'Then %j stays a set token',
        (pattern) => {
          // Arrange
          const sut = tokenizeWildmatch;

          // Act
          const result = sut(encode(pattern), PATHNAME);

          // Assert
          expect(result?.map((token) => token.kind)).toEqual(['set']);
        },
      );
    });
  });
});
