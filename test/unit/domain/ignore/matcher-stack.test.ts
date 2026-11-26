import { describe, expect, it } from 'vitest';
import {
  chainExclusion,
  directoryExclusion,
  type IgnoreLevel,
  matchBeneathChain,
  matchInStack,
  matchInStackVerbose,
  parentDirectoryOf,
} from '../../../../src/domain/ignore/matcher-stack.js';
import { parseGitignore } from '../../../../src/domain/ignore/parse-gitignore.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import { chainOver } from './arbitraries.js';

const level = (basedir: '' | string, source: string): IgnoreLevel => ({
  basedir: basedir as IgnoreLevel['basedir'],
  rules: parseGitignore(source),
});
const foldedLevel = (basedir: '' | string, source: string): IgnoreLevel => ({
  basedir: basedir as IgnoreLevel['basedir'],
  rules: parseGitignore(source, { caseFold: true }),
});
const kindLevel = (kind: NonNullable<IgnoreLevel['kind']>, source: string): IgnoreLevel => ({
  basedir: '',
  rules: parseGitignore(source),
  kind,
});
const path = (s: string): FilePath => s as FilePath;
/** What a verbose match reports of its deciding rule when nothing matched. */
const UNSET_FIELDS = {
  kind: undefined,
  basedir: undefined,
  line: undefined,
  pattern: undefined,
};

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
        const result = matchInStack(stack, path(filePath), isDir);

        // Assert
        expect(result).toBe(expected);
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
        const result = matchInStackVerbose(stack, path(filePath), isDir);

        // Assert
        expect(result.verdict).toBe(verdict);
        expect(result.level).toBe(expectedLevel);
        expect(result.ruleIndex).toBe(ruleIndex);
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
        const result = matchInStackVerbose([info], path('secret.txt'), false);

        // Assert
        expect(result.verdict).toBe('ignored');
        expect(result.level?.kind).toBe('info');
      });
    });
  });

  describe('Given the empty path, which is beneath no rule file', () => {
    const decidingRule = (stack: ReadonlyArray<IgnoreLevel>, isDir: boolean) => {
      const sut = matchInStackVerbose;
      const result = sut(stack, path(''), isDir);
      const rule = result.level?.rules[result.ruleIndex ?? Number.NaN];
      return {
        verdict: result.verdict,
        kind: result.level?.kind,
        basedir: result.level?.basedir,
        line: rule?.lineNumber,
        pattern: rule?.pattern,
      };
    };
    const UNSET = { verdict: 'unset' };

    describe.each([
      {
        label: 'a rule holding a slash does not match it',
        stack: [kindLevel('gitignore', '/*\n')],
        expected: UNSET,
      },
      {
        label: 'a directory-only rule holding a slash does not match it',
        stack: [kindLevel('gitignore', '/*/\n')],
        expected: UNSET,
      },
      {
        label: 'a directory-only rule without a slash does not match it',
        stack: [kindLevel('gitignore', '*/\n')],
        expected: UNSET,
      },
      {
        label: 'a directory-only double-star rule does not match it',
        stack: [kindLevel('gitignore', '**/\n')],
        expected: UNSET,
      },
      {
        label: 'a later directory-only rule does not override a basename rule',
        stack: [kindLevel('gitignore', '*\n!*/\n')],
        expected: { verdict: 'ignored', kind: 'gitignore', basedir: '', line: 1, pattern: '*' },
      },
      {
        label: 'a rule matched by basename matches it',
        stack: [kindLevel('gitignore', '*\n')],
        expected: { verdict: 'ignored', kind: 'gitignore', basedir: '', line: 1, pattern: '*' },
      },
      {
        label: 'a later rule holding a slash does not override a basename rule',
        stack: [kindLevel('gitignore', '*\n/*\n')],
        expected: { verdict: 'ignored', kind: 'gitignore', basedir: '', line: 1, pattern: '*' },
      },
      {
        label: 'a later negation holding a slash does not re-include it',
        stack: [kindLevel('gitignore', '*\n!/*\n')],
        expected: { verdict: 'ignored', kind: 'gitignore', basedir: '', line: 1, pattern: '*' },
      },
      {
        label: 'the deciding rule keeps its own line after a rule holding a slash',
        stack: [kindLevel('info', '/x\n*\n')],
        expected: { verdict: 'ignored', kind: 'info', basedir: '', line: 2, pattern: '*' },
      },
      {
        label: 'a later level decides over an earlier one',
        stack: [kindLevel('global', '*\n'), kindLevel('gitignore', '/*\n!*\n')],
        expected: { verdict: 'unignored', kind: 'gitignore', basedir: '', line: 2, pattern: '!*' },
      },
    ])('When matched against $stack.length level(s)', ({ label, stack, expected }) => {
      it(`Then ${label}`, () => {
        // Arrange
        const sut = decidingRule;

        // Act
        const result = sut(stack, true);

        // Assert
        expect(result).toEqual({ ...UNSET_FIELDS, ...expected });
      });
    });

    describe('When matched through the plain verdict', () => {
      it('Then a rule holding a slash leaves it unset', () => {
        // Arrange
        const sut = matchInStack;

        // Act
        const result = sut([level('', '/*\n')], path(''), true);

        // Assert
        expect(result).toBe('unset');
      });
    });
  });

  describe('Given a path ending at the directory of a nested rule file', () => {
    describe('When matched', () => {
      it('Then a rule holding a slash in that file still matches it', () => {
        // Arrange
        const nested = level('a', '/*\n');
        const sut = matchInStackVerbose;

        // Act
        const result = sut([nested], path('a/'), true);

        // Assert
        expect(result).toEqual({ verdict: 'ignored', level: nested, ruleIndex: 0 });
      });
    });
  });
});

describe('parentDirectoryOf', () => {
  describe.each([
    { filePath: 'a', expected: '' },
    { filePath: 'a/b', expected: 'a' },
    { filePath: 'a/b/c', expected: 'a/b' },
  ])('Given the path $filePath', ({ filePath, expected }) => {
    describe('When its parent directory is asked', () => {
      it('Then it is the path without its last segment, empty at the root', () => {
        // Arrange
        const sut = parentDirectoryOf;

        // Act
        const result = sut(path(filePath));

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('directoryExclusion', () => {
  describe('Given a root level excluding a directory', () => {
    describe('When the directory is tested', () => {
      it('Then it returns the excluding match with its level and rule index', () => {
        // Arrange
        const sut = directoryExclusion;
        const stack = [level('', 'ab/')];

        // Act
        const result = sut(stack, path('ab'));

        // Assert
        expect(result?.verdict).toBe('ignored');
        expect(result?.level).toBe(stack[0]);
        expect(result?.ruleIndex).toBe(0);
      });
    });
  });

  describe('Given a root level excluding a directory then re-including it', () => {
    describe('When the directory is tested', () => {
      it('Then a negation as the last match is no exclusion', () => {
        // Arrange
        const sut = directoryExclusion;
        const stack = [level('', 'ab/\n!ab/')];

        // Act
        const result = sut(stack, path('ab'));

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a root level excluding a/b and a nested level re-including b', () => {
    describe('When a/b is tested', () => {
      it('Then the deeper negation leaves it not excluded', () => {
        // Arrange
        const sut = directoryExclusion;
        const stack = [level('', 'a/b/'), level('a', '!b/')];

        // Act
        const result = sut(stack, path('a/b'));

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a directory-only rule and a path without a trailing slash', () => {
    describe('When the directory is tested', () => {
      it('Then it is tested as a directory and excluded', () => {
        // Arrange
        const sut = directoryExclusion;
        const stack = [level('', 'ab/')];

        // Act
        const result = sut(stack, path('ab'));

        // Assert
        expect(result).toBeDefined();
      });
    });
  });

  describe('Given a single level anchored at the tested directory itself', () => {
    describe('When the directory is tested', () => {
      it('Then the level never applies', () => {
        // Arrange
        const sut = directoryExclusion;
        const stack = [level('ab', '*')];

        // Act
        const result = sut(stack, path('ab'));

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});

describe('chainExclusion', () => {
  describe('Given an excluded chain above and a directory no rule excludes', () => {
    describe('When the chain is extended by the directory', () => {
      it('Then the chain above is kept by identity', () => {
        // Arrange
        const sut = chainExclusion;
        const root = level('', 'zz/');
        const stack = [root];
        const above = { verdict: 'ignored', level: root, ruleIndex: 0 } as const;

        // Act
        const result = sut(stack, path('ab'), above);

        // Assert
        expect(result).toBe(above);
      });
    });
  });

  describe('Given an excluded chain above and a directory another rule excludes', () => {
    describe('When the chain is extended by the directory', () => {
      it('Then the first exclusion wins by identity', () => {
        // Arrange
        const sut = chainExclusion;
        const root = level('', 'zz/\nab/');
        const stack = [root];
        const above = { verdict: 'ignored', level: root, ruleIndex: 0 } as const;

        // Act
        const result = sut(stack, path('ab'), above);

        // Assert
        expect(result).toBe(above);
      });
    });
  });

  describe('Given no chain above and a root level excluding the directory', () => {
    describe('When the chain is extended by the directory', () => {
      it('Then the directory exclusion starts the chain', () => {
        // Arrange
        const sut = chainExclusion;
        const stack = [level('', 'ab/')];

        // Act
        const result = sut(stack, path('ab'), undefined);

        // Assert
        expect(result?.verdict).toBe('ignored');
        expect(result?.level).toBe(stack[0]);
        expect(result?.ruleIndex).toBe(0);
      });
    });
  });

  describe('Given no chain above and a root level excluding then re-including the directory', () => {
    describe('When the chain is extended by the directory', () => {
      it('Then the chain stays open', () => {
        // Arrange
        const sut = chainExclusion;
        const stack = [level('', 'ab/\n!ab/')];

        // Act
        const result = sut(stack, path('ab'), undefined);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});

describe('matchBeneathChain', () => {
  describe('Given an excluded chain and a negation beneath it', () => {
    describe('When a path beneath the chain is matched', () => {
      it('Then the chain decides by identity', () => {
        // Arrange
        const sut = matchBeneathChain;
        const root = level('', 'ab/\n!ab/c');
        const stack = [root];
        const chain = { verdict: 'ignored', level: root, ruleIndex: 0 } as const;

        // Act
        const result = sut(stack, path('ab/c'), false, chain);

        // Assert
        expect(result).toBe(chain);
      });
    });
  });

  describe('Given no chain and a root rule matching the file', () => {
    describe('When the path is matched', () => {
      it('Then the full path is ignored by that rule', () => {
        // Arrange
        const sut = matchBeneathChain;
        const stack = [level('', '*.log')];

        // Act
        const result = sut(stack, path('x.log'), false, undefined);

        // Assert
        expect(result.verdict).toBe('ignored');
        expect(result.level).toBe(stack[0]);
        expect(result.ruleIndex).toBe(0);
      });
    });
  });

  describe('Given no chain and a negation re-including a file', () => {
    describe('When the path is matched', () => {
      it('Then the file is unignored by the negation', () => {
        // Arrange
        const sut = matchBeneathChain;
        const stack = [level('', 'ab/*\n!ab/c')];

        // Act
        const result = sut(stack, path('ab/c'), false, undefined);

        // Assert
        expect(result.verdict).toBe('unignored');
        expect(result.ruleIndex).toBe(1);
      });
    });
  });

  describe('Given no chain and no rule', () => {
    describe('When the path is matched', () => {
      it('Then the verdict is unset', () => {
        // Arrange
        const sut = matchBeneathChain;

        // Act
        const result = sut([], path('ab/c'), false, undefined);

        // Assert
        expect(result.verdict).toBe('unset');
      });
    });
  });
});

describe('matchBeneathChain over the chain of a loaded stack', () => {
  const ROOT = 0;
  const SECOND = 1;
  const rootOnly = (source: string): ReadonlyArray<IgnoreLevel> => [level('', source)];
  const rows: ReadonlyArray<{
    label: string;
    stack: ReadonlyArray<IgnoreLevel>;
    query: string;
    isDir: boolean;
    verdict: 'ignored' | 'unignored' | 'unset';
    levelIndex?: number;
    ruleIndex?: number;
  }> = [
    {
      label: 'a rule naming the directory without a slash',
      stack: rootOnly('ab'),
      query: 'ab/c',
      isDir: false,
      verdict: 'ignored',
      levelIndex: ROOT,
      ruleIndex: 0,
    },
    {
      label: 'a later negation cannot re-include',
      stack: rootOnly('ab/\n!ab/c'),
      query: 'ab/c',
      isDir: false,
      verdict: 'ignored',
      levelIndex: ROOT,
      ruleIndex: 0,
    },
    {
      label: 'a deep file beneath an excluded directory',
      stack: rootOnly('x/y/'),
      query: 'x/y/z/w',
      isDir: false,
      verdict: 'ignored',
      levelIndex: ROOT,
      ruleIndex: 0,
    },
    {
      label: 'a file directly beneath an excluded directory',
      stack: rootOnly('x/y/'),
      query: 'x/y/z',
      isDir: false,
      verdict: 'ignored',
      levelIndex: ROOT,
      ruleIndex: 0,
    },
    {
      label: 'a sibling of an excluded directory',
      stack: rootOnly('x/y/'),
      query: 'x/q',
      isDir: false,
      verdict: 'unset',
    },
    {
      label: 'the first excluded directory decides',
      stack: rootOnly('x/y/\nx/y/z/'),
      query: 'x/y/z/w',
      isDir: false,
      verdict: 'ignored',
      levelIndex: ROOT,
      ruleIndex: 0,
    },
    {
      label: 'a re-included directory is not excluded',
      stack: rootOnly('ab/\n!ab/'),
      query: 'ab/c',
      isDir: false,
      verdict: 'unset',
    },
    {
      label: 'a negative leading test falls through to the full path',
      stack: rootOnly('*\n!ab/'),
      query: 'ab/c',
      isDir: false,
      verdict: 'ignored',
      levelIndex: ROOT,
      ruleIndex: 0,
    },
    {
      label: 'a leading rule precedes a later file rule',
      stack: rootOnly('ab\n*.log'),
      query: 'ab/x.log',
      isDir: false,
      verdict: 'ignored',
      levelIndex: ROOT,
      ruleIndex: 0,
    },
    {
      label: 'a nested level excluding a directory',
      stack: [level('a', 'b/')],
      query: 'a/b/c',
      isDir: false,
      verdict: 'ignored',
      levelIndex: ROOT,
      ruleIndex: 0,
    },
    {
      label: 'a nested negation cannot re-include under an excluded ancestor',
      stack: [level('', 'a/'), level('a', '!b/\n!b/c')],
      query: 'a/b/c',
      isDir: false,
      verdict: 'ignored',
      levelIndex: ROOT,
      ruleIndex: 0,
    },
    {
      label: 'a recursive directory rule',
      stack: rootOnly('**/build/'),
      query: 'p/build/o/f',
      isDir: false,
      verdict: 'ignored',
      levelIndex: ROOT,
      ruleIndex: 0,
    },
    {
      label: 'a negation of a file under a non-excluded directory',
      stack: rootOnly('ab/*\n!ab/c'),
      query: 'ab/c',
      isDir: false,
      verdict: 'unignored',
      levelIndex: ROOT,
      ruleIndex: SECOND,
    },
    {
      label: 'a sibling of a re-included file',
      stack: rootOnly('ab/*\n!ab/c'),
      query: 'ab/d',
      isDir: false,
      verdict: 'ignored',
      levelIndex: ROOT,
      ruleIndex: 0,
    },
    {
      label: 'an info exclude level',
      stack: [kindLevel('info', 'ab/')],
      query: 'ab/c',
      isDir: false,
      verdict: 'ignored',
      levelIndex: ROOT,
      ruleIndex: 0,
    },
    {
      label: 'a global excludes level',
      stack: [kindLevel('global', 'ab/')],
      query: 'ab/c',
      isDir: false,
      verdict: 'ignored',
      levelIndex: ROOT,
      ruleIndex: 0,
    },
    {
      label: 'a case-folded rule against a differently cased directory',
      stack: [foldedLevel('', 'AB/')],
      query: 'ab/c',
      isDir: false,
      verdict: 'ignored',
      levelIndex: ROOT,
      ruleIndex: 0,
    },
    {
      label: 'a case-sensitive rule against a differently cased directory',
      stack: [level('', 'AB/')],
      query: 'ab/c',
      isDir: false,
      verdict: 'unset',
    },
  ];

  describe.each(rows)('Given $label', ({ stack, query, isDir, verdict, levelIndex, ruleIndex }) => {
    describe('When the path is judged beneath its leading directories', () => {
      it('Then the verdict, level and rule are those of the deciding match', () => {
        // Arrange
        const chain = chainOver(stack, parentDirectoryOf(path(query)));
        const sut = matchBeneathChain;

        // Act
        const result = sut(stack, path(query), isDir, chain);

        // Assert
        expect(result.verdict).toBe(verdict);
        expect(result.ruleIndex).toBe(ruleIndex);
        expect(result.level).toBe(levelIndex === undefined ? undefined : stack[levelIndex]);
      });
    });
  });
});
