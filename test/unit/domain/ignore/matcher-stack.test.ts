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
  describe('Given an empty stack', () => {
    describe('When matched', () => {
      it('Then returns "unset"', () => {
        // Arrange
        const sut = matchInStack([], path('foo.log'), false);

        // Assert
        expect(sut).toBe('unset');
      });
    });
  });

  describe('Given a multi-level stack where NO level matches', () => {
    describe('When matched', () => {
      it('Then returns "unset" (kills initialiser mutants)', () => {
        // Arrange — two levels, each with a rule that does NOT match the
        // query path. A mutant changing the initial `result = "unset"` to
        // `"ignored"` would survive single-level tests because every level
        // could return "unset" without changing the result.
        const stack = [level('', '*.tmp'), level('sub', '*.cache')];

        // Act
        const sut = matchInStack(stack, path('keep.ts'), false);

        // Assert
        expect(sut).toBe('unset');
      });
    });
  });

  describe('Given a single root level with `*.log`', () => {
    describe('When matched against `foo.log`', () => {
      it('Then returns "ignored"', () => {
        // Arrange
        const stack = [level('', '*.log')];

        // Assert
        expect(matchInStack(stack, path('foo.log'), false)).toBe('ignored');
      });
    });
  });

  describe('Given two root levels where the later level negates an earlier ignore', () => {
    describe('When matched', () => {
      it('Then returns "unignored"', () => {
        // Arrange — global excludes `*.log`; repo-root `.gitignore` re-includes `keep.log`.
        const stack = [level('', '*.log'), level('', '!keep.log')];

        // Act
        const sut = matchInStack(stack, path('keep.log'), false);

        // Assert
        expect(sut).toBe('unignored');
      });
    });
  });

  describe('Given a level at basedir "sub"', () => {
    describe('When matched against `sub/foo.log`', () => {
      it('Then the rule applies', () => {
        // Arrange — rule is `*.log` relative to `sub/`.
        const stack = [level('sub', '*.log')];

        // Act
        const sut = matchInStack(stack, path('sub/foo.log'), false);

        // Assert — the matcher relativizes the path before evaluating.
        expect(sut).toBe('ignored');
      });
    });
    describe('When matched against `other/foo.log`', () => {
      it('Then the rule does NOT apply', () => {
        // Arrange
        const stack = [level('sub', '*.log')];

        // Act
        const sut = matchInStack(stack, path('other/foo.log'), false);

        // Assert
        expect(sut).toBe('unset');
      });
    });
  });

  describe('Given a root ignore + a nested negation', () => {
    describe('When matched against the nested path', () => {
      it('Then the negation wins', () => {
        // Arrange
        const stack = [level('', '*.log'), level('sub', '!keep.log')];

        // Act
        const sut = matchInStack(stack, path('sub/keep.log'), false);

        // Assert
        expect(sut).toBe('unignored');
      });
    });
    describe('When matched against a sibling outside the nested basedir', () => {
      it('Then the root rule still wins', () => {
        // Arrange
        const stack = [level('', '*.log'), level('sub', '!keep.log')];

        // Act
        const sut = matchInStack(stack, path('other/keep.log'), false);

        // Assert
        expect(sut).toBe('ignored');
      });
    });
  });

  describe('Given a directory-only rule and a non-directory path', () => {
    describe('When matched', () => {
      it('Then returns "unset"', () => {
        // Arrange
        const stack = [level('', 'build/')];

        // Act
        const sut = matchInStack(stack, path('build'), false);

        // Assert — `build/` only applies when `isDir` is true.
        expect(sut).toBe('unset');
      });
    });
  });

  describe('Given a directory-only rule and a matching directory path', () => {
    describe('When matched', () => {
      it('Then returns "ignored"', () => {
        // Arrange
        const stack = [level('', 'build/')];

        // Assert
        expect(matchInStack(stack, path('build'), true)).toBe('ignored');
      });
    });
  });
});

describe('matchInStackVerbose', () => {
  describe('Given an empty stack', () => {
    describe('When called', () => {
      it('Then verdict is "unset" with no level or ruleIndex', () => {
        // Arrange — empty stack: no rule can fire.

        // Act
        const sut = matchInStackVerbose([], path('foo.log'), false);

        // Assert
        expect(sut.verdict).toBe('unset');
        expect(sut.level).toBeUndefined();
        expect(sut.ruleIndex).toBeUndefined();
      });
    });
  });

  describe('Given a single root level with `*.log`', () => {
    describe('When matched against `foo.log`', () => {
      it('Then verdict is "ignored" with level + ruleIndex 0', () => {
        // Arrange
        const root = level('', '*.log');
        const stack = [root];

        // Act
        const sut = matchInStackVerbose(stack, path('foo.log'), false);

        // Assert
        expect(sut.verdict).toBe('ignored');
        expect(sut.level).toBe(root);
        expect(sut.ruleIndex).toBe(0);
      });
    });
  });

  describe('Given two root levels where the later level negates an earlier ignore', () => {
    describe('When matched', () => {
      it('Then verdict "unignored" with the later level + ruleIndex 0', () => {
        // Arrange — global excludes `*.log`; repo-root `.gitignore` re-includes `keep.log`.
        const globalLevel = level('', '*.log');
        const repoLevel = level('', '!keep.log');
        const stack = [globalLevel, repoLevel];

        // Act
        const sut = matchInStackVerbose(stack, path('keep.log'), false);

        // Assert
        expect(sut.verdict).toBe('unignored');
        expect(sut.level).toBe(repoLevel);
        expect(sut.ruleIndex).toBe(0);
      });
    });
  });

  describe('Given a level at basedir "sub"', () => {
    describe('When matched against `sub/foo.log`', () => {
      it('Then the rule applies and `level` is the nested level', () => {
        // Arrange — rule is `*.log` relative to `sub/`.
        const nested = level('sub', '*.log');
        const stack = [nested];

        // Act
        const sut = matchInStackVerbose(stack, path('sub/foo.log'), false);

        // Assert
        expect(sut.verdict).toBe('ignored');
        expect(sut.level).toBe(nested);
        expect(sut.ruleIndex).toBe(0);
      });
    });
    describe('When matched against `other/foo.log`', () => {
      it('Then the rule does NOT apply and the result is "unset"', () => {
        // Arrange
        const nested = level('sub', '*.log');
        const stack = [nested];

        // Act
        const sut = matchInStackVerbose(stack, path('other/foo.log'), false);

        // Assert
        expect(sut.verdict).toBe('unset');
        expect(sut.level).toBeUndefined();
        expect(sut.ruleIndex).toBeUndefined();
      });
    });
  });

  describe('Given a multi-level stack where NO level matches', () => {
    describe('When called', () => {
      it('Then result is fully empty (kills initialiser mutants)', () => {
        // Arrange — two non-matching levels; both `level` and `ruleIndex`
        // must remain undefined.
        const stack = [level('', '*.tmp'), level('sub', '*.cache')];

        // Act
        const sut = matchInStackVerbose(stack, path('keep.ts'), false);

        // Assert
        expect(sut.verdict).toBe('unset');
        expect(sut.level).toBeUndefined();
        expect(sut.ruleIndex).toBeUndefined();
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
