import { describe, expect, it } from 'vitest';

import { matches } from '../../../../src/domain/ignore/match.js';
import { parseGitignore } from '../../../../src/domain/ignore/parse-gitignore.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';

const path = (s: string): FilePath => s as FilePath;

describe('matches', () => {
  it('Given an empty ruleset, When matches anything, Then returns "unset"', () => {
    // Arrange
    const rules = parseGitignore('');

    // Act
    const sut = matches(rules, path('foo.ts'), false);

    // Assert
    expect(sut).toBe('unset');
  });

  it('Given ruleset=[*.log] and path "foo.log", When matches, Then returns "ignored"', () => {
    // Arrange
    const rules = parseGitignore('*.log');

    // Act
    const sut = matches(rules, path('foo.log'), false);

    // Assert
    expect(sut).toBe('ignored');
  });

  it('Given ruleset=[*.log, !important.log] and path "important.log", When matches, Then "unignored" (last-match wins)', () => {
    // Arrange
    const rules = parseGitignore('*.log\n!important.log');

    // Act
    const sut = matches(rules, path('important.log'), false);

    // Assert
    expect(sut).toBe('unignored');
  });

  it('Given ruleset=[build/] and path "build" with isDir=true, When matches, Then "ignored"', () => {
    // Arrange
    const rules = parseGitignore('build/');

    // Act
    const sut = matches(rules, path('build'), true);

    // Assert
    expect(sut).toBe('ignored');
  });

  it('Given ruleset=[build/] and path "build" with isDir=false, When matches, Then "unset" (directory-only)', () => {
    // Arrange
    const rules = parseGitignore('build/');

    // Act
    const sut = matches(rules, path('build'), false);

    // Assert
    expect(sut).toBe('unset');
  });

  it('Given ruleset=[/dist] and path "dist", When matches, Then "ignored" (anchored matches root)', () => {
    // Arrange
    const rules = parseGitignore('/dist');

    // Act
    const sut = matches(rules, path('dist'), true);

    // Assert
    expect(sut).toBe('ignored');
  });

  it('Given ruleset=[/dist] and path "src/dist", When matches, Then "unset" (anchored does NOT match nested)', () => {
    // Arrange
    const rules = parseGitignore('/dist');

    // Act
    const sut = matches(rules, path('src/dist'), true);

    // Assert
    expect(sut).toBe('unset');
  });

  it('Given ruleset=[**/node_modules] and path "a/b/node_modules", When matches, Then "ignored"', () => {
    // Arrange
    const rules = parseGitignore('**/node_modules');

    // Act
    const sut = matches(rules, path('a/b/node_modules'), true);

    // Assert
    expect(sut).toBe('ignored');
  });

  it('Given a non-matching pattern, When matches, Then "unset"', () => {
    // Arrange
    const rules = parseGitignore('*.log');

    // Act
    const sut = matches(rules, path('foo.txt'), false);

    // Assert
    expect(sut).toBe('unset');
  });
});
