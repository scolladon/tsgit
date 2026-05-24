import { describe, expect, it } from 'vitest';

import { matches } from '../../../../src/domain/ignore/match.js';
import { parseGitignore } from '../../../../src/domain/ignore/parse-gitignore.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';

const path = (s: string): FilePath => s as FilePath;

describe('matches', () => {
  describe('Given an empty ruleset', () => {
    describe('When matches anything', () => {
      it('Then returns "unset"', () => {
        // Arrange
        const rules = parseGitignore('');

        // Act
        const sut = matches(rules, path('foo.ts'), false);

        // Assert
        expect(sut).toBe('unset');
      });
    });
  });

  describe('Given ruleset=[*.log] and path "foo.log"', () => {
    describe('When matches', () => {
      it('Then returns "ignored"', () => {
        // Arrange
        const rules = parseGitignore('*.log');

        // Act
        const sut = matches(rules, path('foo.log'), false);

        // Assert
        expect(sut).toBe('ignored');
      });
    });
  });

  describe('Given ruleset=[*.log, !important.log] and path "important.log"', () => {
    describe('When matches', () => {
      it('Then "unignored" (last-match wins)', () => {
        // Arrange
        const rules = parseGitignore('*.log\n!important.log');

        // Act
        const sut = matches(rules, path('important.log'), false);

        // Assert
        expect(sut).toBe('unignored');
      });
    });
  });

  describe('Given ruleset=[build/] and path "build" with isDir=true', () => {
    describe('When matches', () => {
      it('Then "ignored"', () => {
        // Arrange
        const rules = parseGitignore('build/');

        // Act
        const sut = matches(rules, path('build'), true);

        // Assert
        expect(sut).toBe('ignored');
      });
    });
  });

  describe('Given ruleset=[build/] and path "build" with isDir=false', () => {
    describe('When matches', () => {
      it('Then "unset" (directory-only)', () => {
        // Arrange
        const rules = parseGitignore('build/');

        // Act
        const sut = matches(rules, path('build'), false);

        // Assert
        expect(sut).toBe('unset');
      });
    });
  });

  describe('Given ruleset=[/dist] and path "dist"', () => {
    describe('When matches', () => {
      it('Then "ignored" (anchored matches root)', () => {
        // Arrange
        const rules = parseGitignore('/dist');

        // Act
        const sut = matches(rules, path('dist'), true);

        // Assert
        expect(sut).toBe('ignored');
      });
    });
  });

  describe('Given ruleset=[/dist] and path "src/dist"', () => {
    describe('When matches', () => {
      it('Then "unset" (anchored does NOT match nested)', () => {
        // Arrange
        const rules = parseGitignore('/dist');

        // Act
        const sut = matches(rules, path('src/dist'), true);

        // Assert
        expect(sut).toBe('unset');
      });
    });
  });

  describe('Given ruleset=[**/node_modules] and path "a/b/node_modules"', () => {
    describe('When matches', () => {
      it('Then "ignored"', () => {
        // Arrange
        const rules = parseGitignore('**/node_modules');

        // Act
        const sut = matches(rules, path('a/b/node_modules'), true);

        // Assert
        expect(sut).toBe('ignored');
      });
    });
  });

  describe('Given a non-matching pattern', () => {
    describe('When matches', () => {
      it('Then "unset"', () => {
        // Arrange
        const rules = parseGitignore('*.log');

        // Act
        const sut = matches(rules, path('foo.txt'), false);

        // Assert
        expect(sut).toBe('unset');
      });
    });
  });
});
