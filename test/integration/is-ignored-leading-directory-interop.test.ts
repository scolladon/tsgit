/**
 * Cross-tool interop — a path beneath an excluded leading directory. The verdict and the
 * rule that decided it are compared with live `git check-ignore -v --no-index` under both
 * values of `core.ignorecase`: the expectation is git's own answer, never a hard-coded list.
 *
 * @proves
 *   surface:        isIgnored
 *   bucket:         cross-tool-interop
 *   unique:         a path beneath an excluded leading directory reports that directory's rule as git check-ignore does under both core.ignorecase values
 *   interopSurface: isIgnored
 */
import { lstatSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, truncate, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { isIgnored } from '../../src/application/primitives/is-ignored.js';
import type { TsgitError } from '../../src/domain/error.js';
import type { FilePath } from '../../src/domain/objects/object-id.js';
import { GIT_AVAILABLE, git, runGit, tryRunGitWithExit } from './interop-helpers.js';

const OVERSIZED_GITIGNORE = 'x'.repeat((1 << 20) + 1);
// A size at which git itself refuses a rule file.
const OVERSIZED_FOR_GIT_BYTES = 100 * 1024 * 1024 + 1;
const NEGATION = '!';
const GITIGNORE_FIELDS = 4;
const EXCLUDES_FILE_NAME = 'global-excludes';

interface Row {
  readonly title: string;
  /** Every rule file and on-disk file; a `.git/` key is written after `git init`. */
  readonly files: Readonly<Record<string, string>>;
  readonly directories?: ReadonlyArray<string>;
  readonly excludesFile?: string;
  readonly query: string;
}

const row = (
  title: string,
  files: Readonly<Record<string, string>>,
  query: string,
  extra: Partial<Row> = {},
): Row => ({ title, files, query, ...extra });

const ROWS: ReadonlyArray<Row> = [
  row(
    'a rule without a slash excludes a file beneath the directory',
    { '.gitignore': 'ab\n', 'ab/c': '' },
    'ab/c',
  ),
  row(
    'a rule without a slash matches the directory itself',
    { '.gitignore': 'ab\n', 'ab/c': '' },
    'ab',
  ),
  row(
    'a directory-only rule excludes a file beneath the directory',
    { '.gitignore': 'ab/\n', 'ab/c': '' },
    'ab/c',
  ),
  row(
    'a directory-only rule matches the directory itself',
    { '.gitignore': 'ab/\n', 'ab/c': '' },
    'ab',
  ),
  row(
    'a directory-only rule excludes a path two levels beneath',
    { '.gitignore': 'ab/\n', 'ab/c/d': '' },
    'ab/c/d',
  ),
  row(
    'a negation beneath an excluded directory cannot re-include a path',
    { '.gitignore': 'ab/\n!ab/c\n', 'ab/c': '' },
    'ab/c',
  ),
  row(
    'a nested negation cannot re-include a path beneath an excluded directory',
    { '.gitignore': 'ab/\n', 'ab/.gitignore': '!c\n', 'ab/c': '' },
    'ab/c',
  ),
  row(
    'a nested negation cannot re-include the nested .gitignore',
    { '.gitignore': 'ab/\n', 'ab/.gitignore': '!c\n' },
    'ab/.gitignore',
  ),
  row(
    'a directory-only rule excludes a path beneath a missing directory',
    { '.gitignore': 'ab/\n' },
    'ab/c',
  ),
  row(
    'a directory-only rule does not match a missing path queried as a file',
    { '.gitignore': 'ab/\n' },
    'ab',
  ),
  row(
    'a nested directory-only rule excludes the path beneath it',
    { '.gitignore': 'x/y/\n', 'x/y/z/w': '' },
    'x/y/z/w',
  ),
  row(
    'a nested directory-only rule excludes the directory beneath it',
    { '.gitignore': 'x/y/\n', 'x/y/z/w': '' },
    'x/y/z',
  ),
  row(
    'a nested directory-only rule leaves a sibling alone',
    { '.gitignore': 'x/y/\n', 'x/q': '' },
    'x/q',
  ),
  row(
    'a negation of the directory itself keeps the path',
    { '.gitignore': 'ab/\n!ab/\n', 'ab/c': '' },
    'ab/c',
  ),
  row(
    'a wildcard excludes a path whose directory is re-included afterwards',
    { '.gitignore': '*\n!ab/\n', 'ab/c': '' },
    'ab/c',
  ),
  row(
    'the directory rule wins over a later file rule',
    { '.gitignore': 'ab\n*.log\n', 'ab/x.log': '' },
    'ab/x.log',
  ),
  row(
    'a nested .gitignore excludes a directory beneath it',
    { 'a/.gitignore': 'b/\n', 'a/b/c': '' },
    'a/b/c',
  ),
  row(
    'info/exclude excludes a path beneath a directory',
    { '.git/info/exclude': 'ab/\n', 'ab/c': '' },
    'ab/c',
  ),
  row(
    'a rule folds case only under core.ignorecase',
    { '.gitignore': 'AB/\n', 'ab/c': '' },
    'ab/c',
  ),
  row(
    'a nested negation re-includes a directory the root rule excluded',
    { '.gitignore': 'a/b/\n', 'a/.gitignore': '!b/\n', 'a/b/c': '' },
    'a/b/c',
  ),
  row(
    'an excluded directory hides a nested re-inclusion of its subdirectory',
    { '.gitignore': 'a/\n', 'a/.gitignore': '!b/\n!b/c\n', 'a/b/c': '' },
    'a/b/c',
  ),
  row(
    'a re-included child of a wildcard directory rule stays included',
    { '.gitignore': 'ab/*\n!ab/c\n', 'ab/c': '' },
    'ab/c',
  ),
  row(
    'a sibling of a re-included child stays excluded',
    { '.gitignore': 'ab/*\n!ab/c\n', 'ab/d': '' },
    'ab/d',
  ),
  row(
    'a file standing where the excluded directory should be excludes beneath it',
    { '.gitignore': 'ab/\n', ab: 'f' },
    'ab/c',
  ),
  row('a file is not matched by a directory-only rule', { '.gitignore': 'ab/\n', ab: 'f' }, 'ab'),
  row(
    'a double-star directory rule excludes a path beneath a nested match',
    { '.gitignore': '**/build/\n', 'p/build/o/f': '' },
    'p/build/o/f',
  ),
  row(
    'a double-star directory rule matches the directory itself',
    { '.gitignore': '**/build/\n', 'p/build/o/f': '' },
    'p/build',
  ),
  row('the global excludes file excludes a path beneath a directory', { 'ab/c': '' }, 'ab/c', {
    excludesFile: 'ab/\n',
  }),
  row(
    'an oversized .gitignore inside an excluded directory is never read',
    { '.gitignore': 'ab/\n', 'ab/.gitignore': OVERSIZED_GITIGNORE, 'ab/c': '' },
    'ab/c',
  ),
  row(
    'a directory standing at .gitignore inside an excluded directory is never read',
    { '.gitignore': 'ab/\n', 'ab/c': '' },
    'ab/c',
    { directories: ['ab/.gitignore'] },
  ),
];

interface Verdict {
  readonly ignored: boolean;
  readonly verbose: string | undefined;
}

const gitVerdict = (repo: string, query: string): Verdict => {
  const { stdout, stderr, exitCode } = tryRunGitWithExit(
    ['-C', repo, 'check-ignore', '-v', '-z', '--stdin', '--no-index'],
    { input: `${query}\0` },
  );
  if (exitCode > 1) throw new Error(`git check-ignore failed (${exitCode}): ${stderr}`);
  const fields = stdout.split('\0').filter((field) => field !== '');
  if (exitCode === 1 || fields.length < GITIGNORE_FIELDS)
    return { ignored: false, verbose: undefined };
  const [source, line, pattern] = fields as [string, string, string];
  if (pattern.startsWith(NEGATION)) return { ignored: false, verbose: undefined };
  return { ignored: true, verbose: `${source}:${line}:${pattern}` };
};

const sourceFile = (kind: string, basedir: string, excludesFile: string): string => {
  if (kind === 'info') return '.git/info/exclude';
  if (kind === 'global') return excludesFile;
  return basedir === '' ? '.gitignore' : `${basedir}/.gitignore`;
};

const isDirectoryOnDisk = (target: string): boolean => {
  try {
    return lstatSync(target, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch (error) {
    // A file standing where a leading directory should be: nothing lives beneath it.
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return false;
    throw error;
  }
};

const tsgitVerdict = async (
  repo: string,
  query: string,
  excludesFile: string,
): Promise<Verdict> => {
  const isDirectory = isDirectoryOnDisk(path.join(repo, query));
  const [match] = await isIgnored(createNodeContext({ workDir: repo }), [
    { path: query as FilePath, isDirectory },
  ]);
  if (match?.source === undefined) return { ignored: false, verbose: undefined };
  const { kind, basedir, line, pattern } = match.source;
  return {
    ignored: true,
    verbose: `${sourceFile(kind, basedir, excludesFile)}:${line}:${pattern}`,
  };
};

const writeRepo = async (root: string, ignoreCase: string, fixture: Row): Promise<string> => {
  const repo = await mkdtemp(path.join(root, 'leading-'));
  runGit(['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'core.ignorecase', ignoreCase);
  for (const [name, content] of Object.entries(fixture.files)) {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await writeFile(path.join(repo, name), content);
  }
  for (const directory of fixture.directories ?? []) {
    await mkdir(path.join(repo, directory), { recursive: true });
  }
  return repo;
};

interface GitRefusal {
  readonly exitCode: number;
  readonly stderr: string;
}

const gitRefusal = (repo: string, ...queries: ReadonlyArray<string>): GitRefusal => {
  const { stderr, exitCode } = tryRunGitWithExit(
    ['-C', repo, 'check-ignore', '-v', '--no-index', '--', ...queries],
    {},
  );
  return { exitCode, stderr };
};

const tsgitRefusal = async (repo: string, ...queries: ReadonlyArray<string>): Promise<unknown> => {
  const sut = isIgnored;
  try {
    await sut(
      createNodeContext({ workDir: repo }),
      queries.map((query) => ({ path: query as FilePath })),
    );
  } catch (caught) {
    return (caught as TsgitError).data;
  }
  return expect.unreachable('isIgnored did not refuse');
};

const LINK_TARGETS = [
  { title: 'outside the repository', inside: false, ignoreFile: 'secret\n' },
  { title: 'inside the repository', inside: true, ignoreFile: 'secret\n' },
  { title: 'holding no .gitignore', inside: true, ignoreFile: undefined },
] as const;

const layLink = async (root: string, repo: string, target: (typeof LINK_TARGETS)[number]) => {
  const directory = target.inside
    ? path.join(repo, 'real')
    : await mkdtemp(path.join(root, 'elsewhere-'));
  await mkdir(directory, { recursive: true });
  if (target.ignoreFile !== undefined) {
    await writeFile(path.join(directory, '.gitignore'), target.ignoreFile);
  }
  symlinkSync(directory, path.join(repo, 'link'));
};

/** A root rule file, a rule file behind a link, a file and a directory: one fixture for every spelling. */
const SPELLING_FILES = {
  '.gitignore': '*.log\n/anchored\n',
  'real/.gitignore': 'secret\n',
  file: '',
  'sub/keep': '',
} as const;

const SPELLINGS = [
  './top.log',
  'sub/../top.log',
  'sub//x.log',
  'sub/./x.log',
  'sub/../anchored',
  'sub/anchored',
  'link/../top.log',
  'link/../secret',
  '.',
  'sub/..',
  'sub/../',
] as const;
const SPELLINGS_GIT_IGNORES = 6;

const writeSpellingRepo = async (root: string, ignoreCase: string): Promise<string> => {
  const repo = await writeRepo(root, ignoreCase, row('spellings', SPELLING_FILES, ''));
  symlinkSync(path.join(repo, 'real'), path.join(repo, 'link'));
  return repo;
};

/** Spellings of the work tree itself, then one path at its root. */
const ROOT_SPELLINGS = ['.', 'sub/..', 'sub/../', 'top.log'] as const;
const ROOT_RULES = [
  { rule: '/*', gitIgnores: 1 },
  { rule: '*', gitIgnores: ROOT_SPELLINGS.length },
] as const;

const writeRootRuleRepo = (root: string, ignoreCase: string, rule: string): Promise<string> =>
  writeRepo(root, ignoreCase, row('root rule', { '.gitignore': `${rule}\n`, 'sub/keep': '' }, ''));

const EXCLUDE_FILES_GIT_READS_FIRST = [
  { title: '.git/info/exclude', isConfigured: false },
  { title: 'the core.excludesFile file', isConfigured: true },
] as const;

describe.skipIf(!GIT_AVAILABLE)('integration — isIgnored beneath an excluded directory', () => {
  let root: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-ignore-leading-')));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe.each(['false', 'true'])('Given core.ignorecase is %s', (ignoreCase) => {
    describe('When isIgnored is asked about a path beneath its rule files', () => {
      it.each(ROWS)('Then $title as git check-ignore reports', async (fixture) => {
        // Arrange
        const repo = await writeRepo(root, ignoreCase, fixture);
        const excludesPath = path.join(repo, '.git', EXCLUDES_FILE_NAME);
        if (fixture.excludesFile !== undefined) {
          await writeFile(excludesPath, fixture.excludesFile);
          git(repo, 'config', 'core.excludesFile', excludesPath);
        }
        const sut = tsgitVerdict;

        // Act
        const result = await sut(repo, fixture.query, excludesPath);

        // Assert
        expect(result).toEqual(gitVerdict(repo, fixture.query));
      });
    });

    describe('When isIgnored is asked about a path beyond a symbolic link', () => {
      it.each(LINK_TARGETS)(
        'Then a link $title is refused as git check-ignore refuses',
        async (target) => {
          // Arrange
          const repo = await writeRepo(root, ignoreCase, row('link', {}, 'link/secret'));
          await layLink(root, repo, target);

          // Act
          const result = await tsgitRefusal(repo, 'link/secret');

          // Assert
          const refusal = gitRefusal(repo, 'link/secret');
          expect(refusal.exitCode).toBe(128);
          expect(refusal.stderr).toContain('is beyond a symbolic link');
          expect(result).toMatchObject({ code: 'PATHSPEC_BEYOND_SYMLINK', path: 'link/secret' });
        },
      );
    });

    describe('When isIgnored is asked about a path spelled with dot, dot-dot or doubled separators', () => {
      it.each(SPELLINGS)('Then %s is answered as git check-ignore answers', async (query) => {
        // Arrange
        const repo = await writeSpellingRepo(root, ignoreCase);
        const sut = tsgitVerdict;

        // Act
        const result = await sut(repo, query, path.join(repo, '.git', EXCLUDES_FILE_NAME));

        // Assert
        expect(result).toEqual(gitVerdict(repo, query));
      });

      it('Then git itself ignores some of those spellings and not others', async () => {
        // Arrange
        const repo = await writeSpellingRepo(root, ignoreCase);
        const sut = gitVerdict;

        // Act
        const result = SPELLINGS.filter((query) => sut(repo, query).ignored);

        // Assert
        expect(result).toHaveLength(SPELLINGS_GIT_IGNORES);
      });

      it.each(['missing/../link/secret', 'file/../link/secret'])(
        'Then %s is refused as beyond a symbolic link, as git check-ignore refuses it',
        async (query) => {
          // Arrange
          const repo = await writeSpellingRepo(root, ignoreCase);

          // Act
          const result = await tsgitRefusal(repo, query);

          // Assert
          const refusal = gitRefusal(repo, query);
          expect(refusal.exitCode).toBe(128);
          expect(refusal.stderr).toContain(`pathspec '${query}' is beyond a symbolic link`);
          expect(result).toEqual({ code: 'PATHSPEC_BEYOND_SYMLINK', path: query });
        },
      );

      it.each(['../out/secret', 'sub/../../x'])(
        'Then %s is refused as outside the repository, as git check-ignore refuses it',
        async (query) => {
          // Arrange
          const repo = await writeSpellingRepo(root, ignoreCase);

          // Act
          const result = await tsgitRefusal(repo, query);

          // Assert
          const refusal = gitRefusal(repo, query);
          expect(refusal.exitCode).toBe(128);
          expect(refusal.stderr).toContain(`'${query}' is outside repository`);
          expect(result).toEqual({ code: 'PATHSPEC_OUTSIDE_REPO', path: query });
        },
      );

      it.each([
        {
          queries: ['../x', 'link/secret'],
          message: "'../x' is outside repository",
          refusal: { code: 'PATHSPEC_OUTSIDE_REPO', path: '../x' },
        },
        {
          queries: ['link/secret', '../x'],
          message: "pathspec 'link/secret' is beyond a symbolic link",
          refusal: { code: 'PATHSPEC_BEYOND_SYMLINK', path: 'link/secret' },
        },
      ])(
        'Then of $queries the first refused one decides, as in git check-ignore',
        async ({ queries, message, refusal }) => {
          // Arrange
          const repo = await writeSpellingRepo(root, ignoreCase);

          // Act
          const result = await tsgitRefusal(repo, ...queries);

          // Assert
          const gitAnswer = gitRefusal(repo, ...queries);
          expect(gitAnswer.exitCode).toBe(128);
          expect(gitAnswer.stderr).toContain(message);
          expect(result).toEqual(refusal);
        },
      );
    });

    describe('When isIgnored is asked about an empty path', () => {
      it.each([[['']], [['link/secret', '']], [['../x', '']]])(
        'Then of %j the empty path refuses the call, as in git check-ignore',
        async (queries) => {
          // Arrange
          const repo = await writeSpellingRepo(root, ignoreCase);

          // Act
          const result = await tsgitRefusal(repo, ...queries);

          // Assert
          const refusal = gitRefusal(repo, ...queries);
          expect(refusal.exitCode).toBe(128);
          expect(refusal.stderr).toContain('empty string is not a valid pathspec');
          expect(result).toEqual({ code: 'EMPTY_PATHSPEC' });
        },
      );
    });

    describe.each(ROOT_RULES)(
      'When the root .gitignore holds $rule and the path names the work tree itself or a path at its root',
      ({ rule, gitIgnores }) => {
        it.each(ROOT_SPELLINGS)(
          'Then %s is answered as git check-ignore answers',
          async (query) => {
            // Arrange
            const repo = await writeRootRuleRepo(root, ignoreCase, rule);
            const sut = tsgitVerdict;

            // Act
            const result = await sut(repo, query, path.join(repo, '.git', EXCLUDES_FILE_NAME));

            // Assert
            expect(result).toEqual(gitVerdict(repo, query));
          },
        );

        it('Then git itself ignores as many of those spellings as the rule can name', async () => {
          // Arrange
          const repo = await writeRootRuleRepo(root, ignoreCase, rule);
          const sut = gitVerdict;

          // Act
          const result = ROOT_SPELLINGS.filter((query) => sut(repo, query).ignored);

          // Assert
          expect(result).toHaveLength(gitIgnores);
        });
      },
    );

    describe('When a rule file is too large and the queried path lies beyond a symbolic link', () => {
      it.each(EXCLUDE_FILES_GIT_READS_FIRST)(
        'Then $title refuses first, as in git check-ignore',
        async ({ isConfigured }) => {
          // Arrange
          const repo = await writeSpellingRepo(root, ignoreCase);
          const oversized = isConfigured
            ? path.join(repo, '.git', EXCLUDES_FILE_NAME)
            : path.join(repo, '.git', 'info', 'exclude');
          await mkdir(path.dirname(oversized), { recursive: true });
          await writeFile(oversized, '');
          await truncate(oversized, OVERSIZED_FOR_GIT_BYTES);
          if (isConfigured) git(repo, 'config', 'core.excludesFile', oversized);

          // Act
          const result = await tsgitRefusal(repo, 'link/secret');

          // Assert
          const refusal = gitRefusal(repo, 'link/secret');
          expect(refusal.exitCode).toBe(128);
          expect(refusal.stderr).toContain('as an exclude file');
          expect(result).toMatchObject({ code: 'GITIGNORE_FILE_TOO_LARGE' });
        },
      );

      it('Then an oversized root .gitignore does not: the link refuses, as in git check-ignore', async () => {
        // Arrange
        const repo = await writeSpellingRepo(root, ignoreCase);
        await writeFile(path.join(repo, '.gitignore'), OVERSIZED_GITIGNORE);

        // Act
        const result = await tsgitRefusal(repo, 'link/secret');

        // Assert
        const refusal = gitRefusal(repo, 'link/secret');
        expect(refusal.exitCode).toBe(128);
        expect(refusal.stderr).toContain("pathspec 'link/secret' is beyond a symbolic link");
        expect(result).toEqual({ code: 'PATHSPEC_BEYOND_SYMLINK', path: 'link/secret' });
      });
    });

    describe('When isIgnored is asked about the symbolic link itself', () => {
      it('Then it answers as git check-ignore does', async () => {
        // Arrange
        const repo = await writeRepo(
          root,
          ignoreCase,
          row('link', { '.gitignore': 'link\n' }, 'link'),
        );
        await layLink(root, repo, LINK_TARGETS[1]);
        const sut = tsgitVerdict;

        // Act
        const result = await sut(repo, 'link', path.join(repo, '.git', EXCLUDES_FILE_NAME));

        // Assert
        expect(gitRefusal(repo, 'link').exitCode).toBeLessThanOrEqual(1);
        expect(result).toEqual(gitVerdict(repo, 'link'));
      });
    });
  });
});
