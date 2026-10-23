/**
 * Cross-tool interop — a backslash in a pathspec is an escape for the next
 * byte under git's `wildmatch`, and a backslash in a file name is an ordinary
 * byte, so on a POSIX host `add`, `status`, `checkout` and `grep` agree with
 * `git`; under Windows path syntax tsgit keeps refusing it.
 *
 * @proves
 *   surface:        add
 *   bucket:         cross-tool-interop
 *   unique:         a backslash pathspec escapes, and a backslash file name is walked, as git does
 *   interopSurface: add
 */
import { mkdtemp, readFile, realpath, rm as removeTree, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { grep } from '../../src/application/commands/grep.js';
import { status } from '../../src/application/commands/status.js';
import { TsgitError } from '../../src/domain/error.js';
import { GIT_AVAILABLE, runGit, runGitEnv } from './interop-helpers.js';

const splitNames = (nul: string): string[] => nul.split('\0').filter((name) => name !== '');

const namesOf = (repo: string): string[] =>
  splitNames(runGit(['-C', repo, 'ls-files', '-z'])).sort();

const snapshotOf = (repo: string) => ({
  index: runGit(['-C', repo, 'ls-files', '-s']),
  status: runGit(['-C', repo, 'status', '--porcelain', '--untracked-files=all']),
});

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'Given a pathspec holding a backslash on a POSIX host',
  () => {
    let root = '';
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-backslash-')));
    });

    afterAll(async () => {
      await removeTree(root, { recursive: true, force: true });
    });

    const twin = async (side: string, files: ReadonlyArray<string>): Promise<string> => {
      counter += 1;
      const repo = path.join(root, `${side}-${counter}`);
      runGit(['init', '-q', '-b', 'main', repo]);
      for (const name of files) await writeFile(path.join(repo, name), `${name}\n`);
      return repo;
    };

    describe.each([
      { files: ['a*b', 'aXb'], spec: 'a\\*b', staged: ['a*b'] },
      { files: ['a?b', 'axb'], spec: 'a\\?b', staged: ['a?b'] },
      { files: ['ab', 'b'], spec: 'a\\b', staged: ['ab'] },
    ])('When git and tsgit add the untracked files with the pathspec $spec', (row) => {
      it('Then both stage the same paths', async () => {
        // Arrange
        const gitRepo = await twin('git', row.files);
        const tsgitRepo = await twin('tsgit', row.files);
        const sut = add;

        // Act
        runGit(['-C', gitRepo, 'add', '--', row.spec]);
        await sut(createNodeContext({ workDir: tsgitRepo }), [row.spec]);

        // Assert
        expect(namesOf(gitRepo)).toEqual(row.staged);
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
      });
    });

    describe.each([
      {
        label: 'dot',
        files: ['a\\b', 'ab', 'k'],
        spec: ['.'],
        all: false,
        staged: ['a\\b', 'ab', 'k'],
      },
      {
        label: 'all',
        files: ['a\\b', 'ab', 'k'],
        spec: [],
        all: true,
        staged: ['a\\b', 'ab', 'k'],
      },
      {
        label: 'escaped',
        files: ['a\\b', 'ab', 'k'],
        spec: ['a\\\\b'],
        all: false,
        staged: ['a\\b'],
      },
      { label: 'question', files: ['a\\b', 'ab', 'k'], spec: ['a?'], all: false, staged: ['ab'] },
      {
        label: 'bare',
        files: ['a\\b', 'ab', 'k'],
        spec: ['a\\b'],
        all: false,
        staged: ['a\\b', 'ab'],
      },
      { label: 'trailing', files: ['a\\', 'ab'], spec: ['a\\'], all: false, staged: ['a\\'] },
      { label: 'literal', files: ['a\\b', 'ab', 'k'], spec: ['ab'], all: false, staged: ['ab'] },
    ])('When git and tsgit add the untracked files by $label', (row) => {
      it('Then both stage the same paths', async () => {
        // Arrange
        const gitRepo = await twin('git', row.files);
        const tsgitRepo = await twin('tsgit', row.files);
        const sut = add;
        const gitArgs = row.all ? ['add', '-A'] : ['add', '--', ...row.spec];

        // Act
        runGit(['-C', gitRepo, ...gitArgs]);
        await sut(createNodeContext({ workDir: tsgitRepo }), row.spec, { all: row.all });

        // Assert
        expect(namesOf(gitRepo)).toEqual([...row.staged].sort());
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
      });
    });

    const commitAll = (repo: string): void => {
      runGit(['-C', repo, 'add', '-A']);
      runGit(
        [
          '-C',
          repo,
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@example.com',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-q',
          '-m',
          'm',
        ],
        { env: runGitEnv() },
      );
    };

    const dirtyTwin = async (side: string): Promise<string> => {
      const repo = await twin(side, ['a\\b', 'ab', 'k']);
      commitAll(repo);
      await writeFile(path.join(repo, 'a\\b'), 'dirty');
      return repo;
    };

    const porcelainPaths = (repo: string): string[] =>
      splitNames(runGit(['-C', repo, 'status', '--porcelain', '-z', '--untracked-files=all']))
        .map((line) => line.slice(3))
        .sort();

    describe('When git and tsgit report the status of untracked files', () => {
      it('Then both list the same paths', async () => {
        // Arrange
        const gitRepo = await twin('git', ['a\\b', 'ab', 'k']);
        const tsgitRepo = await twin('tsgit', ['a\\b', 'ab', 'k']);
        const sut = status;

        // Act
        const result = await sut(createNodeContext({ workDir: tsgitRepo }));

        // Assert
        expect([...result.untracked].sort()).toEqual(porcelainPaths(gitRepo));
        expect(result.changes).toEqual([]);
      });
    });

    describe('When git and tsgit report the status of a modified backslash-named file', () => {
      it('Then both list the same path', async () => {
        // Arrange
        const gitRepo = await dirtyTwin('git');
        const tsgitRepo = await dirtyTwin('tsgit');
        const sut = status;

        // Act
        const result = await sut(createNodeContext({ workDir: tsgitRepo }));

        // Assert
        expect(result.changes.map((change) => change.path)).toEqual(porcelainPaths(gitRepo));
        expect(result.untracked).toEqual([]);
      });
    });

    describe.each([
      { label: 'an escaped backslash', spec: 'a\\\\b', stayed: false },
      { label: 'a question mark', spec: 'a?', stayed: true },
    ])('When git and tsgit restore a modified backslash-named file by $label', (row) => {
      it('Then both leave the same content', async () => {
        // Arrange
        const gitRepo = await dirtyTwin('git');
        const tsgitRepo = await dirtyTwin('tsgit');
        const sut = checkout;

        // Act
        runGit(['-C', gitRepo, 'checkout', '--', row.spec]);
        await sut(createNodeContext({ workDir: tsgitRepo }), { paths: [row.spec] });

        // Assert
        const gitContent = await readFile(path.join(gitRepo, 'a\\b'), 'utf8');
        expect(gitContent === 'dirty').toBe(row.stayed);
        expect(await readFile(path.join(tsgitRepo, 'a\\b'), 'utf8')).toBe(gitContent);
      });
    });

    describe.each([
      { label: 'a pathspec', paths: ['a??'] },
      { label: 'no pathspec', paths: [] },
    ])('When git and tsgit grep the working tree with $label', (row) => {
      it('Then both list the backslash-named file', async () => {
        // Arrange
        const gitRepo = await dirtyTwin('git');
        const tsgitRepo = await dirtyTwin('tsgit');
        const sut = grep;

        // Act
        const result = await sut(createNodeContext({ workDir: tsgitRepo }), {
          patterns: [/./],
          paths: row.paths,
        });

        // Assert
        const gitListed = splitNames(
          runGit([
            '-C',
            gitRepo,
            'grep',
            '-l',
            '-z',
            '.',
            ...(row.paths.length ? ['--', ...row.paths] : []),
          ]),
        ).sort();
        expect(result.paths.map((entry) => entry.path).sort()).toEqual(gitListed);
        expect(gitListed).toContain('a\\b');
      });
    });
  },
);

describe.skipIf(process.platform !== 'win32')(
  'Given a pathspec holding a backslash on a Windows host',
  () => {
    describe('When tsgit adds it', () => {
      it('Then it is refused as outside the repository', async () => {
        // Arrange
        const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-backslash-win-')));
        runGit(['init', '-q', '-b', 'main', dir]);
        const sut = add;
        let caught: unknown;

        // Act
        try {
          await sut(createNodeContext({ workDir: dir }), ['a\\b']);
        } catch (err) {
          caught = err;
        }
        await removeTree(dir, { recursive: true, force: true });

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'PATHSPEC_OUTSIDE_REPO',
          path: 'a\\b',
        });
      });
    });
  },
);
