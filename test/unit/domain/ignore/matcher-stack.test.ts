import { describe, expect, it } from 'vitest';
import { type IgnoreLevel, matchInStack } from '../../../../src/domain/ignore/matcher-stack.js';
import { parseGitignore } from '../../../../src/domain/ignore/parse-gitignore.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';

const level = (basedir: '' | string, source: string): IgnoreLevel => ({
  basedir: basedir as IgnoreLevel['basedir'],
  rules: parseGitignore(source),
});
const path = (s: string): FilePath => s as FilePath;

describe('matchInStack', () => {
  it('Given an empty stack, When matched, Then returns "unset"', () => {
    expect(matchInStack([], path('foo.log'), false)).toBe('unset');
  });

  it('Given a single root level with `*.log`, When matched against `foo.log`, Then returns "ignored"', () => {
    const stack = [level('', '*.log')];

    expect(matchInStack(stack, path('foo.log'), false)).toBe('ignored');
  });

  it('Given two root levels where the later level negates an earlier ignore, When matched, Then returns "unignored"', () => {
    // Arrange — global excludes `*.log`; repo-root `.gitignore` re-includes `keep.log`.
    const stack = [level('', '*.log'), level('', '!keep.log')];

    // Act
    const sut = matchInStack(stack, path('keep.log'), false);

    // Assert
    expect(sut).toBe('unignored');
  });

  it('Given a level at basedir "sub", When matched against `sub/foo.log`, Then the rule applies', () => {
    // Arrange — rule is `*.log` relative to `sub/`.
    const stack = [level('sub', '*.log')];

    // Act
    const sut = matchInStack(stack, path('sub/foo.log'), false);

    // Assert — the matcher relativizes the path before evaluating.
    expect(sut).toBe('ignored');
  });

  it('Given a level at basedir "sub", When matched against `other/foo.log`, Then the rule does NOT apply', () => {
    // Arrange
    const stack = [level('sub', '*.log')];

    // Act
    const sut = matchInStack(stack, path('other/foo.log'), false);

    // Assert
    expect(sut).toBe('unset');
  });

  it('Given a root ignore + a nested negation, When matched against the nested path, Then the negation wins', () => {
    // Arrange
    const stack = [level('', '*.log'), level('sub', '!keep.log')];

    // Act
    const sut = matchInStack(stack, path('sub/keep.log'), false);

    // Assert
    expect(sut).toBe('unignored');
  });

  it('Given a root ignore + a nested negation, When matched against a sibling outside the nested basedir, Then the root rule still wins', () => {
    // Arrange
    const stack = [level('', '*.log'), level('sub', '!keep.log')];

    // Act
    const sut = matchInStack(stack, path('other/keep.log'), false);

    // Assert
    expect(sut).toBe('ignored');
  });

  it('Given a directory-only rule and a non-directory path, When matched, Then returns "unset"', () => {
    // Arrange
    const stack = [level('', 'build/')];

    // Act
    const sut = matchInStack(stack, path('build'), false);

    // Assert — `build/` only applies when `isDir` is true.
    expect(sut).toBe('unset');
  });

  it('Given a directory-only rule and a matching directory path, When matched, Then returns "ignored"', () => {
    const stack = [level('', 'build/')];

    expect(matchInStack(stack, path('build'), true)).toBe('ignored');
  });
});
