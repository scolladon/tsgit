import { describe, expect, it } from 'vitest';

import { tokenizeIgnoreLine } from '../../../../src/domain/ignore/index.js';
import { FilePath } from '../../../../src/domain/objects/object-id.js';
import { compileSparseRule, nonConeMatcher } from '../../../../src/domain/sparse/non-cone.js';
import type { SparseRule } from '../../../../src/domain/sparse/sparse-pattern.js';

const path = (p: string): FilePath => FilePath.from(p);

const rule = (line: string): SparseRule => {
  const tokenized = tokenizeIgnoreLine(line);
  if (tokenized === undefined) throw new Error(`unexpected skipped line: ${line}`);
  return compileSparseRule(tokenized, line);
};

describe('compileSparseRule', () => {
  it('Given "/src/", When compiled, Then it covers "src" and every descendant', () => {
    // Arrange / Act
    const sut = rule('/src/');

    // Assert
    expect(sut.regex.test('src')).toBe(true);
    expect(sut.regex.test('src/main.c')).toBe(true);
    expect(sut.regex.test('src/a/b/c.ts')).toBe(true);
  });

  it('Given "/src" (no wildcard), When compiled, Then it covers "src" and every descendant', () => {
    // Arrange / Act
    const sut = rule('/src');

    // Assert
    expect(sut.regex.test('src')).toBe(true);
    expect(sut.regex.test('src/main.c')).toBe(true);
  });

  it('Given "*.ts", When compiled, Then it covers any .ts file at any depth', () => {
    // Arrange / Act
    const sut = rule('*.ts');

    // Assert
    expect(sut.regex.test('main.ts')).toBe(true);
    expect(sut.regex.test('src/app/main.ts')).toBe(true);
    expect(sut.regex.test('main.js')).toBe(false);
  });

  it('Given "/src/*" (wildcard last segment), When compiled, Then it covers only direct children', () => {
    // Arrange / Act
    const sut = rule('/src/*');

    // Assert
    expect(sut.regex.test('src/main.c')).toBe(true);
    expect(sut.regex.test('src/a/b.c')).toBe(false);
  });

  it('Given "build", When compiled, Then it covers any build subtree at any depth', () => {
    // Arrange / Act
    const sut = rule('build');

    // Assert
    expect(sut.regex.test('build')).toBe(true);
    expect(sut.regex.test('build/out.o')).toBe(true);
    expect(sut.regex.test('pkg/build/out.o')).toBe(true);
  });

  it('Given a "?"-wildcard last segment, When compiled, Then it is non-recursive', () => {
    // Arrange — `?` is a glob metacharacter, so the rule does not cover descendants.
    const sut = rule('/src/a?c');

    // Assert
    expect(sut.regex.test('src/abc')).toBe(true);
    expect(sut.regex.test('src/abc/deep.ts')).toBe(false);
  });

  it('Given a directory-only rule with a wildcard last segment, When compiled, Then directoryOnly alone makes it recursive', () => {
    // Arrange — `/src*/` has a glob (`*`) last segment, so the only reason it
    // covers descendants is the trailing-slash directory-only flag.
    const sut = rule('/src*/');

    // Assert
    expect(sut.regex.test('src-app')).toBe(true);
    expect(sut.regex.test('src-app/deep/file.ts')).toBe(true);
  });

  it('Given a "!"-prefixed line, When compiled, Then the rule is negated and carries the source', () => {
    // Arrange / Act
    const sut = rule('!build');

    // Assert
    expect(sut.negated).toBe(true);
    expect(sut.source).toBe('!build');
  });

  it('Given a plain line, When compiled, Then the rule is not negated', () => {
    // Arrange / Act
    const sut = rule('build');

    // Assert
    expect(sut.negated).toBe(false);
  });
});

describe('nonConeMatcher', () => {
  it('Given no rules, When matched, Then nothing is in the sparse set', () => {
    // Arrange
    const sut = nonConeMatcher([]);

    // Act
    const result = sut(path('any/file.ts'));

    // Assert
    expect(result).toBe(false);
  });

  it('Given a single covering rule, When matched, Then the path is included', () => {
    // Arrange
    const sut = nonConeMatcher([rule('/src/')]);

    // Act
    const result = sut(path('src/main.ts'));

    // Assert
    expect(result).toBe(true);
  });

  it('Given a covering rule, When a non-covered path is matched, Then it is excluded', () => {
    // Arrange
    const sut = nonConeMatcher([rule('/src/')]);

    // Act
    const result = sut(path('docs/guide.md'));

    // Assert
    expect(result).toBe(false);
  });

  it('Given an include then a negation, When matched, Then the negation wins (last-match)', () => {
    // Arrange
    const sut = nonConeMatcher([rule('/src/'), rule('!/src/secret/')]);

    // Act
    const result = sut(path('src/secret/key.ts'));

    // Assert
    expect(result).toBe(false);
  });

  it('Given a negation then a re-include, When matched, Then the re-include wins (last-match)', () => {
    // Arrange
    const sut = nonConeMatcher([rule('/src/'), rule('!/src/secret/'), rule('/src/secret/pub.ts')]);

    // Act
    const result = sut(path('src/secret/pub.ts'));

    // Assert
    expect(result).toBe(true);
  });

  it('Given a path matched by no rule, When matched, Then it defaults to excluded', () => {
    // Arrange
    const sut = nonConeMatcher([rule('/src/'), rule('!/src/secret/')]);

    // Act
    const result = sut(path('lib/util.ts'));

    // Assert
    expect(result).toBe(false);
  });
});
