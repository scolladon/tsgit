import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compilePathnameGlob, matchRefGlob } from '../../../../src/domain/refs/ref-glob.js';
import { arbGlobLiteral, arbGlobText, arbPlainGlobChar } from './arbitraries.js';

describe('Given any ASCII pattern and ref', () => {
  describe('When matching with matchRefGlob', () => {
    it('Then it never throws', () => {
      // Arrange
      const sut = matchRefGlob;

      // Act + Assert
      fc.assert(
        fc.property(arbGlobText(), arbGlobText(), (pattern, ref) => {
          expect(() => sut(pattern, ref)).not.toThrow();
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given an all-`*` pattern', () => {
  describe('When matching any ref', () => {
    it('Then it matches everything', () => {
      // Arrange
      const sut = matchRefGlob;

      // Act + Assert
      fc.assert(
        fc.property(arbGlobText(), (ref) => {
          expect(sut('*', ref)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given a metacharacter-free literal pattern', () => {
  describe('When matching a ref', () => {
    it('Then it matches iff the ref is identical', () => {
      // Arrange
      const sut = matchRefGlob;

      // Act + Assert
      fc.assert(
        fc.property(arbGlobLiteral(), arbGlobLiteral(), (pattern, ref) => {
          expect(sut(pattern, ref)).toBe(pattern === ref);
        }),
        { numRuns: 50 },
      );
    });
  });
});

describe('Given every character of a string individually escaped', () => {
  describe('When matching the original string', () => {
    it('Then the fully-escaped pattern matches exactly that string', () => {
      // Arrange
      const sut = matchRefGlob;
      const escapeAll = (raw: string): string => [...raw].map((ch) => `\\${ch}`).join('');

      // Act + Assert
      fc.assert(
        fc.property(arbGlobText(), (text) => {
          expect(sut(escapeAll(text), text)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given a single-member bracket set `[c]` over a non-special character', () => {
  describe('When matching', () => {
    it('Then it behaves exactly like the literal `c`', () => {
      // Arrange
      const sut = matchRefGlob;

      // Act + Assert
      fc.assert(
        fc.property(arbPlainGlobChar(), arbPlainGlobChar(), (c, text) => {
          expect(sut(`[${c}]`, text)).toBe(sut(c, text));
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given a bracket set of non-special characters, plain or negated', () => {
  describe('When matching a single character', () => {
    it('Then the set admits exactly its members, and its negation exactly the rest', () => {
      // Arrange
      const sut = matchRefGlob;

      // Act + Assert
      fc.assert(
        fc.property(
          fc.array(arbPlainGlobChar(), { minLength: 1, maxLength: 6 }),
          arbPlainGlobChar(),
          (members, text) => {
            const set = members.join('');
            expect(sut(`[${set}]`, text)).toBe(members.includes(text));
            expect(sut(`[!${set}]`, text)).toBe(!members.includes(text));
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given a pattern `<head>*<tail>` between two literals', () => {
  describe('When matching a ref', () => {
    it('Then it matches iff the ref starts with head and ends with tail without the two overlapping', () => {
      // Arrange
      const sut = matchRefGlob;
      const arbCase = fc.tuple(arbGlobLiteral(), arbGlobLiteral()).chain(([head, tail]) =>
        fc.record({
          head: fc.constant(head),
          tail: fc.constant(tail),
          ref: fc.oneof(
            arbGlobText(),
            arbGlobText().map((middle) => `${head}${middle}${tail}`),
          ),
        }),
      );

      // Act + Assert
      fc.assert(
        fc.property(arbCase, ({ head, tail, ref }) => {
          const expected =
            ref.length >= head.length + tail.length && ref.startsWith(head) && ref.endsWith(tail);
          expect(sut(`${head}*${tail}`, ref)).toBe(expected);
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given a pattern that opens with a non-empty literal prefix', () => {
  describe('When matching a ref that does not start with that prefix', () => {
    it('Then it never matches, whatever follows the prefix', () => {
      // Arrange
      const sut = matchRefGlob;
      // A ref that carries the whole pattern after some leading bytes is the
      // near miss an unanchored matcher would accept.
      const arbCase = fc
        .record({ prefix: arbGlobLiteral(1), rest: arbGlobText() })
        .chain(({ prefix, rest }) =>
          fc.record({
            prefix: fc.constant(prefix),
            rest: fc.constant(rest),
            ref: fc.oneof(
              arbGlobText(),
              arbGlobText().map((lead) => `${lead}${prefix}${rest}`),
            ),
          }),
        )
        .filter(({ prefix, ref }) => !ref.startsWith(prefix));

      // Act + Assert
      fc.assert(
        fc.property(arbCase, ({ prefix, rest, ref }) => {
          expect(sut(`${prefix}${rest}`, ref)).toBe(false);
        }),
        { numRuns: 50 },
      );
    });
  });
});

describe('Given a metacharacter-free literal pathname pattern', () => {
  describe('When matched under WM_PATHNAME', () => {
    it('Then it matches exactly itself', () => {
      // Arrange
      const sut = compilePathnameGlob;
      const arbCase = fc.record({ pattern: arbGlobLiteral(), text: arbGlobLiteral() });

      // Act + Assert
      fc.assert(
        fc.property(arbCase, ({ pattern, text }) => {
          expect(sut(pattern)(text)).toBe(text === pattern);
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given a lone `*` pathname pattern', () => {
  describe('When matched under WM_PATHNAME', () => {
    it('Then it matches exactly the texts holding no slash', () => {
      // Arrange
      const sut = compilePathnameGlob;

      // Act + Assert
      fc.assert(
        fc.property(arbGlobText(), (text) => {
          expect(sut('*')(text)).toBe(!text.includes('/'));
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given a lone `**` pathname pattern', () => {
  describe('When matched under WM_PATHNAME', () => {
    it('Then it matches every text', () => {
      // Arrange
      const sut = compilePathnameGlob;

      // Act + Assert
      fc.assert(
        fc.property(arbGlobText(), (text) => {
          expect(sut('**')(text)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given a `<dir>/**/<leaf>` pathname pattern', () => {
  describe('When matched against the leaf under any number of literal directories', () => {
    it('Then it matches', () => {
      // Arrange
      const sut = compilePathnameGlob;
      const segment = fc.stringMatching(/^[a-z0-9]{1,5}$/);
      const arbCase = fc.record({
        dir: segment,
        leaf: segment,
        middle: fc.array(segment, { maxLength: 3 }),
      });

      // Act + Assert
      fc.assert(
        fc.property(arbCase, ({ dir, leaf, middle }) => {
          expect(sut(`${dir}/**/${leaf}`)([dir, ...middle, leaf].join('/'))).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });
});
