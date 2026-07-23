import { describe, expect, it } from 'vitest';
import {
  type IgnoreLevel,
  matchInStack,
  matchInStackVerbose,
} from '../../../../src/domain/ignore/matcher-stack.js';
import { parseGitignore } from '../../../../src/domain/ignore/parse-gitignore.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';

const level = (basedir: '' | string, source: string): IgnoreLevel => ({
  basedir: basedir as IgnoreLevel['basedir'],
  rules: parseGitignore(source),
});
const path = (s: string): FilePath => s as FilePath;

describe('matchInStack', () => {
  describe('Given a stack of ignore levels, a path, and an isDir flag', () => {
    describe('When matched', () => {
      // The "no level matches" rows kill initialiser mutants: a mutant
      // changing the initial `result = "unset"` to `"ignored"` would survive
      // single-level tests because every level could return "unset" without
      // changing the result.
      it.each([
        {
          stack: [],
          filePath: 'foo.log',
          isDir: false,
          expected: 'unset',
          label: 'an empty stack returns "unset"',
        },
        {
          stack: [level('', '*.tmp'), level('sub', '*.cache')],
          filePath: 'keep.ts',
          isDir: false,
          expected: 'unset',
          label:
            'a multi-level stack where no level matches returns "unset" (kills initialiser mutants)',
        },
        {
          stack: [level('', '*.log')],
          filePath: 'foo.log',
          isDir: false,
          expected: 'ignored',
          label: 'a single root level with a matching rule returns "ignored"',
        },
        {
          // Global excludes `*.log`; repo-root `.gitignore` re-includes `keep.log`.
          stack: [level('', '*.log'), level('', '!keep.log')],
          filePath: 'keep.log',
          isDir: false,
          expected: 'unignored',
          label: 'a later root level negating an earlier ignore returns "unignored"',
        },
        {
          // The matcher relativizes the path before evaluating.
          stack: [level('sub', '*.log')],
          filePath: 'sub/foo.log',
          isDir: false,
          expected: 'ignored',
          label: 'a level at basedir "sub" applies to a path under that basedir',
        },
        {
          stack: [level('sub', '*.log')],
          filePath: 'other/foo.log',
          isDir: false,
          expected: 'unset',
          label: 'a level at basedir "sub" does NOT apply outside that basedir',
        },
        {
          stack: [level('', '*.log'), level('sub', '!keep.log')],
          filePath: 'sub/keep.log',
          isDir: false,
          expected: 'unignored',
          label: 'a nested negation wins over a root ignore for the nested path',
        },
        {
          stack: [level('', '*.log'), level('sub', '!keep.log')],
          filePath: 'other/keep.log',
          isDir: false,
          expected: 'ignored',
          label: 'the root rule still wins for a sibling outside the nested basedir',
        },
        {
          // `build/` only applies when `isDir` is true.
          stack: [level('', 'build/')],
          filePath: 'build',
          isDir: false,
          expected: 'unset',
          label: 'a directory-only rule does NOT apply to a non-directory path',
        },
        {
          stack: [level('', 'build/')],
          filePath: 'build',
          isDir: true,
          expected: 'ignored',
          label: 'a directory-only rule applies to a matching directory path',
        },
      ])('Then $label', ({ stack, filePath, isDir, expected }) => {
        // Arrange + Act
        const sut = matchInStack(stack, path(filePath), isDir);

        // Assert
        expect(sut).toBe(expected);
      });
    });
  });
});

describe('matchInStackVerbose', () => {
  describe('Given a stack of ignore levels, a path, and an isDir flag', () => {
    describe('When matched', () => {
      const rootLevel = level('', '*.log');
      const globalLevel = level('', '*.log');
      const repoLevel = level('', '!keep.log');
      const nestedLevel = level('sub', '*.log');

      // Non-matching rows assert both `level` and `ruleIndex` stay undefined
      // (kills initialiser mutants that would otherwise survive).
      it.each([
        {
          stack: [],
          filePath: 'foo.log',
          isDir: false,
          verdict: 'unset',
          expectedLevel: undefined,
          ruleIndex: undefined,
          label: 'an empty stack yields "unset" with no level or ruleIndex',
        },
        {
          stack: [rootLevel],
          filePath: 'foo.log',
          isDir: false,
          verdict: 'ignored',
          expectedLevel: rootLevel,
          ruleIndex: 0,
          label: 'a single root level yields "ignored" with level + ruleIndex 0',
        },
        {
          // Global excludes `*.log`; repo-root `.gitignore` re-includes `keep.log`.
          stack: [globalLevel, repoLevel],
          filePath: 'keep.log',
          isDir: false,
          verdict: 'unignored',
          expectedLevel: repoLevel,
          ruleIndex: 0,
          label:
            'a later level negating an earlier ignore yields "unignored" with the later level + ruleIndex 0',
        },
        {
          stack: [nestedLevel],
          filePath: 'sub/foo.log',
          isDir: false,
          verdict: 'ignored',
          expectedLevel: nestedLevel,
          ruleIndex: 0,
          label: 'a level at basedir "sub" applies and `level` is the nested level',
        },
        {
          stack: [nestedLevel],
          filePath: 'other/foo.log',
          isDir: false,
          verdict: 'unset',
          expectedLevel: undefined,
          ruleIndex: undefined,
          label: 'a level at basedir "sub" does NOT apply outside that basedir',
        },
        {
          stack: [level('', '*.tmp'), level('sub', '*.cache')],
          filePath: 'keep.ts',
          isDir: false,
          verdict: 'unset',
          expectedLevel: undefined,
          ruleIndex: undefined,
          label:
            'a multi-level stack where no level matches is fully empty (kills initialiser mutants)',
        },
      ])('Then $label', ({ stack, filePath, isDir, verdict, expectedLevel, ruleIndex }) => {
        // Arrange + Act
        const sut = matchInStackVerbose(stack, path(filePath), isDir);

        // Assert
        expect(sut.verdict).toBe(verdict);
        expect(sut.level).toBe(expectedLevel);
        expect(sut.ruleIndex).toBe(ruleIndex);
      });
    });
  });

  describe('Given a level kind tag', () => {
    describe('When passed to IgnoreLevel', () => {
      it('Then the kind round-trips through the verbose match', () => {
        // Arrange — an `info` excludes file shape: same basedir as global / repo
        // but distinguishable by the kind tag.
        const info: IgnoreLevel = {
          basedir: '',
          rules: parseGitignore('secret.txt'),
          kind: 'info',
        };

        // Act
        const sut = matchInStackVerbose([info], path('secret.txt'), false);

        // Assert
        expect(sut.verdict).toBe('ignored');
        expect(sut.level?.kind).toBe('info');
      });
    });
  });
});
