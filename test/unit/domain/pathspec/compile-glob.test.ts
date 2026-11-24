import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type CompileGlobOptions,
  compileGlob,
} from '../../../../src/domain/pathspec/compile-glob.js';

/**
 * Oracle — the original regex-based compiler, kept verbatim as a test-only
 * reference. The linear matcher must agree with it for every path free of JS
 * line terminators (the domain on which the two are required to match — see
 * docs/design/compile-glob-redos.md §6).
 */
const ORACLE_SPECIALS = /[.+^${}()|[\]\\]/;
/**
 * git's WM_PATHNAME star: a run of two or more stars spans `/` only when it is
 * a whole path component — preceded by the pattern start or `/` and followed
 * by the end or `/`. Any other run is a single `*`.
 */
const oraclePathnameStar = (pattern: string, i: number): { regex: string; next: number } => {
  let end = i;
  while (pattern[end] === '*') end += 1;
  const leftBounded = i === 0 || pattern[i - 1] === '/';
  const rightBounded = end === pattern.length || pattern[end] === '/';
  if (end - i === 1 || !leftBounded || !rightBounded) return { regex: '[^/]*', next: end };
  if (pattern[end] === '/') return { regex: '(.*/)?', next: end + 1 };
  return { regex: '.*', next: end };
};
const oracleToken = (pattern: string, i: number): { regex: string; next: number } => {
  const ch = pattern[i] as string;
  if (ch === '*') return oraclePathnameStar(pattern, i);
  if (ch === '?') return { regex: '[^/]', next: i + 1 };
  return { regex: ORACLE_SPECIALS.test(ch) ? `\\${ch}` : ch, next: i + 1 };
};
const oracleRegex = (pattern: string, options: CompileGlobOptions): RegExp => {
  let body = '';
  let i = 0;
  while (i < pattern.length) {
    const consumed = oracleToken(pattern, i);
    body += consumed.regex;
    i = consumed.next;
  }
  const prefix = options.anchored ? '^' : '(^|.*/)';
  return new RegExp(`${prefix}${body}$`);
};

describe('compileGlob', () => {
  describe('Given a literal "src" with anchored=true', () => {
    describe('When compiled', () => {
      it('Then matches only the exact path', () => {
        // Arrange
        const result = compileGlob('src', { anchored: true });

        // Assert
        expect(result.test('src')).toBe(true);
        expect(result.test('src/foo')).toBe(false);
        expect(result.test('other')).toBe(false);
      });
    });
  });

  describe('Given anchored=true', () => {
    describe('When matched against a path that merely ends with the pattern', () => {
      it('Then it does NOT match (the `^` anchor is present)', () => {
        // Arrange — without the leading `^` the regex would be `src$`, which matches
        // any string ending in `src`. The anchor must reject a prefixed path.
        const result = compileGlob('src', { anchored: true });

        // Act / Assert
        expect(result.test('vendorsrc')).toBe(false);
        expect(result.test('a/src')).toBe(false);
        expect(result.test('src')).toBe(true);
      });
    });
  });

  describe('Given a single-star glob "*.ts" non-anchored', () => {
    describe('When compiled', () => {
      it('Then matches files at any depth', () => {
        // Arrange
        const result = compileGlob('*.ts', { anchored: false });

        // Assert
        expect(result.test('foo.ts')).toBe(true);
        expect(result.test('src/foo.ts')).toBe(true);
        expect(result.test('foo.tsx')).toBe(false);
        expect(result.test('foo')).toBe(false);
      });
    });
  });

  describe('Given a single-star glob', () => {
    describe('When matched against a path with a slash inside the segment', () => {
      it('Then it does NOT match (single `*` excludes `/`)', () => {
        // Arrange
        const result = compileGlob('a*c', { anchored: true });

        // Assert
        expect(result.test('abc')).toBe(true);
        expect(result.test('a/c')).toBe(false);
      });
    });
  });

  describe('Given a double-star glob "**"', () => {
    describe('When matched', () => {
      it('Then it spans path segments', () => {
        // Arrange
        const result = compileGlob('a/**/c', { anchored: true });

        // Assert
        expect(result.test('a/c')).toBe(true);
        expect(result.test('a/b/c')).toBe(true);
        expect(result.test('a/b/d/c')).toBe(true);
        expect(result.test('a/d')).toBe(false);
      });
    });
  });

  describe('Given a `?` glob', () => {
    describe('When matched', () => {
      it('Then it matches exactly one non-`/` byte (not zero, not many)', () => {
        // Arrange
        const result = compileGlob('a?c', { anchored: true });

        // Assert
        expect(result.test('abc')).toBe(true);
        expect(result.test('ac')).toBe(false);
        expect(result.test('abbc')).toBe(false);
        expect(result.test('a/c')).toBe(false);
      });
    });
  });

  describe('Given a mid-pattern `**/`', () => {
    describe('When matched', () => {
      it('Then it spans zero-or-more segments AND does NOT match within a segment (kills the `.*` regex bug)', () => {
        // Arrange
        const result = compileGlob('a/**/c', { anchored: true });

        // Assert
        expect(result.test('a/c')).toBe(true);
        expect(result.test('a/b/c')).toBe(true);
        expect(result.test('a/b/d/c')).toBe(true);
        // The bug case: `a/xc` is `a` followed by a single segment `xc`.
        // The original `.*` regex compiled `^a/.*c$`, which matched this
        // path. The corrected `(.*/)?` regex requires at least one trailing
        // `/` between `a/` and `c`, so this must NOT match.
        expect(result.test('a/xc')).toBe(false);
      });
    });
  });

  describe('Given a pattern with regex specials', () => {
    describe('When compiled', () => {
      it('Then they are escaped (literal match)', () => {
        // Arrange
        const result = compileGlob('foo.bar', { anchored: true });

        // Assert
        expect(result.test('foo.bar')).toBe(true);
        expect(result.test('fooXbar')).toBe(false);
      });
    });
  });

  describe('Given a [abc] pattern', () => {
    describe('When compiled', () => {
      it('Then it is a bracket set', () => {
        // Arrange
        const sut = compileGlob('[abc]', { anchored: true });

        // Act
        const matchesMember = sut.test('a');
        const matchesSpelling = sut.test('[abc]');

        // Assert
        expect(matchesMember).toBe(true);
        expect(matchesSpelling).toBe(false);
      });
    });
  });

  describe('Given anchored=false', () => {
    describe('When compiled', () => {
      it('Then the pattern matches at any depth via the (^|.*/) prefix', () => {
        // Arrange
        const result = compileGlob('foo', { anchored: false });

        // Assert
        expect(result.test('foo')).toBe(true);
        expect(result.test('a/foo')).toBe(true);
        expect(result.test('a/b/foo')).toBe(true);
      });
    });
  });

  describe('Given an unanchored literal "bar"', () => {
    describe('When matched against "foobar"', () => {
      it('Then it does NOT match (the (^|.*/) prefix forbids a mid-segment match)', () => {
        // Arrange — unanchored compiles with the `(^|.*/)` boundary prefix so the
        // pattern matches a whole leading segment, never a substring inside one.
        // A mutant replacing that prefix with `''` yields `bar$`, which matches
        // `foobar`; this assertion fails under that mutant.
        const result = compileGlob('bar', { anchored: false });

        // Act / Assert
        expect(result.test('foobar')).toBe(false);
        // Balance: the legitimate segment matches must still hold.
        expect(result.test('bar')).toBe(true);
        expect(result.test('x/bar')).toBe(true);
      });
    });
  });

  describe('Given a non-anchored GLOB "*.ts"', () => {
    describe('When matched at depth', () => {
      it('Then matches at any segment AND rejects non-matching extensions', () => {
        // Arrange
        const result = compileGlob('*.ts', { anchored: false });

        // Assert
        expect(result.test('a.ts')).toBe(true);
        expect(result.test('src/a.ts')).toBe(true);
        expect(result.test('src/a/b.ts')).toBe(true);
        expect(result.test('src/a.js')).toBe(false);
      });
    });
  });

  describe('Given an empty pattern with anchored=true', () => {
    describe('When matched', () => {
      it('Then only the empty string matches', () => {
        // Arrange — a zero-token pattern: the base layer must accept exactly j===0.
        const result = compileGlob('', { anchored: true });

        // Act / Assert
        expect(result.test('')).toBe(true);
        expect(result.test('a')).toBe(false);
      });
    });
  });

  describe('Given a single `*`', () => {
    describe('When matched', () => {
      it('Then it matches a zero-length run (not only non-empty runs)', () => {
        // Arrange — `a*` must match bare `a`; a mutant forcing `*` to consume at
        // least one char would reject it.
        const result = compileGlob('a*', { anchored: true });

        // Act / Assert
        expect(result.test('a')).toBe(true);
        expect(result.test('abc')).toBe(true);
      });
    });
  });

  describe('Given a trailing `**` followed by a literal', () => {
    describe('When the literal is absent', () => {
      it('Then it does NOT match', () => {
        // Arrange — `a**b` must reject `a`: star-star matches the empty run, but
        // the trailing `b` then has nothing to match.
        const result = compileGlob('a**b', { anchored: true });

        // Act / Assert
        expect(result.test('a')).toBe(false);
        expect(result.test('ab')).toBe(true);
      });
    });
  });

  describe('Given the gitignore dialect', () => {
    const pathname: CompileGlobOptions = { anchored: true };

    describe('When a `**` is not a whole path component', () => {
      it.each([
        ['d/a**b', 'd/a/c/b', false],
        ['d/a**b', 'd/a/b', false],
        ['d/a**b', 'd/axb', true],
        ['d/**b', 'd/x/yb', false],
        ['d/**b', 'd/yb', true],
        ['d/a**/b', 'd/ax/y/b', false],
        ['d/a**/b', 'd/ax/b', true],
        ['**b', 'yb', true],
        ['**b', 'x/yb', false],
      ])('Then %s matches %s like a single `*` (%s)', (pattern, path, expected) => {
        // Arrange
        const sut = compileGlob(pattern, pathname);

        // Act
        const result = sut.test(path);

        // Assert
        expect(result).toBe(expected);
      });
    });

    describe('When a star run is a whole path component', () => {
      it.each([
        ['**/x', 'x', true],
        ['**/x', 'p/q/x', true],
        ['x/**', 'x/a/b', true],
        ['x/**', 'x', false],
        ['a/**/b', 'a/b', true],
        ['a/**/b', 'a/x/y/b', true],
        ['**', 'a/b/c', true],
        ['d/***/b', 'd/b', true],
        ['d/***/b', 'd/x/y/b', true],
        ['d/***', 'd/x/y', true],
      ])('Then %s spans directories in %s (%s)', (pattern, path, expected) => {
        // Arrange
        const sut = compileGlob(pattern, pathname);

        // Act
        const result = sut.test(path);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given caseFold', () => {
    describe('When the pattern and the path differ only by ASCII case', () => {
      it.each([
        ['B/f', true, 'b/F'],
        ['*.TXT', false, 'dir/a.txt'],
        ['?/F', true, 'b/f'],
        ['src', true, 'SRC'],
      ] as const)('Then %s (anchored %s) matches %s', (pattern, anchored, path) => {
        // Arrange
        const sut = compileGlob(pattern, { anchored, caseFold: true });

        // Act
        const result = sut.test(path);

        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When the pattern and the path differ by a non-ASCII letter case', () => {
      it('Then they stay distinct', () => {
        // Arrange
        const sut = compileGlob('É', { anchored: true, caseFold: true });

        // Act
        const result = sut.test('é');

        // Assert
        expect(result).toBe(false);
      });
    });

    describe('When two folded matchers alternate between two paths', () => {
      it('Then each verdict belongs to the path just tested', () => {
        // Arrange
        const sut = compileGlob('*.log', { anchored: false, caseFold: true });
        const other = compileGlob('*.txt', { anchored: false, caseFold: true });

        // Act
        const result = [
          sut.test('A.LOG'),
          other.test('A.LOG'),
          sut.test('B.TXT'),
          other.test('B.TXT'),
          sut.test('A.LOG'),
        ];

        // Assert
        expect(result).toEqual([true, false, false, true, true]);
      });
    });

    describe('When escapes and sets meet a path of another case', () => {
      it.each([
        ['\\a', 'A', true],
        ['[A-Z]', 'a', true],
        ['[[:upper:]]', 'a', true],
        ['\\A', 'A', false],
        ['[A]', 'A', false],
        ['[!b]', 'B', false],
      ] as const)('Then %s against %s answers %s', (pattern, path, expected) => {
        // Arrange
        const sut = compileGlob(pattern, { anchored: true, caseFold: true });

        // Act
        const result = sut.test(path);

        // Assert
        expect(result).toBe(expected);
      });

      it('Then a plain pattern still folds both sides', () => {
        // Arrange
        const sut = compileGlob('Dir/f', { anchored: true, caseFold: true });

        // Act
        const result = sut.test('DIR/F');

        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When the option is absent', () => {
      it('Then the comparison stays exact', () => {
        // Arrange
        const sut = compileGlob('B/f', { anchored: true });

        // Act
        const result = sut.test('b/f');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a pattern led by a literal run', () => {
    describe.each([
      ['src', true, 'src', true],
      ['src', true, 'a/src', false],
      ['src', true, 'src-x', false],
      ['src', true, 'sr', false],
      ['src', false, 'a/src', true],
      ['src', false, 'a-src', false],
      ['src', false, 'src/a', false],
      ['zz1/*.c', true, 'zz1/a.c', true],
      ['zz1/*.c', true, 'zz2/a.c', false],
      ['zz1/*.c', true, 'x/zz1/a.c', false],
      ['zz1/*.c', true, 'zz1', false],
      ['zz/*.c', false, 'x/zz/a.c', true],
      ['zz/*.c', false, 'xzz/a.c', false],
      ['zz/*.c', false, 'zz/a.c', true],
      ['', true, '', true],
      ['', true, 'a', false],
      ['', false, 'a/', true],
      ['a\\*', true, 'a\\x', false],
      ['a\\*', true, 'a*', true],
    ] as const)(
      'When "%s" (anchored %s) is tested against "%s"',
      (pattern, anchored, path, expected) => {
        it(`Then it answers ${expected}`, () => {
          // Arrange
          const sut = compileGlob(pattern, { anchored });

          // Act
          const result = sut.test(path);

          // Assert
          expect(result).toBe(expected);
        });
      },
    );

    describe('When caseFold is set', () => {
      it.each([
        ['Src', true, 'sRC'],
        ['Src', false, 'a/SRC'],
        ['ZZ1/*.c', true, 'zz1/A.c'],
      ] as const)('Then "%s" (anchored %s) matches "%s"', (pattern, anchored, path) => {
        // Arrange
        const sut = compileGlob(pattern, { anchored, caseFold: true });

        // Act
        const result = sut.test(path);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a bracket expression', () => {
    describe('When a path is tested', () => {
      it.each([
        ['[ab]', false, 'a', true],
        ['[ab]', false, 'b', true],
        ['[ab]', false, 'd/a', true],
        ['[ab]', false, 'c', false],
        ['[ab]', false, '[ab]', false],
        ['*.py[cod]', false, 'm.pyc', true],
        ['*.py[cod]', false, 'd/m.pyc', true],
        ['*.py[cod]', false, 'm.py[cod]', false],
        ['[ab]c', false, 'x/ac', true],
      ] as const)(
        'Then %s (anchored %s) against %s answers %s',
        (pattern, anchored, path, expected) => {
          // Arrange
          const sut = compileGlob(pattern, { anchored });

          // Act
          const result = sut.test(path);

          // Assert
          expect(result).toBe(expected);
        },
      );
    });
  });

  describe('Given a pattern git aborts on', () => {
    describe('When tested against the path spelled like it', () => {
      it.each([
        '[a',
        '[a\\]',
        '[[:digit:]',
        '[[:foo:]]',
        '[[:constructor:]]',
        '[[:__proto__:]]',
        'a\\',
      ])('Then %s is refused', (pattern) => {
        // Arrange
        const sut = compileGlob(pattern, { anchored: true });

        // Act
        const result = sut.test(pattern);

        // Assert
        expect(result).toBe(false);
      });
    });

    describe('When tested against a path the pattern would otherwise match', () => {
      it.each([
        ['[[:constructor:]]', 'a'],
        ['[[:__proto__:]]', 'a'],
        ['[[:foo:]]', 'a'],
        ['a\\', 'a'],
      ])('Then %s does not throw and matches nothing for %s', (pattern, path) => {
        // Arrange
        const sut = compileGlob(pattern, { anchored: false });

        // Act
        const result = sut.test(path);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given an escape', () => {
    describe('When a path is tested', () => {
      it.each([
        ['\\[a]', true, '[a]', true],
        ['\\[a]', true, 'a', false],
        ['\\*', true, '*', true],
        ['\\*', true, 'x', false],
        ['\\\\', true, '\\', true],
        ['\\\\', true, '\\\\', false],
        ['a\\/b', true, 'a/b', true],
        ['**\\/b', true, 'b', false],
        ['**\\/b', true, 'x/b', true],
        ['**\\/b', true, 'x/y/b', true],
        ['a/**\\/b', true, 'a/b', false],
        ['a/**\\/b', true, 'a/x/b', true],
      ] as const)(
        'Then %s (anchored %s) against %s answers %s',
        (pattern, anchored, path, expected) => {
          // Arrange
          const sut = compileGlob(pattern, { anchored });

          // Act
          const result = sut.test(path);

          // Assert
          expect(result).toBe(expected);
        },
      );
    });
  });

  describe('Given a multi-byte path', () => {
    describe('When a path is tested', () => {
      it.each([
        ['?', 'é', false],
        ['??', 'é', true],
        ['[!a][!a]', 'é', true],
        ['[!a]', '\uDC80', true],
        ['??', '\uDC80', false],
        ['[é]', 'é', false],
      ] as const)('Then %s against %s answers %s', (pattern, path, expected) => {
        // Arrange
        const sut = compileGlob(pattern, { anchored: true });

        // Act
        const result = sut.test(path);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe("Given git's fast paths", () => {
    describe('When the pattern starts with a star but its rest is not plain text', () => {
      it.each([
        ['*a[b]', 'xab', true],
        ['*a[b]', 'xa[b]', false],
        ['*a\\b', 'xab', true],
        ['*a\\b', 'xa\\b', false],
        ['*a?', 'yab', true],
        ['*a?', 'ya', false],
        ['**a', 'd/xa', true],
        ['**a', 'xa', true],
        ['**.log', 'x.log', true],
      ] as const)('Then %s (unanchored) against %s answers %s', (pattern, path, expected) => {
        // Arrange
        const sut = compileGlob(pattern, { anchored: false });

        // Act
        const result = sut.test(path);

        // Assert
        expect(result).toBe(expected);
      });
    });

    describe('When the pattern is a star then plain text', () => {
      it.each([
        ['*.log', false, 'x.log', true],
        ['*.log', false, 'd/x.log', true],
        ['*.log', false, 'x.log/y', false],
        ['*.log', true, 'd/x.log', false],
        ['*.log', true, 'x.log', true],
        ['*', false, 'a/b', true],
        ['*', false, '', true],
        ['*/x', false, 'a/x', true],
      ] as const)(
        'Then %s (anchored %s) against %s answers %s',
        (pattern, anchored, path, expected) => {
          // Arrange
          const sut = compileGlob(pattern, { anchored });

          // Act
          const result = sut.test(path);

          // Assert
          expect(result).toBe(expected);
        },
      );

      it('Then caseFold folds the text it ends with', () => {
        // Arrange
        const sut = compileGlob('*.LOG', { anchored: false, caseFold: true });

        // Act
        const result = sut.test('x.log');

        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When the pattern is led by plain text and then a wildcard', () => {
      it.each([
        ['\\*x', true, '*x', true],
        ['[ab]c', false, 'x/ac', true],
        ['?x', false, 'ax', true],
        ['d/[ab]c', true, 'x/d/ac', false],
        ['d/[ab]c', true, 'd/ac', true],
        ['zz/*.c', false, 'xzz/a.c', false],
        ['zz/*.c', false, 'x/zz/a.c', true],
        ['zz/*.c', true, 'x/zz/a.c', false],
      ] as const)(
        'Then %s (anchored %s) against %s answers %s',
        (pattern, anchored, path, expected) => {
          // Arrange
          const sut = compileGlob(pattern, { anchored });

          // Act
          const result = sut.test(path);

          // Assert
          expect(result).toBe(expected);
        },
      );

      it('Then caseFold folds the prefix it demands', () => {
        // Arrange
        const sut = compileGlob('ZZ/*.c', { anchored: false, caseFold: true });

        // Act
        const result = sut.test('x/zz/a.c');

        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When the pattern is plain text', () => {
      it.each([
        ['A', true, 'a', true],
        ['src', false, 'a/src', true],
        ['src', false, 'a-src', false],
      ] as const)('Then %s against %s answers %s', (pattern, _anchored, path, expected) => {
        // Arrange
        const sut = compileGlob(pattern, { anchored: false, caseFold: pattern === 'A' });

        // Act
        const result = sut.test(path);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('equivalence with the original regex compiler', () => {
    const arbPattern = fc.string({
      unit: fc.constantFrom('a', 'b', '/', '*', '?', '.'),
      maxLength: 12,
    });
    const arbPath = fc.string({ unit: fc.constantFrom('a', 'b', '/'), maxLength: 12 });
    const arbOptions = fc.record({ anchored: fc.boolean() });

    describe('Given any pattern and any line-terminator-free path', () => {
      describe('When matched', () => {
        it('Then the linear matcher agrees with the regex oracle', () => {
          // Arrange
          fc.assert(
            fc.property(arbPattern, arbPath, arbOptions, (pattern, path, options) => {
              // Act
              const linear = compileGlob(pattern, options).test(path);
              const oracle = oracleRegex(pattern, options).test(path);

              // Assert
              expect(linear).toBe(oracle);
            }),
            { numRuns: 1000 },
          );
        });
      });
    });

    describe('Given a literal-led pattern and a path over the same small alphabet', () => {
      const arbLead = fc.string({ unit: fc.constantFrom('a', 'b', 'A', '/'), maxLength: 6 });
      const arbTail = fc.string({ unit: fc.constantFrom('a', '*', '?', '/', 'B'), maxLength: 6 });
      const arbText = fc.string({
        unit: fc.constantFrom('a', 'b', 'A', 'B', '/'),
        maxLength: 12,
      });

      describe('When matched with and without caseFold', () => {
        it('Then the prefix fast path agrees with the regex oracle', () => {
          // Arrange
          fc.assert(
            fc.property(
              arbLead,
              arbTail,
              arbText,
              fc.boolean(),
              fc.boolean(),
              (lead, tail, path, anchored, caseFold) => {
                const pattern = `${lead}${tail}`;
                const oracle = oracleRegex(caseFold ? pattern.toLowerCase() : pattern, {
                  anchored,
                });

                // Act
                const linear = compileGlob(pattern, { anchored, caseFold }).test(path);

                // Assert
                expect(linear).toBe(oracle.test(caseFold ? path.toLowerCase() : path));
              },
            ),
            { numRuns: 2000 },
          );
        });
      });
    });
  });
});
