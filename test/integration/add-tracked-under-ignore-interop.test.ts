/**
 * Cross-tool interop — `add` stages a modified tracked file whatever the ignore
 * rules say, as git's index-side pass does: a tracked file that an ignore rule
 * matches, or that sits under an ignored directory, is restaged by `add <glob>`,
 * `add .`, `add <dir>` and `add -A`; skip-worktree and clean entries are left
 * alone and a file replaced by a directory is staged as removed.
 *
 * @proves
 *   surface:        add
 *   bucket:         cross-tool-interop
 *   unique:         tracked files hidden by ignore rules are restaged as git does
 *   interopSurface: add
 */
import { mkdir, mkdtemp, realpath, rm as removeTree, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const PINNED_DATE = '@1700000000 +0000';

type Files = Readonly<Record<string, string>>;
type Setup = (repo: string) => Promise<void>;

const snapshotOf = (repo: string) => ({
  index: runGit(['-C', repo, 'ls-files', '-s']),
  status: runGit(['-C', repo, 'status', '--porcelain', '--untracked-files=all']),
});

const writeFiles = async (repo: string, files: Files): Promise<void> => {
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await writeFile(path.join(repo, name), body);
  }
};

const commitAll = (repo: string): void => {
  runGit(['-C', repo, 'add', '-A']);
  runGit(['-C', repo, '-c', 'user.name=A', '-c', 'user.email=a@a', 'commit', '-qm', 'c'], {
    env: { ...runGitEnv(), GIT_AUTHOR_DATE: PINNED_DATE, GIT_COMMITTER_DATE: PINNED_DATE },
  });
};

/** Commits `files`, then lays `.gitignore` and the working-tree edits down. */
const trackedThen =
  (files: Files, rules: string, edits: Files): Setup =>
  async (repo) => {
    await writeFiles(repo, files);
    commitAll(repo);
    await writeFiles(repo, { '.gitignore': rules, ...edits });
  };

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'add over tracked files that ignore rules hide from the walk',
  () => {
    let root = '';
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-add-hidden-')));
    });

    afterAll(async () => {
      await removeTree(root, { recursive: true, force: true });
    });

    const twins = async (setup: Setup) => {
      counter += 1;
      const gitRepo = path.join(root, `git-${counter}`);
      const tsgitRepo = path.join(root, `tsgit-${counter}`);
      for (const repo of [gitRepo, tsgitRepo]) {
        runGit(['init', '-q', '-b', 'main', repo]);
        await setup(repo);
      }
      return { gitRepo, tsgitRepo };
    };

    const gitIgnore = (rules: string) => rules;

    describe.each([
      {
        label: 'a modified file matched by an ignore glob, added by glob',
        setup: trackedThen({ 'x.log': 'a\n' }, gitIgnore('*.log\n'), { 'x.log': 'bb\n' }),
        spec: ['*.log'],
      },
      {
        label: 'a modified file matched by an ignore glob, added literally',
        setup: trackedThen({ 'x.log': 'a\n' }, gitIgnore('*.log\n'), { 'x.log': 'bb\n' }),
        spec: ['x.log'],
      },
      {
        label: 'a modified file under an ignored directory, added by dot',
        setup: trackedThen({ 'd/x.txt': 'a\n', k: 'k\n' }, gitIgnore('d/\n'), {
          'd/x.txt': 'bb\n',
        }),
        spec: ['.'],
      },
      {
        label: 'a modified file under an ignored directory, added by glob',
        setup: trackedThen({ 'd/x.txt': 'a\n', k: 'k\n' }, gitIgnore('d/\n'), {
          'd/x.txt': 'bb\n',
        }),
        spec: ['*.txt'],
      },
      {
        label: 'a modified file under an ignored directory, added by directory',
        setup: trackedThen({ 'd/x.txt': 'a\n', k: 'k\n' }, gitIgnore('d/\n'), {
          'd/x.txt': 'bb\n',
        }),
        spec: ['d'],
      },
      {
        label: 'a clean file matched by an ignore glob',
        setup: trackedThen({ 'x.log': 'a\n' }, gitIgnore('*.log\n'), {}),
        spec: ['*.log'],
      },
      {
        label: 'a file replaced by a directory under an ignore glob',
        setup: async (repo: string) => {
          await trackedThen({ 'x.log': 'a\n' }, gitIgnore('*.log\n'), {})(repo);
          await removeTree(path.join(repo, 'x.log'));
          await writeFiles(repo, { 'x.log/inner': 'i\n' });
        },
        spec: ['*.log'],
      },
      {
        label: 'an intent-to-add file matched by an ignore glob',
        setup: async (repo: string) => {
          await writeFiles(repo, { 'x.log': 'a\n', k: 'k\n' });
          runGit(['-C', repo, 'add', 'k']);
          runGit(['-C', repo, 'add', '-N', 'x.log']);
          await writeFiles(repo, { '.gitignore': '*.log\n', 'x.log': 'bb\n' });
        },
        spec: ['*.log'],
      },
      {
        label: 'an intent-to-add file under an ignored directory',
        setup: async (repo: string) => {
          await writeFiles(repo, { 'd/x.txt': 'a\n', k: 'k\n' });
          runGit(['-C', repo, 'add', 'k']);
          runGit(['-C', repo, 'add', '-N', 'd/x.txt']);
          await writeFiles(repo, { '.gitignore': 'd/\n', 'd/x.txt': 'bb\n' });
        },
        spec: ['.'],
      },
      {
        label: 'a skip-worktree file that was modified under an ignore glob, added by dot',
        setup: async (repo: string) => {
          await trackedThen({ 'x.log': 'a\n', k: 'k\n' }, gitIgnore('*.log\n'), {
            'x.log': 'bb\n',
          })(repo);
          runGit(['-C', repo, 'update-index', '--skip-worktree', 'x.log']);
        },
        spec: ['.'],
      },
    ])('Given $label', ({ setup, spec }) => {
      describe('When git and tsgit add it', () => {
        it('Then both leave the same index and status', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(setup);
          const sut = add;

          // Act
          tryRunGitWithExit(['-C', gitRepo, 'add', '--', ...spec]);
          await sut(createNodeContext({ workDir: tsgitRepo }), spec);

          // Assert
          expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
        });
      });
    });

    describe('Given a skip-worktree file that was modified under an ignore glob', () => {
      describe('When git and tsgit add the glob', () => {
        it('Then neither stages anything', async () => {
          // Arrange
          const setup: Setup = async (repo) => {
            await trackedThen({ 'x.log': 'a\n', k: 'k\n' }, gitIgnore('*.log\n'), {
              'x.log': 'bb\n',
            })(repo);
            runGit(['-C', repo, 'update-index', '--skip-worktree', 'x.log']);
          };
          const { gitRepo, tsgitRepo } = await twins(setup);
          const before = runGit(['-C', gitRepo, 'ls-files', '-s']);
          const sut = add;

          // Act
          const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '--', '*.log']);
          await sut(createNodeContext({ workDir: tsgitRepo }), ['*.log']).catch(
            (error: unknown) => error,
          );

          // Assert
          expect(gitRun.exitCode).toBe(1);
          expect(runGit(['-C', gitRepo, 'ls-files', '-s'])).toBe(before);
          expect(runGit(['-C', tsgitRepo, 'ls-files', '-s'])).toBe(before);
        });
      });
    });

    describe.each([
      {
        label: 'a modified file under an ignored directory',
        setup: trackedThen({ 'd/x.txt': 'a\n' }, gitIgnore('d/\n'), { 'd/x.txt': 'bb\n' }),
      },
      {
        label: 'a modified file matched by an ignore glob',
        setup: trackedThen({ 'x.log': 'a\n' }, gitIgnore('*.log\n'), { 'x.log': 'bb\n' }),
      },
    ])('Given $label', ({ setup }) => {
      describe('When git add -A and tsgit add all run', () => {
        it('Then both leave the same index and status', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(setup);
          const sut = add;

          // Act
          runGit(['-C', gitRepo, 'add', '-A']);
          await sut(createNodeContext({ workDir: tsgitRepo }), [], { all: true });

          // Assert
          expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
        });
      });
    });

    describe('Given a retargeted tracked symlink matched by an ignore glob', () => {
      describe('When git and tsgit add the glob', () => {
        it('Then both leave the same index and status', async () => {
          // Arrange
          const setup: Setup = async (repo) => {
            await symlink('first', path.join(repo, 'l.log'));
            commitAll(repo);
            await removeTree(path.join(repo, 'l.log'));
            await symlink('second', path.join(repo, 'l.log'));
            await writeFiles(repo, { '.gitignore': '*.log\n' });
          };
          const { gitRepo, tsgitRepo } = await twins(setup);
          const sut = add;

          // Act
          runGit(['-C', gitRepo, 'add', '--', '*.log']);
          await sut(createNodeContext({ workDir: tsgitRepo }), ['*.log']);

          // Assert
          expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
        });
      });
    });
  },
);
