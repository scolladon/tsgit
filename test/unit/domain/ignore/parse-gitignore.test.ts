import { describe, expect, it } from 'vitest';

import { parseGitignore } from '../../../../src/domain/ignore/parse-gitignore.js';

describe('parseGitignore', () => {
  it('Given empty input, When parsed, Then yields zero rules', () => {
    // Arrange
    const input = '';

    // Act
    const sut = parseGitignore(input);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given only a comment line, When parsed, Then yields zero rules', () => {
    // Arrange
    const input = '# this is a comment\n';

    // Act
    const sut = parseGitignore(input);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given only a blank line, When parsed, Then yields zero rules', () => {
    // Arrange
    const input = '\n   \n\n';

    // Act
    const sut = parseGitignore(input);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given "build/", When parsed, Then yields one directory-only rule', () => {
    // Arrange
    const input = 'build/';

    // Act
    const sut = parseGitignore(input);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.directoryOnly).toBe(true);
    expect(sut[0]?.negated).toBe(false);
    expect(sut[0]?.pattern).toBe('build/');
  });

  it('Given "*.log", When parsed, Then yields one rule that matches "foo.log"', () => {
    // Arrange
    const input = '*.log';

    // Act
    const sut = parseGitignore(input);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.compiled.test('foo.log')).toBe(true);
    expect(sut[0]?.compiled.test('foo/log')).toBe(false);
  });

  it('Given "!**/*.keep", When parsed, Then yields one negated rule', () => {
    // Arrange
    const input = '!**/*.keep';

    // Act
    const sut = parseGitignore(input);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.negated).toBe(true);
    expect(sut[0]?.pattern).toBe('!**/*.keep');
  });

  it('Given "/dist", When parsed, Then yields one anchored rule', () => {
    // Arrange
    const input = '/dist';

    // Act
    const sut = parseGitignore(input);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.anchored).toBe(true);
  });

  it('Given a line with trailing spaces, When parsed, Then trailing spaces stripped from pattern', () => {
    // Arrange
    const input = 'foo   \n';

    // Act
    const sut = parseGitignore(input);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.pattern).toBe('foo');
  });

  it('Given a line with escaped trailing space, When parsed, Then escaped space is preserved', () => {
    // Arrange
    const input = 'foo\\ \n';

    // Act
    const sut = parseGitignore(input);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.pattern).toBe('foo ');
  });

  it('Given a two-char line of escaped space "\\ ", When parsed, Then the escaped space is preserved', () => {
    // Arrange — line is exactly backslash + space (length 2). stripTrailingSpaces
    // starts at end=2; the `end >= 2` guard must hold so it inspects
    // charCodeAt(0)===0x5c and breaks, preserving the space. The `end > 2`
    // mutant would make `2 > 2` false → no break → space stripped → pattern '\'.
    const input = '\\ ';

    // Act
    const sut = parseGitignore(input);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.pattern).toBe(' ');
  });

  it('Given "a/b" (slash only in the middle), When parsed, Then the rule is anchored', () => {
    // Arrange — kills the `||` -> `&&` LogicalOperator mutant on the `anchored`
    // expression: `startsWith('/')` is false here, `includes('/')` is true, so
    // `||` yields true while `&&` would yield false.
    const input = 'a/b';

    // Act
    const sut = parseGitignore(input);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.anchored).toBe(true);
  });

  it('Given "plain" (no slash anywhere), When parsed, Then the rule is NOT anchored', () => {
    // Arrange — complements the `a/b` case: with no slash, `anchored` is false.
    // Pins that `includes('/')` actually drives the result.
    const input = 'plain';

    // Act
    const sut = parseGitignore(input);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.anchored).toBe(false);
  });

  it('Given an escaped # at line start, When parsed, Then yields a literal-# rule (not a comment)', () => {
    // Arrange
    const input = '\\#literal';

    // Act
    const sut = parseGitignore(input);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.pattern).toBe('#literal');
  });

  it('Given a "?" glob, When parsed, Then matches a single non-slash character', () => {
    // Arrange
    const input = 'foo?.txt';

    // Act
    const sut = parseGitignore(input);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.compiled.test('foo1.txt')).toBe(true);
    expect(sut[0]?.compiled.test('foo.txt')).toBe(false);
    expect(sut[0]?.compiled.test('foo/.txt')).toBe(false);
  });

  it('Given "**foo" (no slash after **), When parsed, Then the ** consumes only itself', () => {
    // Arrange
    const input = '**foo';

    // Act
    const sut = parseGitignore(input);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.compiled.test('barfoo')).toBe(true);
    expect(sut[0]?.compiled.test('a/b/foobar')).toBe(false);
  });

  it('Given "**" followed by "/foo", When parsed, Then the slash after ** is consumed', () => {
    // Arrange
    const input = '**/foo';

    // Act
    const sut = parseGitignore(input);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.compiled.test('foo')).toBe(true);
    expect(sut[0]?.compiled.test('a/b/foo')).toBe(true);
  });

  it('Given a line that becomes empty after trailing-space strip, When parsed, Then yields no rule', () => {
    // Arrange — a line of only spaces (no escape) → stripTrailingSpaces returns ''
    const input = '   \n';

    // Act
    const sut = parseGitignore(input);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a pattern with regex specials (parens, brackets), When parsed, Then they are escaped', () => {
    // Arrange
    const input = 'a(b).txt';

    // Act
    const sut = parseGitignore(input);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.compiled.test('a(b).txt')).toBe(true);
    expect(sut[0]?.compiled.test('ab.txt')).toBe(false);
  });

  it('Given multiple lines mixing comments + rules, When parsed, Then yields only the rules', () => {
    // Arrange
    const input = '# header\n\n*.log\nbuild/\n!important.log\n# trailing comment\n';

    // Act
    const sut = parseGitignore(input);

    // Assert
    expect(sut).toHaveLength(3);
    expect(sut[0]?.pattern).toBe('*.log');
    expect(sut[1]?.directoryOnly).toBe(true);
    expect(sut[2]?.negated).toBe(true);
  });
});
