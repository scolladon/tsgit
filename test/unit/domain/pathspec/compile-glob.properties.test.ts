import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { encode } from '../../../../src/domain/objects/encoding.js';
import { compileGlob } from '../../../../src/domain/pathspec/compile-glob.js';
import { arbCaseMask, flipAsciiCase } from '../path/arbitraries.js';
import {
  arbBracketMembers,
  arbEscapedPath,
  arbFoldGlobBody,
  arbFoldPath,
  arbLiteralPattern,
  arbUnbracketedBody,
} from './arbitraries.js';
import { referenceWildmatch } from './dowild-reference.js';

const NUM_RUNS = 100;
const NEGATIVE_NUM_RUNS = 50;
const CHEAP_NUM_RUNS = 200;
const SLASH = 0x2f;
const PRINTABLE_NO_SLASH = fc
  .integer({ min: 0x20, max: 0x7e })
  .filter((c) => c !== SLASH)
  .map((c) => String.fromCharCode(c));
const arbClassGrammarPattern = fc.stringMatching(/^[\][!^:\\*?/aAbB-]{0,16}$/);
// Bytes a generated set often admits, so the oracle sees matches as well as refusals.
const SET_NEIGHBOUR = fc.constantFrom('a', 'b', 'c', 'd', 'A', 'B', '0', '5', '9', '-');

// git matches a pattern without `/` against the basename alone and any other
// pattern against the whole path under WM_PATHNAME; the oracle mirrors that.
const referenceVerdict = (pattern: string, path: string, caseFold: boolean): boolean => {
  const anchored = pattern.includes('/');
  const text = encode(path);
  const subject = anchored ? text : text.subarray(text.lastIndexOf(SLASH) + 1);
  return referenceWildmatch(encode(pattern), subject, { pathname: anchored, caseFold });
};
const PRINTABLE_ASCII_NO_NUL = fc.string({
  unit: fc.integer({ min: 0x20, max: 0x7e }).map((c) => String.fromCharCode(c)),
  maxLength: 16,
});

describe('compileGlob properties', () => {
  describe('Given an arbitrary printable-ASCII pattern and options', () => {
    describe('When the compiled matcher tests an arbitrary path', () => {
      it('Then it returns a boolean', () => {
        fc.assert(
          fc.property(
            PRINTABLE_ASCII_NO_NUL,
            fc.boolean(),
            PRINTABLE_ASCII_NO_NUL,
            (pattern, anchored, path) => {
              // Arrange
              const sut = compileGlob;

              // Act
              const result = sut(pattern, { anchored }).test(path);

              // Assert
              expect(typeof result).toBe('boolean');
            },
          ),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });

  describe('Given a pattern made only of literal segments', () => {
    describe('When compiled anchored and tested against itself', () => {
      it('Then it matches exactly itself and rejects itself plus a suffix', () => {
        fc.assert(
          fc.property(fc.array(arbLiteralPattern(), { minLength: 1, maxLength: 4 }), (segments) => {
            // Arrange
            const pattern = segments.join('/');
            const sut = compileGlob;

            // Act
            const matcher = sut(pattern, { anchored: true });

            // Assert
            expect(matcher.test(pattern)).toBe(true);
            expect(matcher.test(`${pattern}x`)).toBe(false);
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
  describe('Given caseFold over a small alphabet', () => {
    const arbText = fc.stringMatching(/^[aAbB/*?]{0,8}$/);
    const arbPath = fc.stringMatching(/^[aAbB/]{0,8}$/);
    const arbMask = arbCaseMask();

    describe('When the path has its ASCII case flipped', () => {
      it('Then the verdict is unchanged', () => {
        fc.assert(
          fc.property(arbText, arbPath, arbMask, fc.boolean(), (pattern, path, mask, anchored) => {
            // Arrange
            const sut = compileGlob(pattern, { anchored, caseFold: true });

            // Act
            const result = sut.test(flipAsciiCase(path, mask));

            // Assert
            expect(result).toBe(sut.test(path));
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });

    describe('When the exact matcher accepts a path', () => {
      it('Then the folding matcher accepts it too', () => {
        fc.assert(
          fc.property(arbText, arbPath, fc.boolean(), (pattern, path, anchored) => {
            // Arrange
            const options = { anchored };
            const exact = compileGlob(pattern, options);
            const sut = compileGlob(pattern, { ...options, caseFold: true });

            // Act
            const result = sut.test(path);

            // Assert
            expect(result || !exact.test(path)).toBe(true);
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });

  describe('Given the reference dowild port', () => {
    describe('When run on pinned rows', () => {
      it.each([
        { pattern: '[]a]', text: ']', caseFold: false, expected: true },
        { pattern: '[]-a]', text: '^', caseFold: false, expected: true },
        { pattern: '[]-a]', text: '-', caseFold: false, expected: false },
        { pattern: '[c-a]', text: 'a', caseFold: false, expected: false },
        { pattern: '[a-c-e]', text: '-', caseFold: false, expected: true },
        { pattern: '[a\\]', text: '[a\\]', caseFold: false, expected: false },
        { pattern: '[[:alpha]', text: 'p', caseFold: false, expected: true },
        { pattern: '[[:]]', text: '[]', caseFold: false, expected: true },
        { pattern: 'a\\', text: 'a\\', caseFold: false, expected: false },
        { pattern: '**\\/b', text: 'b', caseFold: false, expected: false },
        { pattern: '**\\/b', text: 'x/b', caseFold: false, expected: true },
        { pattern: '\\A', text: 'A', caseFold: true, expected: false },
        { pattern: '[A]', text: 'A', caseFold: true, expected: false },
        { pattern: '[A-A]', text: 'a', caseFold: true, expected: true },
      ])(
        'Then $pattern against $text (fold $caseFold) is $expected',
        ({ pattern, text, caseFold, expected }) => {
          // Arrange
          const sut = referenceWildmatch;

          // Act
          const result = sut(encode(pattern), encode(text), { pathname: true, caseFold });

          // Assert
          expect(result).toBe(expected);
        },
      );
    });
  });

  describe('Given an arbitrary pattern over the class-grammar alphabet', () => {
    describe('When it is compiled with either caseFold flag and tests a path', () => {
      it('Then it returns a boolean', () => {
        fc.assert(
          fc.property(
            arbClassGrammarPattern,
            fc.boolean(),
            fc.boolean(),
            PRINTABLE_ASCII_NO_NUL,
            (pattern, anchored, caseFold, path) => {
              // Arrange
              const sut = compileGlob(pattern, { anchored, caseFold });

              // Act
              const result = sut.test(path);

              // Assert
              expect(typeof result).toBe('boolean');
            },
          ),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });

  describe('Given a literal path with every character escaped', () => {
    describe('When compiled anchored without caseFold', () => {
      it('Then it matches the path and rejects the path plus a suffix', () => {
        fc.assert(
          fc.property(
            arbFoldPath().filter((path) => path.length > 0),
            (path) => {
              // Arrange
              const pattern = [...path].map((c) => `\\${c}`).join('');
              const sut = compileGlob(pattern, { anchored: true, caseFold: false });

              // Act
              const result = [sut.test(path), sut.test(`${path}x`)];

              // Assert
              expect(result).toEqual([true, false]);
            },
          ),
          { numRuns: CHEAP_NUM_RUNS },
        );
      });
    });
  });

  describe('Given a well-formed set and its negation around a middle byte', () => {
    describe.each([false, true])('And caseFold is %s', (caseFold) => {
      describe('When both test a path whose middle byte is not a slash', () => {
        it('Then exactly one of them accepts it', () => {
          fc.assert(
            fc.property(arbBracketMembers(), PRINTABLE_NO_SLASH, (members, middle) => {
              // Arrange
              const sut = compileGlob(`x[${members}]y`, { anchored: true, caseFold });
              const negated = compileGlob(`x[!${members}]y`, { anchored: true, caseFold });
              const path = `x${middle}y`;

              // Act
              const result = sut.test(path) !== negated.test(path);

              // Assert
              expect(result).toBe(true);
            }),
            { numRuns: NUM_RUNS },
          );
        });
      });
    });
  });

  describe('Given a well-formed set around a middle byte near its members', () => {
    describe.each([false, true])('And caseFold is %s', (caseFold) => {
      describe('When the compiled matcher tests the path', () => {
        it('Then it agrees with the recursive reference', () => {
          fc.assert(
            fc.property(
              arbBracketMembers(),
              fc.boolean(),
              SET_NEIGHBOUR,
              (members, negated, middle) => {
                // Arrange
                const pattern = `x[${negated ? '!' : ''}${members}]y`;
                const sut = compileGlob(pattern, { anchored: false, caseFold });
                const path = `x${middle}y`;

                // Act
                const result = sut.test(path);

                // Assert
                expect(result).toBe(referenceVerdict(pattern, path, caseFold));
              },
            ),
            { numRuns: NUM_RUNS },
          );
        });
      });
    });
  });

  describe('Given a pattern ending in an unterminated bracket', () => {
    describe('When any path is tested', () => {
      it('Then nothing matches', () => {
        fc.assert(
          fc.property(
            arbUnbracketedBody(),
            arbEscapedPath(),
            fc.boolean(),
            fc.boolean(),
            (body, path, anchored, caseFold) => {
              // Arrange
              const sut = compileGlob(`${body}[`, { anchored, caseFold });

              // Act
              const result = sut.test(path);

              // Assert
              expect(result).toBe(false);
            },
          ),
          { numRuns: NEGATIVE_NUM_RUNS },
        );
      });
    });
  });

  describe('Given an arbitrary class-grammar pattern and path', () => {
    describe.each([false, true])('And caseFold is %s', (caseFold) => {
      describe('When the compiled matcher tests the path', () => {
        it('Then it agrees with the recursive reference', () => {
          fc.assert(
            fc.property(arbFoldGlobBody(), arbFoldPath(), (pattern, path) => {
              // Arrange
              const sut = compileGlob(pattern, { anchored: pattern.includes('/'), caseFold });

              // Act
              const result = sut.test(path);

              // Assert
              expect(result).toBe(referenceVerdict(pattern, path, caseFold));
            }),
            { numRuns: NUM_RUNS },
          );
        });
      });

      describe('When one matcher tests two alternating paths', () => {
        it('Then each verdict still agrees with the reference', () => {
          fc.assert(
            fc.property(
              arbFoldGlobBody(),
              arbFoldPath(),
              arbFoldPath(),
              (pattern, first, second) => {
                // Arrange
                const sut = compileGlob(pattern, { anchored: pattern.includes('/'), caseFold });

                // Act
                const result = [first, second, first].map((path) => sut.test(path));

                // Assert
                expect(result).toEqual(
                  [first, second, first].map((path) => referenceVerdict(pattern, path, caseFold)),
                );
              },
            ),
            { numRuns: NUM_RUNS },
          );
        });
      });
    });
  });
});
