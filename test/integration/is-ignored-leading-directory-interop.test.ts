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
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { isIgnored } from '../../src/application/primitives/is-ignored.js';
import type { TsgitError } from '../../src/domain/error.js';
import type { FilePath } from '../../src/domain/objects/object-id.js';
import { GIT_AVAILABLE, git, runGit, tryRunGitWithExit } from './interop-helpers.js';

const OVERSIZED_GITIGNORE = 'x'.repeat((1 << 20) + 1);
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

const gitRefusal = (repo: string, query: string): GitRefusal => {
  const { stderr, exitCode } = tryRunGitWithExit(
    ['-C', repo, 'check-ignore', '-v', '--no-index', '--', query],
    {},
  );
  return { exitCode, stderr };
};

const tsgitRefusal = async (repo: string, query: string): Promise<unknown> => {
  const sut = isIgnored;
  try {
    await sut(createNodeContext({ workDir: repo }), [{ path: query as FilePath }]);
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
