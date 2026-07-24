import { describe, expect, it } from 'vitest';

import { matches, matchesVerbose } from '../../../../src/domain/ignore/match.js';
import { parseGitignore } from '../../../../src/domain/ignore/parse-gitignore.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';

const path = (s: string): FilePath => s as FilePath;

describe('matches', () => {
  describe('Given a compiled ruleset, a path, and an isDir flag', () => {
    describe('When matched', () => {
      it.each([
        {
          pattern: '',
          filePath: 'foo.ts',
          isDir: false,
          expected: 'unset',
          label: 'an empty ruleset returns "unset"',
        },
        {
          pattern: '*.log',
          filePath: 'foo.log',
          isDir: false,
          expected: 'ignored',
          label: 'a matching pattern returns "ignored"',
        },
        {
          pattern: '*.log\n!important.log',
          filePath: 'important.log',
          isDir: false,
          expected: 'unignored',
          label: 'a negated re-include returns "unignored" (last-match wins)',
        },
        {
          pattern: 'build/',
          filePath: 'build',
          isDir: true,
          expected: 'ignored',
          label: 'a directory pattern matches a directory',
        },
        {
          pattern: 'build/',
          filePath: 'build',
          isDir: false,
          expected: 'unset',
          label: 'a directory pattern does not match a non-directory (directory-only)',
        },
        {
          pattern: '/dist',
          filePath: 'dist',
          isDir: true,
          expected: 'ignored',
          label: 'an anchored pattern matches the root',
        },
        {
          pattern: '/dist',
          filePath: 'src/dist',
          isDir: true,
          expected: 'unset',
          label: 'an anchored pattern does NOT match a nested path',
        },
        {
          pattern: '**/node_modules',
          filePath: 'a/b/node_modules',
          isDir: true,
          expected: 'ignored',
          label: 'a globstar pattern matches at depth',
        },
        {
          pattern: '*.log',
          filePath: 'foo.txt',
          isDir: false,
          expected: 'unset',
          label: 'a non-matching pattern returns "unset"',
        },
      ])('Then $label', ({ pattern, filePath, isDir, expected }) => {
        // Arrange
        const rules = parseGitignore(pattern);

        // Act
        const sut = matches(rules, path(filePath), isDir);

        // Assert
        expect(sut).toBe(expected);
      });
    });
  });
});

describe('matchesVerbose', () => {
  describe('Given a compiled ruleset, a path, and an isDir flag', () => {
    describe('When matched', () => {
      // ruleIndex is asserted alongside verdict on every row so a mutant that
      // returns a stale/skipped `ruleIndex` is killed — see the directory-only
      // row, where the rule is skipped for a non-directory path.
      it.each([
        {
          pattern: '',
          filePath: 'foo.ts',
          isDir: false,
          verdict: 'unset',
          ruleIndex: undefined,
          label: 'an empty ruleset yields "unset" with no ruleIndex',
        },
        {
          pattern: '*.log',
          filePath: 'foo.log',
          isDir: false,
          verdict: 'ignored',
          ruleIndex: 0,
          label: 'a single ignoring rule yields "ignored" with ruleIndex 0',
        },
        {
          pattern: '*.log\n!keep.log',
          filePath: 'keep.log',
          isDir: false,
          verdict: 'unignored',
          ruleIndex: 1,
          label: 'a negated re-include yields "unignored" with ruleIndex 1 (last match wins)',
        },
        {
          pattern: 'build/',
          filePath: 'build',
          isDir: false,
          verdict: 'unset',
          ruleIndex: undefined,
          label: 'a directory-only rule skipped for a non-directory path yields "unset"',
        },
        {
          pattern: '*.log',
          filePath: 'foo.txt',
          isDir: false,
          verdict: 'unset',
          ruleIndex: undefined,
          label: 'a non-matching pattern yields "unset" with no ruleIndex',
        },
        {
          pattern: '*.log\nfoo.log',
          filePath: 'foo.log',
          isDir: false,
          verdict: 'ignored',
          ruleIndex: 1,
          label: 'two matching rules carries the LAST matching ruleIndex',
        },
      ])('Then $label', ({ pattern, filePath, isDir, verdict, ruleIndex }) => {
        // Arrange
        const rules = parseGitignore(pattern);

        // Act
        const sut = matchesVerbose(rules, path(filePath), isDir);

        // Assert
        expect(sut.verdict).toBe(verdict);
        expect(sut.ruleIndex).toBe(ruleIndex);
      });
    });
  });
});
