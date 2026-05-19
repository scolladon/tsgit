import { describe, expect, it } from 'vitest';
import { compileGlob, containsGlob } from '../../../../src/domain/pathspec/compile-glob.js';

describe('compileGlob', () => {
  it('Given a literal "src" with anchored=true and no dir suffix, When compiled, Then matches only the exact path', () => {
    const sut = compileGlob('src', { anchored: true });

    expect(sut.test('src')).toBe(true);
    expect(sut.test('src/foo')).toBe(false);
    expect(sut.test('other')).toBe(false);
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

  it('Given a `?` glob, When matched, Then it matches exactly one non-`/` byte', () => {
    const sut = compileGlob('a?c', { anchored: true });

    expect(sut.test('abc')).toBe(true);
    expect(sut.test('ac')).toBe(false);
    expect(sut.test('a/c')).toBe(false);
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
