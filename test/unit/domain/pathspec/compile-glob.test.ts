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
  it('Given a literal "src" with anchored=true and no dir suffix, When compiled, Then matches only the exact path', () => {
    const sut = compileGlob('src', { anchored: true });

    expect(sut.test('src')).toBe(true);
    expect(sut.test('src/foo')).toBe(false);
    expect(sut.test('other')).toBe(false);
  });

  it('Given anchored=true, When matched against a path that merely ends with the pattern, Then it does NOT match (the `^` anchor is present)', () => {
    // Arrange — without the leading `^` the regex would be `src$`, which matches
    // any string ending in `src`. The anchor must reject a prefixed path.
    const sut = compileGlob('src', { anchored: true });

    // Act / Assert
    expect(sut.test('vendorsrc')).toBe(false);
    expect(sut.test('a/src')).toBe(false);
    expect(sut.test('src')).toBe(true);
  });

  it('Given a literal "src" with anchored=true AND withDirSuffix=true, When compiled, Then matches the path AND any descendant', () => {
    const sut = compileGlob('src', { anchored: true, withDirSuffix: true });

    expect(sut.test('src')).toBe(true);
    expect(sut.test('src/foo')).toBe(true);
    expect(sut.test('src/a/b/c')).toBe(true);
    expect(sut.test('other')).toBe(false);
    expect(sut.test('src-other')).toBe(false);
  });

  it('Given a single-star glob "*.ts" non-anchored, When compiled, Then matches files at any depth', () => {
    const sut = compileGlob('*.ts', { anchored: false });

    expect(sut.test('foo.ts')).toBe(true);
    expect(sut.test('src/foo.ts')).toBe(true);
    expect(sut.test('foo.tsx')).toBe(false);
    expect(sut.test('foo')).toBe(false);
  });

  it('Given a single-star glob, When matched against a path with a slash inside the segment, Then it does NOT match (single `*` excludes `/`)', () => {
    const sut = compileGlob('a*c', { anchored: true });

    expect(sut.test('abc')).toBe(true);
    expect(sut.test('a/c')).toBe(false);
  });

  it('Given a double-star glob "**", When matched, Then it spans path segments', () => {
    const sut = compileGlob('a/**/c', { anchored: true });

    expect(sut.test('a/c')).toBe(true);
    expect(sut.test('a/b/c')).toBe(true);
    expect(sut.test('a/b/d/c')).toBe(true);
    expect(sut.test('a/d')).toBe(false);
  });

  it('Given a `?` glob, When matched, Then it matches exactly one non-`/` byte (not zero, not many)', () => {
    const sut = compileGlob('a?c', { anchored: true });

    expect(sut.test('abc')).toBe(true);
    expect(sut.test('ac')).toBe(false);
    expect(sut.test('abbc')).toBe(false);
    expect(sut.test('a/c')).toBe(false);
  });

  it('Given a mid-pattern `**/`, When matched, Then it spans zero-or-more segments AND does NOT match within a segment (kills the `.*` regex bug)', () => {
    const sut = compileGlob('a/**/c', { anchored: true });

    expect(sut.test('a/c')).toBe(true);
    expect(sut.test('a/b/c')).toBe(true);
    expect(sut.test('a/b/d/c')).toBe(true);
    // The bug case: `a/xc` is `a` followed by a single segment `xc`.
    // The original `.*` regex compiled `^a/.*c$`, which matched this
    // path. The corrected `(.*/)?` regex requires at least one trailing
    // `/` between `a/` and `c`, so this must NOT match.
    expect(sut.test('a/xc')).toBe(false);
  });

  it('Given a pattern with regex specials, When compiled, Then they are escaped (literal match)', () => {
    const sut = compileGlob('foo.bar', { anchored: true });

    expect(sut.test('foo.bar')).toBe(true);
    expect(sut.test('fooXbar')).toBe(false);
  });

  it('Given a `[abc]` pattern, When compiled in v1, Then the brackets are escaped (literal match — character classes not supported)', () => {
    const sut = compileGlob('[abc]', { anchored: true });

    expect(sut.test('[abc]')).toBe(true);
    expect(sut.test('a')).toBe(false);
  });

  it('Given anchored=false, When compiled, Then the pattern matches at any depth via the (^|.*/) prefix', () => {
    const sut = compileGlob('foo', { anchored: false });

    expect(sut.test('foo')).toBe(true);
    expect(sut.test('a/foo')).toBe(true);
    expect(sut.test('a/b/foo')).toBe(true);
  });

  it('Given an unanchored literal "bar", When matched against "foobar", Then it does NOT match (the (^|.*/) prefix forbids a mid-segment match)', () => {
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

  it('Given a non-anchored GLOB "*.ts", When matched at depth, Then matches at any segment AND rejects non-matching extensions', () => {
    const sut = compileGlob('*.ts', { anchored: false });

    expect(sut.test('a.ts')).toBe(true);
    expect(sut.test('src/a.ts')).toBe(true);
    expect(sut.test('src/a/b.ts')).toBe(true);
    expect(sut.test('src/a.js')).toBe(false);
  });

  it('Given an empty pattern with anchored=true, When matched, Then only the empty string matches', () => {
    // Arrange — a zero-token pattern: the base layer must accept exactly j===0.
    const sut = compileGlob('', { anchored: true });

    // Act / Assert
    expect(sut.test('')).toBe(true);
    expect(sut.test('a')).toBe(false);
  });

  it('Given a single `*`, When matched, Then it matches a zero-length run (not only non-empty runs)', () => {
    // Arrange — `a*` must match bare `a`; a mutant forcing `*` to consume at
    // least one char would reject it.
    const sut = compileGlob('a*', { anchored: true });

    // Act / Assert
    expect(sut.test('a')).toBe(true);
    expect(sut.test('abc')).toBe(true);
  });

  it('Given a `**` NOT followed by `/`, When matched, Then it spans `/` within a segment run', () => {
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

  it('Given a `***` run, When matched, Then it behaves as `**` followed by `*`', () => {
    // Arrange — `***` scans to [star-star, star]; both span freely so the
    // pair matches any run, slashes included.
    const sut = compileGlob('a***z', { anchored: true });

    // Act / Assert
    expect(sut.test('a/x/z')).toBe(true);
    expect(sut.test('az')).toBe(true);
  });

  it('Given an adversarial `a*a*…*b` pattern, When matched against a long non-matching run, Then it returns false without catastrophic backtracking', () => {
    // Arrange — the ReDoS regression. The old regex `^a[^/]*a[^/]*…b$` would
    // explore exponentially many splits of the `a`-run and hang the test;
    // the linear matcher fills a table in O(tokens × length).
    const sut = compileGlob(`${'a*'.repeat(64)}b`, { anchored: true });
    const adversarial = 'a'.repeat(10_000);

    // Act
    const start = performance.now();
    const result = sut.test(adversarial);
    const elapsedMs = performance.now() - start;

    // Assert — no `b`, so no match; and it completes near-instantly.
    expect(result).toBe(false);
    expect(elapsedMs).toBeLessThan(1000);
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

    it('Given any pattern and any line-terminator-free path, When matched, Then the linear matcher agrees with the regex oracle', () => {
      fc.assert(
        fc.property(arbPattern, arbPath, arbOptions, (pattern, path, options) => {
          const linear = compileGlob(pattern, options).test(path);
          const oracle = oracleRegex(pattern, options).test(path);
          expect(linear).toBe(oracle);
        }),
      );
    });
  });
});

describe('containsGlob', () => {
  it.each([
    ['*.ts', true],
    ['a?b', true],
    ['src/**', true],
    ['plain.ts', false],
    ['a/b/c', false],
    ['', false],
    ['[abc]', false],
  ])('Given pattern %j, When checked, Then returns %s (no character-class detection in v1)', (input, expected) => {
    expect(containsGlob(input)).toBe(expected);
  });
});
