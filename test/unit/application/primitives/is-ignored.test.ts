import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { isIgnored } from '../../../../src/application/primitives/is-ignored.js';
import { MAX_GITIGNORE_BYTES } from '../../../../src/application/primitives/types.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';

afterEach(() => __resetConfigCacheForTests());

const path = (p: string): FilePath => p as FilePath;

const seedRepo = async (homeDir?: string) => {
  const ctx = homeDir === undefined ? createMemoryContext() : createMemoryContext({ homeDir });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return ctx;
};

describe('isIgnored', () => {
  describe('Given core.ignorecase true and a root .gitignore holding *.LOG', () => {
    describe('When isIgnored checks x.log', () => {
      it('Then it is ignored by *.LOG', async () => {
        // Arrange
        const ctx = await seedRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tignorecase = true\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.LOG\n');

        // Act
        const [result] = await isIgnored(ctx, [{ path: path('x.log') }]);

        // Assert
        expect(result?.ignored).toBe(true);
        expect(result?.source?.pattern).toBe('*.LOG');
      });
    });
  });

  describe.each([
    ['info/exclude', 'a'],
    ['global excludes', 'a'],
    ['a nested .gitignore', 'sub/a'],
  ])('Given core.ignorecase true and %s holding A', (source, checked) => {
    describe(`When isIgnored checks ${checked}`, () => {
      it('Then it is ignored', async () => {
        // Arrange
        const ctx = await seedRepo('/repo/home');
        const excludes = source === 'global excludes' ? '\texcludesfile = ~/global\n' : '';
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          `[core]\n\tignorecase = true\n${excludes}`,
        );
        const files: Record<string, string> = {
          'info/exclude': `${ctx.layout.gitDir}/info/exclude`,
          'global excludes': '/repo/home/global',
          'a nested .gitignore': `${ctx.layout.workDir}/sub/.gitignore`,
        };
        await ctx.fs.writeUtf8(files[source] as string, 'A\n');

        // Act
        const [result] = await isIgnored(ctx, [{ path: path(checked) }]);

        // Assert
        expect(result?.ignored).toBe(true);
      });
    });
  });

  describe.each([
    ['core.ignorecase false', '[core]\n\tignorecase = false\n'],
    ['core.ignorecase unset', ''],
  ])('Given %s and a root .gitignore holding *.LOG', (_title, config) => {
    describe('When isIgnored checks x.log', () => {
      it('Then it is not ignored', async () => {
        // Arrange
        const ctx = await seedRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.LOG\n');

        // Act
        const [result] = await isIgnored(ctx, [{ path: path('x.log') }]);

        // Assert
        expect(result?.ignored).toBe(false);
      });
    });
  });

  describe('Given a root .gitignore with *.log and a matching path', () => {
    describe('When isIgnored is called', () => {
      it('Then the result is ignored with the matching rule provenance', async () => {
        // Arrange
        const ctx = await seedRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.log\n');

        // Act
        const [result] = await isIgnored(ctx, [{ path: path('foo.log') }]);

        // Assert
        expect(result?.ignored).toBe(true);
        expect(result?.source?.kind).toBe('gitignore');
        expect(result?.source?.basedir).toBe('');
        expect(result?.source?.line).toBe(1);
        expect(result?.source?.pattern).toBe('*.log');
      });
    });
  });

  describe('Given a nested .gitignore with a matching path', () => {
    describe('When isIgnored is called', () => {
      it('Then source.basedir is the nested directory and line/pattern come from that file', async () => {
        // Arrange
        const ctx = await seedRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/.gitignore`, '# header\n*.cache\n');

        // Act
        const [result] = await isIgnored(ctx, [{ path: path('sub/foo.cache') }]);

        // Assert
        expect(result?.ignored).toBe(true);
        expect(result?.source?.kind).toBe('gitignore');
        expect(result?.source?.basedir).toBe('sub');
        expect(result?.source?.line).toBe(2);
        expect(result?.source?.pattern).toBe('*.cache');
      });
    });
  });

  describe('Given a two-level-deep .gitignore and a matching deep path', () => {
    describe('When isIgnored is called', () => {
      it('Then source.basedir is the full two-segment ancestor directory', async () => {
        // Arrange — a depth-3 path exercises the multi-segment ancestor join:
        // a mutant joining segments with '' collapses `a/b` to `ab`, loads the
        // wrong (absent) directory, and misses the rule entirely.
        const ctx = await seedRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a/b/.gitignore`, '*.log\n');

        // Act
        const [result] = await isIgnored(ctx, [{ path: path('a/b/foo.log') }]);

        // Assert
        expect(result?.ignored).toBe(true);
        expect(result?.source?.basedir).toBe('a/b');
        expect(result?.source?.line).toBe(1);
        expect(result?.source?.pattern).toBe('*.log');
      });
    });
  });

  describe('Given no matching rule', () => {
    describe('When isIgnored is called', () => {
      it('Then ignored is false and source is omitted', async () => {
        // Arrange
        const ctx = await seedRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.log\n');

        // Act
        const [result] = await isIgnored(ctx, [{ path: path('keep.txt') }]);

        // Assert
        expect(result?.ignored).toBe(false);
        expect(result?.source).toBeUndefined();
      });
    });
  });

  describe('Given a negated rule that re-includes a previously ignored path', () => {
    describe('When isIgnored is called', () => {
      it('Then ignored is false with no source (per ADR-163)', async () => {
        // Arrange
        const ctx = await seedRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.log\n!keep.log\n');

        // Act
        const [result] = await isIgnored(ctx, [{ path: path('keep.log') }]);

        // Assert
        expect(result?.ignored).toBe(false);
        expect(result?.source).toBeUndefined();
      });
    });
  });

  describe('Given a directory-only rule and a directory path', () => {
    describe('When isIgnored is called with isDirectory:true', () => {
      it('Then the directory is ignored', async () => {
        // Arrange
        const ctx = await seedRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'build/\n');

        // Act
        const [result] = await isIgnored(ctx, [{ path: path('build'), isDirectory: true }]);

        // Assert
        expect(result?.ignored).toBe(true);
        expect(result?.source?.pattern).toBe('build/');
      });
    });
  });

  describe('Given a directory-only rule and a non-directory path', () => {
    describe('When isIgnored is called with isDirectory omitted', () => {
      it('Then the rule does NOT match (default isDirectory is false)', async () => {
        // Arrange — exercises the `isDirectory ?? false` default branch.
        const ctx = await seedRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'build/\n');

        // Act
        const [result] = await isIgnored(ctx, [{ path: path('build') }]);

        // Assert — pins both the verdict AND the absence of source: a mutant
        // that returns a stale source from a prior iteration would survive
        // a verdict-only assertion.
        expect(result?.ignored).toBe(false);
        expect(result?.source).toBeUndefined();
      });
    });
  });

  describe('Given an info/exclude file matches the path', () => {
    describe('When isIgnored is called', () => {
      it('Then source.kind is "info"', async () => {
        // Arrange
        const ctx = await seedRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/exclude`, 'secret.txt\n');

        // Act
        const [result] = await isIgnored(ctx, [{ path: path('secret.txt') }]);

        // Assert
        expect(result?.ignored).toBe(true);
        expect(result?.source?.kind).toBe('info');
      });
    });
  });

  describe('Given the global excludes file matches the path', () => {
    describe('When isIgnored is called', () => {
      it('Then source.kind is "global"', async () => {
        // Arrange — memory fs requires the global excludes path to live under
        // the same rootDir (DEFAULT_WORK_DIR = '/repo'); use '/repo/home' as
        // the home directory, mirroring the existing build-ignore-evaluator
        // test setup.
        const ctx = await seedRepo('/repo/home');
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[core]\n  excludesFile = ~/.gitignore_global\n',
        );
        await ctx.fs.writeUtf8('/repo/home/.gitignore_global', '*.swp\n');

        // Act
        const [result] = await isIgnored(ctx, [{ path: path('foo.swp') }]);

        // Assert
        expect(result?.ignored).toBe(true);
        expect(result?.source?.kind).toBe('global');
      });
    });
  });

  describe('Given an empty queries array', () => {
    describe('When isIgnored is called', () => {
      it('Then it returns an empty result without touching the fs', async () => {
        // Arrange — the `length === 0` short-circuit must return before
        // buildIgnoreEvaluator performs any fs read (git check-ignore with no
        // paths touches nothing). The ignore-file readers prefer the
        // non-throwing `tryLstat`/`tryReadUtf8` twins over `lstat`/`readUtf8`,
        // so the Proxy flags all four — a mutant that drops the short-circuit
        // is caught regardless of which probe the reader reaches for.
        const ctx = await seedRepo();
        const IO_MEMBERS = ['lstat', 'tryLstat', 'readUtf8', 'tryReadUtf8'] as const;
        let touchedFs = false;
        const wrappedFs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            if (IO_MEMBERS.includes(prop as (typeof IO_MEMBERS)[number])) {
              const base = Reflect.get(target, prop, receiver) as (p: string) => unknown;
              return (p: string) => {
                touchedFs = true;
                return base(p);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const wrappedCtx = { ...ctx, fs: wrappedFs };

        // Act
        const result = await isIgnored(wrappedCtx, []);

        // Assert
        expect(result).toEqual([]);
        expect(touchedFs).toBe(false);
      });
    });
  });

  describe('Given an aborted signal and an empty queries array', () => {
    describe('When isIgnored is called', () => {
      it('Then the abort guard throws OPERATION_ABORTED before the empty short-circuit', async () => {
        // Arrange — the abort check precedes the `length === 0` return, so a
        // live abort must throw rather than return []. This isolates the abort
        // guard from the per-query guard, which never runs for empty input.
        const controller = new AbortController();
        controller.abort();
        const ctx = createMemoryContext({ signal: controller.signal });

        // Act
        let caught: unknown;
        try {
          await isIgnored(ctx, []);
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
      });
    });
  });

  describe('Given multiple queries', () => {
    describe('When isIgnored is called', () => {
      it('Then the result preserves input order', async () => {
        // Arrange
        const ctx = await seedRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.log\n');

        // Act
        const result = await isIgnored(ctx, [
          { path: path('a.log') },
          { path: path('b.txt') },
          { path: path('c.log') },
        ]);

        // Assert
        expect(result.map((r) => r.ignored)).toEqual([true, false, true]);
        expect(result.map((r) => r.path)).toEqual(['a.log', 'b.txt', 'c.log']);
      });
    });
  });

  describe('Given an aborted signal', () => {
    describe('When isIgnored is called', () => {
      it('Then the entry guard throws OPERATION_ABORTED', async () => {
        // Arrange
        const controller = new AbortController();
        controller.abort();
        const ctx = createMemoryContext({ signal: controller.signal });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

        // Act
        let caught: unknown;
        try {
          await isIgnored(ctx, [{ path: path('foo.log') }]);
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
      });
    });
  });

  describe('Given a signal aborted during buildIgnoreEvaluator', () => {
    describe('When isIgnored is called with two queries', () => {
      it('Then the per-query guard throws OPERATION_ABORTED before query evaluation', async () => {
        // Arrange — wrap `readUtf8` so reading the root `.gitignore` (which
        // buildIgnoreEvaluator triggers) aborts the controller mid-call.
        // After buildEvaluator returns, the per-query guard at the loop top
        // fires before the first match runs.
        const controller = new AbortController();
        const ctx = createMemoryContext({ signal: controller.signal });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, '*.log\n');

        const baseReadUtf8 = ctx.fs.readUtf8;
        const wrappedFs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            if (prop === 'readUtf8') {
              return async (p: string): Promise<string> => {
                const result = await baseReadUtf8(p);
                if (p.endsWith('/.gitignore')) controller.abort();
                return result;
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const wrappedCtx = { ...ctx, fs: wrappedFs };

        // Act
        let caught: unknown;
        try {
          await isIgnored(wrappedCtx, [{ path: path('a.log') }, { path: path('b.log') }]);
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
      });
    });
  });

  type ExpectedSource = {
    readonly kind: 'global' | 'info' | 'gitignore';
    readonly basedir: string;
    readonly line: number;
    readonly pattern: string;
  };

  interface LeadingDirectoryRow {
    readonly title: string;
    /** Keys are work-tree relative; a `.git/` prefix addresses the git directory. */
    readonly files: Readonly<Record<string, string>>;
    readonly directories?: ReadonlyArray<string>;
    readonly global?: string;
    readonly query: string;
    readonly isDirectory?: boolean;
    readonly expected: ExpectedSource | undefined;
    readonly expectedFolded?: ExpectedSource | undefined;
  }

  const gi = (basedir: string, line: number, pattern: string): ExpectedSource => ({
    kind: 'gitignore',
    basedir,
    line,
    pattern,
  });

  const LEADING_DIRECTORY_ROWS: ReadonlyArray<LeadingDirectoryRow> = [
    {
      title: 'a directory rule without a slash excludes a file beneath it',
      files: { '.gitignore': 'ab\n' },
      query: 'ab/c',
      expected: gi('', 1, 'ab'),
    },
    {
      title: 'a directory rule without a slash matches the directory itself',
      files: { '.gitignore': 'ab\n' },
      query: 'ab',
      expected: gi('', 1, 'ab'),
    },
    {
      title: 'a directory-only rule excludes a file beneath it',
      files: { '.gitignore': 'ab/\n' },
      query: 'ab/c',
      expected: gi('', 1, 'ab/'),
    },
    {
      title: 'a directory-only rule matches the directory queried as a directory',
      files: { '.gitignore': 'ab/\n' },
      query: 'ab',
      isDirectory: true,
      expected: gi('', 1, 'ab/'),
    },
    {
      title: 'a directory-only rule excludes a path two levels beneath it',
      files: { '.gitignore': 'ab/\n' },
      query: 'ab/c/d',
      expected: gi('', 1, 'ab/'),
    },
    {
      title: 'a negation beneath an excluded directory cannot re-include a path',
      files: { '.gitignore': 'ab/\n!ab/c\n' },
      query: 'ab/c',
      expected: gi('', 1, 'ab/'),
    },
    {
      title: 'a nested negation cannot re-include a path beneath an excluded directory',
      files: { '.gitignore': 'ab/\n', 'ab/.gitignore': '!c\n' },
      query: 'ab/c',
      expected: gi('', 1, 'ab/'),
    },
    {
      title: 'a nested negation cannot re-include the nested .gitignore itself',
      files: { '.gitignore': 'ab/\n', 'ab/.gitignore': '!c\n' },
      query: 'ab/.gitignore',
      expected: gi('', 1, 'ab/'),
    },
    {
      title: 'a directory-only rule excludes a path beneath a missing directory',
      files: { '.gitignore': 'ab/\n' },
      query: 'ab/c',
      expected: gi('', 1, 'ab/'),
    },
    {
      title: 'a directory-only rule does not match a missing path queried as a file',
      files: { '.gitignore': 'ab/\n' },
      query: 'ab',
      expected: undefined,
    },
    {
      title: 'a nested directory-only rule excludes the path beneath it',
      files: { '.gitignore': 'x/y/\n' },
      query: 'x/y/z/w',
      expected: gi('', 1, 'x/y/'),
    },
    {
      title: 'a nested directory-only rule excludes the directory beneath it',
      files: { '.gitignore': 'x/y/\n' },
      query: 'x/y/z',
      expected: gi('', 1, 'x/y/'),
    },
    {
      title: 'a nested directory-only rule leaves a sibling alone',
      files: { '.gitignore': 'x/y/\n' },
      query: 'x/q',
      expected: undefined,
    },
    {
      title: 'a negation of the directory itself keeps the path',
      files: { '.gitignore': 'ab/\n!ab/\n' },
      query: 'ab/c',
      expected: undefined,
    },
    {
      title: 'a wildcard excludes a path whose directory is only re-included afterwards',
      files: { '.gitignore': '*\n!ab/\n' },
      query: 'ab/c',
      expected: gi('', 1, '*'),
    },
    {
      title: 'the directory rule wins over a later file rule',
      files: { '.gitignore': 'ab\n*.log\n' },
      query: 'ab/x.log',
      expected: gi('', 1, 'ab'),
    },
    {
      title: 'a nested .gitignore excludes a directory beneath it',
      files: { 'a/.gitignore': 'b/\n' },
      query: 'a/b/c',
      expected: gi('a', 1, 'b/'),
    },
    {
      title: 'info/exclude excludes a path beneath a directory',
      files: { '.git/info/exclude': 'ab/\n' },
      query: 'ab/c',
      expected: { kind: 'info', basedir: '', line: 1, pattern: 'ab/' },
    },
    {
      title: 'a rule folds case only under core.ignorecase',
      files: { '.gitignore': 'AB/\n' },
      query: 'ab/c',
      expected: undefined,
      expectedFolded: gi('', 1, 'AB/'),
    },
    {
      title: 'a nested negation re-includes a directory the root rule excluded',
      files: { '.gitignore': 'a/b/\n', 'a/.gitignore': '!b/\n' },
      query: 'a/b/c',
      expected: undefined,
    },
    {
      title: 'an excluded directory hides a nested re-inclusion of its subdirectory',
      files: { '.gitignore': 'a/\n', 'a/.gitignore': '!b/\n!b/c\n' },
      query: 'a/b/c',
      expected: gi('', 1, 'a/'),
    },
    {
      title: 'a re-included child of a wildcard directory rule stays included',
      files: { '.gitignore': 'ab/*\n!ab/c\n' },
      query: 'ab/c',
      expected: undefined,
    },
    {
      title: 'a sibling of a re-included child stays excluded',
      files: { '.gitignore': 'ab/*\n!ab/d\n' },
      query: 'ab/c',
      expected: gi('', 1, 'ab/*'),
    },
    {
      title: 'a file standing where the excluded directory should be still excludes beneath it',
      files: { '.gitignore': 'ab/\n', ab: 'f' },
      query: 'ab/c',
      expected: gi('', 1, 'ab/'),
    },
    {
      title: 'a file is not matched by a directory-only rule',
      files: { '.gitignore': 'ab/\n', ab: 'f' },
      query: 'ab',
      expected: undefined,
    },
    {
      title: 'a double-star directory rule excludes a path beneath a nested match',
      files: { '.gitignore': '**/build/\n' },
      query: 'p/build/o/f',
      expected: gi('', 1, '**/build/'),
    },
    {
      title: 'a double-star directory rule matches the directory queried as a directory',
      files: { '.gitignore': '**/build/\n' },
      query: 'p/build',
      isDirectory: true,
      expected: gi('', 1, '**/build/'),
    },
    {
      title: 'the global excludes file excludes a path beneath a directory',
      files: {},
      global: 'ab/\n',
      query: 'ab/c',
      expected: { kind: 'global', basedir: '', line: 1, pattern: 'ab/' },
    },
  ];

  const writeRow = async (
    ctx: Awaited<ReturnType<typeof seedRepo>>,
    row: LeadingDirectoryRow,
    ignoreCase: string,
  ): Promise<void> => {
    const excludes =
      row.global === undefined ? '' : `\texcludesfile = ${ctx.layout.gitDir}/global-excludes\n`;
    await ctx.fs.writeUtf8(
      `${ctx.layout.gitDir}/config`,
      `[core]\n\tignorecase = ${ignoreCase}\n${excludes}`,
    );
    if (row.global !== undefined)
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/global-excludes`, row.global);
    for (const [name, content] of Object.entries(row.files)) {
      const target = name.startsWith('.git/')
        ? `${ctx.layout.gitDir}/${name.slice('.git/'.length)}`
        : `${ctx.layout.workDir}/${name}`;
      await ctx.fs.writeUtf8(target, content);
    }
  };

  const TOO_LARGE = 'x'.repeat(MAX_GITIGNORE_BYTES + 1);

  describe.each(['false', 'true'])('Given core.ignorecase is %s', (ignoreCase) => {
    describe('When isIgnored is asked about a path beneath its rule files', () => {
      it.each(LEADING_DIRECTORY_ROWS)('Then $title', async (row) => {
        // Arrange
        const ctx = await seedRepo();
        await writeRow(ctx, row, ignoreCase);
        const sut = isIgnored;
        const expected =
          ignoreCase === 'true' && 'expectedFolded' in row ? row.expectedFolded : row.expected;

        // Act
        const [result] = await sut(ctx, [
          { path: path(row.query), isDirectory: row.isDirectory === true },
        ]);

        // Assert
        expect(result?.ignored).toBe(expected !== undefined);
        expect(result?.source).toEqual(expected);
      });
    });
  });

  describe('Given a rule excluding ab and a .gitignore inside ab that cannot be read as rules', () => {
    describe.each([
      ['an oversized .gitignore', 'ab/.gitignore', 'ab/c', TOO_LARGE, false],
      ['a directory standing at .gitignore', 'ab/.gitignore', 'ab/c', '', true],
      [
        'an oversized .gitignore in a deeper directory',
        'ab/x/.gitignore',
        'ab/x/y',
        TOO_LARGE,
        false,
      ],
    ])('And %s', (_title, unreadable, query, content, isDirectoryAtPath) => {
      describe('When isIgnored is asked about a path beneath ab', () => {
        it('Then the excluded directory decides and nothing is read', async () => {
          // Arrange
          const ctx = await seedRepo();
          await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitignore`, 'ab/\n');
          const target = `${ctx.layout.workDir}/${unreadable}`;
          if (isDirectoryAtPath) await ctx.fs.mkdir(target);
          else await ctx.fs.writeUtf8(target, content);
          const sut = isIgnored;

          // Act
          const [result] = await sut(ctx, [{ path: path(query) }]);

          // Assert
          expect(result?.ignored).toBe(true);
          expect(result?.source).toEqual({
            kind: 'gitignore',
            basedir: '',
            line: 1,
            pattern: 'ab/',
          });
        });
      });
    });
  });

  describe('Given a .gitignore inside a directory that no rule excludes and that is over the size limit', () => {
    describe('When isIgnored is asked about a path beneath it', () => {
      it('Then it throws GITIGNORE_FILE_TOO_LARGE with the file and its size', async () => {
        // Arrange
        const ctx = await seedRepo();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/ab/.gitignore`, TOO_LARGE);
        const sut = isIgnored;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, [{ path: path('ab/c') }]);
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as TsgitError).data as unknown as Record<string, unknown>;
        expect(data.code).toBe('GITIGNORE_FILE_TOO_LARGE');
        expect(data.path).toBe('.gitignore');
        expect(data.size).toBe(MAX_GITIGNORE_BYTES + 1);
        expect(data.limit).toBe(MAX_GITIGNORE_BYTES);
      });
    });
  });

  describe('Given queries about the same paths in opposite orders', () => {
    describe.each([
      [
        'a directory excluded by the root rule',
        { '.gitignore': 'ab/\n' },
        ['ab/c', 'ab'],
        [false, true],
      ],
      [
        'nested rules at two depths',
        { 'a/.gitignore': '*.log\n', 'a/b/.gitignore': '!keep.log\n' },
        ['a/x.log', 'a/b/keep.log', 'a/b/c.log'],
        [false, false, false],
      ],
    ] as const)('And %s', (_title, files, paths, directoryFlags) => {
      describe('When isIgnored answers them', () => {
        it('Then each path gets the same verdict and source in either order', async () => {
          // Arrange
          const ctx = await seedRepo();
          for (const [name, content] of Object.entries(files)) {
            await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}`, content);
          }
          const queries = paths.map((p, i) => ({
            path: path(p),
            isDirectory: directoryFlags[i] === true,
          }));
          const sut = isIgnored;

          // Act
          const forward = await sut(ctx, queries);
          const backward = await sut(ctx, [...queries].reverse());

          // Assert
          expect([...backward].reverse()).toEqual(forward);
        });
      });
    });
  });
});
