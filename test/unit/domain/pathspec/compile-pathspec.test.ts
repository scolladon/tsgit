import { describe, expect, it } from 'vitest';
import { compilePathspec } from '../../../../src/domain/pathspec/compile-pathspec.js';

describe('compilePathspec', () => {
  it('Given an empty list, When compiled, Then yields an empty array', () => {
    expect(compilePathspec([])).toEqual([]);
  });

  it('Given a single literal "src/foo.ts", When compiled, Then yields one literal entry with regex matching path-or-descendants', () => {
    const sut = compilePathspec(['src/foo.ts']);

    expect(sut).toHaveLength(1);
    expect(sut[0]?.isLiteral).toBe(true);
    expect(sut[0]?.negated).toBe(false);
    expect(sut[0]?.compiled.test('src/foo.ts')).toBe(true);
    // Literal acts as directory prefix.
    expect(sut[0]?.compiled.test('src/foo.ts/inner')).toBe(true);
    expect(sut[0]?.compiled.test('src/other.ts')).toBe(false);
  });

  it('Given a glob "*.ts", When compiled, Then yields a non-literal non-anchored entry', () => {
    const sut = compilePathspec(['*.ts']);

    expect(sut[0]?.isLiteral).toBe(false);
    expect(sut[0]?.negated).toBe(false);
    // Non-anchored — matches at any depth.
    expect(sut[0]?.compiled.test('foo.ts')).toBe(true);
    expect(sut[0]?.compiled.test('src/foo.ts')).toBe(true);
  });

  it('Given an anchored glob "src/**", When compiled, Then yields an anchored entry', () => {
    const sut = compilePathspec(['src/**']);

    expect(sut[0]?.isLiteral).toBe(false);
    // Anchored — only matches paths starting at the repo root.
    expect(sut[0]?.compiled.test('src/foo')).toBe(true);
    expect(sut[0]?.compiled.test('src/a/b/c')).toBe(true);
    expect(sut[0]?.compiled.test('other/src/x')).toBe(false);
  });

  it('Given a "!"-prefixed literal "!src/foo", When compiled, Then negated=true and the body parses as literal', () => {
    const sut = compilePathspec(['!src/foo']);

    expect(sut[0]?.negated).toBe(true);
    expect(sut[0]?.isLiteral).toBe(true);
    expect(sut[0]?.pattern).toBe('!src/foo');
    expect(sut[0]?.compiled.test('src/foo')).toBe(true);
  });

  it('Given a bare literal "lib", When compiled, Then the regex matches the directory AND every descendant (withDirSuffix is enabled)', () => {
    // Arrange — a literal pathspec compiles with `withDirSuffix: true`, so the
    // regex must cover descendants. If the flag were `false` the regex would be
    // `^lib$` and reject everything below `lib`.
    const sut = compilePathspec(['lib']);

    // Act / Assert
    expect(sut[0]?.compiled.test('lib')).toBe(true);
    expect(sut[0]?.compiled.test('lib/a.ts')).toBe(true);
    expect(sut[0]?.compiled.test('lib/nested/deep.ts')).toBe(true);
    expect(sut[0]?.compiled.test('libs')).toBe(false);
  });

  it('Given a "!"-prefixed glob "!*.test.ts", When compiled, Then negated=true with glob semantics', () => {
    const sut = compilePathspec(['!*.test.ts']);

    expect(sut[0]?.negated).toBe(true);
    expect(sut[0]?.isLiteral).toBe(false);
    expect(sut[0]?.compiled.test('foo.test.ts')).toBe(true);
  });

  it('Given multiple patterns, When compiled, Then the order is preserved', () => {
    const sut = compilePathspec(['*.ts', '!*.test.ts', 'src/foo']);

    expect(sut.map((e) => e.pattern)).toEqual(['*.ts', '!*.test.ts', 'src/foo']);
  });
});
