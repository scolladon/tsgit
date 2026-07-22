import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type CompileGlobOptions,
  compileGlob,
  containsGlob,
} from '../../../../src/domain/pathspec/compile-glob.js';

/**
 * Oracle — the original regex-based compiler, kept verbatim as a test-only
 * reference. The linear matcher must agree with it for every path free of JS
 * line terminators (the domain on which the two are required to match — see
 * docs/design/compile-glob-redos.md §6).
 */
const ORACLE_SPECIALS = /[.+^${}()|[\]\\]/;
const oracleStar = (pattern: string, i: number): { regex: string; next: number } => {
  if (pattern[i + 1] !== '*') return { regex: '[^/]*', next: i + 1 };
  const after = i + 2;
  if (pattern[after] === '/') return { regex: '(.*/)?', next: after + 1 };
  return { regex: '.*', next: after };
};
const oracleToken = (pattern: string, i: number): { regex: string; next: number } => {
  const ch = pattern[i] as string;
  if (ch === '*') return oracleStar(pattern, i);
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
  const suffix = options.withDirSuffix === true ? '(/.*)?$' : '$';
  return new RegExp(`${prefix}${body}${suffix}`);
};

describe('compileGlob', () => {
  describe('Given a literal "src" with anchored=true and no dir suffix', () => {
    describe('When compiled', () => {
      it('Then matches only the exact path', () => {
        // Arrange
        const sut = compileGlob('src', { anchored: true });

        // Assert
        expect(sut.test('src')).toBe(true);
        expect(sut.test('src/foo')).toBe(false);
        expect(sut.test('other')).toBe(false);
      });
    });
  });

  describe('Given anchored=true', () => {
    describe('When matched against a path that merely ends with the pattern', () => {
      it('Then it does NOT match (the `^` anchor is present)', () => {
        // Arrange — without the leading `^` the regex would be `src$`, which matches
        // any string ending in `src`. The anchor must reject a prefixed path.
        const sut = compileGlob('src', { anchored: true });

        // Act / Assert
        expect(sut.test('vendorsrc')).toBe(false);
        expect(sut.test('a/src')).toBe(false);
        expect(sut.test('src')).toBe(true);
      });
    });
  });

  describe('Given a literal "src" with anchored=true AND withDirSuffix=true', () => {
    describe('When compiled', () => {
      it('Then matches the path AND any descendant', () => {
        // Arrange
        const sut = compileGlob('src', { anchored: true, withDirSuffix: true });

        // Assert
        expect(sut.test('src')).toBe(true);
        expect(sut.test('src/foo')).toBe(true);
        expect(sut.test('src/a/b/c')).toBe(true);
        expect(sut.test('other')).toBe(false);
        expect(sut.test('src-other')).toBe(false);
      });
    });
  });

  describe('Given a single-star glob "*.ts" non-anchored', () => {
    describe('When compiled', () => {
      it('Then matches files at any depth', () => {
        // Arrange
        const sut = compileGlob('*.ts', { anchored: false });

        // Assert
        expect(sut.test('foo.ts')).toBe(true);
        expect(sut.test('src/foo.ts')).toBe(true);
        expect(sut.test('foo.tsx')).toBe(false);
        expect(sut.test('foo')).toBe(false);
      });
    });
  });

  describe('Given a single-star glob', () => {
    describe('When matched against a path with a slash inside the segment', () => {
      it('Then it does NOT match (single `*` excludes `/`)', () => {
        // Arrange
        const sut = compileGlob('a*c', { anchored: true });

        // Assert
        expect(sut.test('abc')).toBe(true);
        expect(sut.test('a/c')).toBe(false);
      });
    });
  });

  describe('Given a double-star glob "**"', () => {
    describe('When matched', () => {
      it('Then it spans path segments', () => {
        // Arrange
        const sut = compileGlob('a/**/c', { anchored: true });

        // Assert
        expect(sut.test('a/c')).toBe(true);
        expect(sut.test('a/b/c')).toBe(true);
        expect(sut.test('a/b/d/c')).toBe(true);
        expect(sut.test('a/d')).toBe(false);
      });
    });
  });

  describe('Given a `?` glob', () => {
    describe('When matched', () => {
      it('Then it matches exactly one non-`/` byte (not zero, not many)', () => {
        // Arrange
        const sut = compileGlob('a?c', { anchored: true });

        // Assert
        expect(sut.test('abc')).toBe(true);
        expect(sut.test('ac')).toBe(false);
        expect(sut.test('abbc')).toBe(false);
        expect(sut.test('a/c')).toBe(false);
      });
    });
  });

  describe('Given a mid-pattern `**/`', () => {
    describe('When matched', () => {
      it('Then it spans zero-or-more segments AND does NOT match within a segment (kills the `.*` regex bug)', () => {
        // Arrange
        const sut = compileGlob('a/**/c', { anchored: true });

        // Assert
        expect(sut.test('a/c')).toBe(true);
        expect(sut.test('a/b/c')).toBe(true);
        expect(sut.test('a/b/d/c')).toBe(true);
        // The bug case: `a/xc` is `a` followed by a single segment `xc`.
        // The original `.*` regex compiled `^a/.*c$`, which matched this
        // path. The corrected `(.*/)?` regex requires at least one trailing
        // `/` between `a/` and `c`, so this must NOT match.
        expect(sut.test('a/xc')).toBe(false);
      });
    });
  });

  describe('Given a pattern with regex specials', () => {
    describe('When compiled', () => {
      it('Then they are escaped (literal match)', () => {
        // Arrange
        const sut = compileGlob('foo.bar', { anchored: true });

        // Assert
        expect(sut.test('foo.bar')).toBe(true);
        expect(sut.test('fooXbar')).toBe(false);
      });
    });
  });

  describe('Given a `[abc]` pattern', () => {
    describe('When compiled in v1', () => {
      it('Then the brackets are escaped (literal match — character classes not supported)', () => {
        // Arrange
        const sut = compileGlob('[abc]', { anchored: true });

        // Assert
        expect(sut.test('[abc]')).toBe(true);
        expect(sut.test('a')).toBe(false);
      });
    });
  });

  describe('Given anchored=false', () => {
    describe('When compiled', () => {
      it('Then the pattern matches at any depth via the (^|.*/) prefix', () => {
        // Arrange
        const sut = compileGlob('foo', { anchored: false });

        // Assert
        expect(sut.test('foo')).toBe(true);
        expect(sut.test('a/foo')).toBe(true);
        expect(sut.test('a/b/foo')).toBe(true);
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
        const sut = compileGlob('bar', { anchored: false });

        // Act / Assert
        expect(sut.test('foobar')).toBe(false);
        // Balance: the legitimate segment matches must still hold.
        expect(sut.test('bar')).toBe(true);
        expect(sut.test('x/bar')).toBe(true);
      });
    });
  });

  describe('Given a non-anchored GLOB "*.ts"', () => {
    describe('When matched at depth', () => {
      it('Then matches at any segment AND rejects non-matching extensions', () => {
        // Arrange
        const sut = compileGlob('*.ts', { anchored: false });

        // Assert
        expect(sut.test('a.ts')).toBe(true);
        expect(sut.test('src/a.ts')).toBe(true);
        expect(sut.test('src/a/b.ts')).toBe(true);
        expect(sut.test('src/a.js')).toBe(false);
      });
    });
  });

  describe('Given an empty pattern with anchored=true', () => {
    describe('When matched', () => {
      it('Then only the empty string matches', () => {
        // Arrange — a zero-token pattern: the base layer must accept exactly j===0.
        const sut = compileGlob('', { anchored: true });

        // Act / Assert
        expect(sut.test('')).toBe(true);
        expect(sut.test('a')).toBe(false);
      });
    });
  });

  describe('Given a single `*`', () => {
    describe('When matched', () => {
      it('Then it matches a zero-length run (not only non-empty runs)', () => {
        // Arrange — `a*` must match bare `a`; a mutant forcing `*` to consume at
        // least one char would reject it.
        const sut = compileGlob('a*', { anchored: true });

        // Act / Assert
        expect(sut.test('a')).toBe(true);
        expect(sut.test('abc')).toBe(true);
      });
    });
  });

  describe('Given a `**` NOT followed by `/`', () => {
    describe('When matched', () => {
      it('Then it spans `/` within a segment run', () => {
        // Arrange — `a**z` compiles to [literal a, star-star, literal z]; the
        // star-star run spans slashes, unlike a single `*`.
        const sut = compileGlob('a**z', { anchored: true });

        // Act / Assert
        expect(sut.test('a/x/z')).toBe(true);
        expect(sut.test('axyz')).toBe(true);
        expect(sut.test('az')).toBe(true);
        // A single-star `a*z` would reject the slash-crossing case.
        expect(compileGlob('a*z', { anchored: true }).test('a/x/z')).toBe(false);
      });
    });
  });

  describe('Given a `***` run', () => {
    describe('When matched', () => {
      it('Then it behaves as `**` followed by `*`', () => {
        // Arrange — `***` scans to [star-star, star]; both span freely so the
        // pair matches any run, slashes included.
        const sut = compileGlob('a***z', { anchored: true });

        // Act / Assert
        expect(sut.test('a/x/z')).toBe(true);
        expect(sut.test('az')).toBe(true);
      });
    });
  });

  describe('Given a trailing `**`', () => {
    describe('When the matched prefix is the whole path', () => {
      it('Then the empty remainder still matches', () => {
        // Arrange — `a**` ends in star-star; its layer at the path end must accept
        // an empty remaining run.
        const sut = compileGlob('a**', { anchored: true });

        // Act / Assert
        expect(sut.test('a')).toBe(true);
        expect(sut.test('a/b/c')).toBe(true);
      });
    });
  });

  describe('Given a trailing `**` followed by a literal', () => {
    describe('When the literal is absent', () => {
      it('Then it does NOT match', () => {
        // Arrange — `a**b` must reject `a`: star-star matches the empty run, but
        // the trailing `b` then has nothing to match.
        const sut = compileGlob('a**b', { anchored: true });

        // Act / Assert
        expect(sut.test('a')).toBe(false);
        expect(sut.test('ab')).toBe(true);
      });
    });
  });

  describe('equivalence with the original regex compiler', () => {
    const arbPattern = fc.string({
      unit: fc.constantFrom('a', 'b', '/', '*', '?', '.'),
      maxLength: 12,
    });
    const arbPath = fc.string({ unit: fc.constantFrom('a', 'b', '/'), maxLength: 12 });
    const arbOptions = fc.record({
      anchored: fc.boolean(),
      withDirSuffix: fc.boolean(),
    });

    describe('Given any pattern and any line-terminator-free path', () => {
      describe('When matched', () => {
        it('Then the linear matcher agrees with the regex oracle', () => {
          // Arrange + Assert
          fc.assert(
            fc.property(arbPattern, arbPath, arbOptions, (pattern, path, options) => {
              const linear = compileGlob(pattern, options).test(path);
              const oracle = oracleRegex(pattern, options).test(path);
              expect(linear).toBe(oracle);
            }),
            { numRuns: 1000 },
          );
        });
      });
    });
  });
});

describe('containsGlob', () => {
  describe('Given pattern %j', () => {
    describe('When checked', () => {
      it.each([
        ['*.ts', true],
        ['a?b', true],
        ['src/**', true],
        ['plain.ts', false],
        ['a/b/c', false],
        ['', false],
        ['[abc]', false],
      ])('Then returns %s (no character-class detection in v1)', (input, expected) => {
        // Arrange
        const sut = containsGlob(input);

        // Assert
        expect(sut).toBe(expected);
      });
    });
  });
});
