/**
 * Cross-tool interop — `add` leaves a skip-worktree entry alone and reports the
 * pathspec that reached it, as git does: the walk, the literal fast path,
 * `--renormalize` and `-A` keep the entry's bit and blob, a report is exit 1 in
 * git and a non-empty `sparse` here, and an unmatched pathspec beside a sparse
 * one is still refused.
 *
 * @proves
 *   surface:        add
 *   bucket:         cross-tool-interop
 *   unique:         skip-worktree entries stay unstaged and sparse-only pathspecs are reported as git does
 *   interopSurface: add
 */
import { mkdir, mkdtemp, readdir, realpath, rm as removeTree, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const PINNED_DATE = '@1700000000 +0000';

type Files = Readonly<Record<string, string>>;
type Setup = (repo: string) => Promise<void>;

const ADVICE_HEAD = [
  'The following paths and/or pathspecs matched paths that exist',
  'outside of your sparse-checkout definition, so will not be',
  'updated in the index:',
];
const ADVICE_TAIL = [
  'hint: If you intend to update such entries, try one of the following:',
  'hint: * Use the --sparse option.',
  'hint: * Disable or modify the sparsity rules.',
  'hint: Disable this message with "git config set advice.updateSparsePath false"',
];

const adviceOf = (sparse: ReadonlyArray<string>): string =>
  `${[...ADVICE_HEAD, ...sparse, ...ADVICE_TAIL].join('\n')}\n`;

const looseObjectCount = async (repo: string): Promise<number> => {
  const objects = path.join(repo, '.git', 'objects');
  const fanoutDirs = (await readdir(objects)).filter((name) => /^[0-9a-f]{2}$/.test(name));
  const counts = await Promise.all(
    fanoutDirs.map(async (fanout) => (await readdir(path.join(objects, fanout))).length),
  );
  return counts.reduce((sum, count) => sum + count, 0);
};

const snapshotOf = async (repo: string) => ({
  index: runGit(['-C', repo, 'ls-files', '-s', '-v']),
  status: runGit(['-C', repo, 'status', '--porcelain', '--untracked-files=all']),
  loose: await looseObjectCount(repo),
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

/** Commits `files`, marks `x.log` (and `y.log` when tracked) skip-worktree, then rewrites `edits`. */
const sparseThen =
  (files: Files, skipped: ReadonlyArray<string>, edits: Files): Setup =>
  async (repo) => {
    await writeFiles(repo, files);
    commitAll(repo);
    for (const name of skipped) runGit(['-C', repo, 'update-index', '--skip-worktree', name]);
    await writeFiles(repo, edits);
  };

const FIXTURE: Files = { 'x.log': 'old\n', k: 'k\n', 's.txt': 's\n' };
const REWRITTEN: Files = { 'x.log': 'changed\n', 's.txt': 's2\n' };
const standard: Setup = sparseThen(FIXTURE, ['x.log'], REWRITTEN);
const deleted: Setup = async (repo) => {
  await sparseThen(FIXTURE, ['x.log'], { 's.txt': 's2\n' })(repo);
  await removeTree(path.join(repo, 'x.log'));
};
const twoSparse: Setup = sparseThen({ ...FIXTURE, 'y.log': 'old\n' }, ['x.log', 'y.log'], {
  ...REWRITTEN,
  'y.log': 'changed\n',
});
const onlySparse: Setup = sparseThen({ 'x.log': 'old\n' }, ['x.log'], { 'x.log': 'changed\n' });

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'add over skip-worktree entries',
  () => {
    let root = '';
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-add-sparse-')));
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

    describe.each([
      { label: 'the whole tree', setup: standard, flags: [], spec: ['.'], reported: false },
      {
        label: 'a wildcard reaching only it',
        setup: standard,
        flags: [],
        spec: ['*.log'],
        reported: true,
      },
      { label: 'its name', setup: standard, flags: [], spec: ['x.log'], reported: true },
      {
        label: 'a prefix wildcard reaching only it',
        setup: standard,
        flags: [],
        spec: ['x*'],
        reported: true,
      },
      {
        label: 'a sparse wildcard beside another file',
        setup: standard,
        flags: [],
        spec: ['*.log', 's.txt'],
        reported: true,
      },
      {
        label: 'its name beside another file',
        setup: standard,
        flags: [],
        spec: ['x.log', 's.txt'],
        reported: true,
      },
      {
        label: 'two wildcards, one reaching only it',
        setup: standard,
        flags: [],
        spec: ['x*', 's*'],
        reported: true,
      },
      {
        label: 'a wildcard also reaching other files',
        setup: standard,
        flags: [],
        spec: ['*'],
        reported: false,
      },
      {
        label: 'the whole tree with -A',
        setup: standard,
        flags: ['-A'],
        spec: [],
        reported: false,
      },
      {
        label: 'the whole tree, it being deleted',
        setup: deleted,
        flags: [],
        spec: ['.'],
        reported: false,
      },
      {
        label: 'its name, it being deleted',
        setup: deleted,
        flags: [],
        spec: ['x.log'],
        reported: true,
      },
      { label: '-A, it being deleted', setup: deleted, flags: ['-A'], spec: [], reported: false },
      {
        label: 'the whole tree with --renormalize',
        setup: standard,
        flags: ['--renormalize'],
        spec: ['.'],
        reported: false,
      },
      {
        label: 'its name with --renormalize',
        setup: standard,
        flags: ['--renormalize'],
        spec: ['x.log'],
        reported: true,
      },
      {
        label: 'several sparse pathspecs in argument order',
        setup: twoSparse,
        flags: [],
        spec: ['y*', 'x*', '*.log', 'x.log'],
        reported: true,
      },
      {
        label: 'one sparse wildcard twice',
        setup: standard,
        flags: [],
        spec: ['*.log', '*.log'],
        reported: true,
      },
      {
        label: 'the whole tree holding only a skip-worktree file',
        setup: onlySparse,
        flags: [],
        spec: ['.'],
        reported: true,
      },
    ])('Given a skip-worktree file and $label', ({ setup, flags, spec, reported }) => {
      describe('When git and tsgit add it', () => {
        it('Then both leave the same index, status and objects, and report alike', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(setup);
          const sut = add;
          const all = flags.includes('-A');
          const renormalize = flags.includes('--renormalize');

          // Act
          const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', ...flags, '--', ...spec]);
          const result = await sut(createNodeContext({ workDir: tsgitRepo }), spec, {
            all,
            renormalize,
          });

          // Assert
          expect(await snapshotOf(tsgitRepo)).toEqual(await snapshotOf(gitRepo));
          expect(gitRun.exitCode).toBe(reported ? 1 : 0);
          expect(result.sparse.length > 0).toBe(reported);
          expect(gitRun.stderr).toBe(reported ? adviceOf(result.sparse) : '');
        });
      });
    });

    describe('Given a skip-worktree file and a pathspec matching nothing', () => {
      describe('When git and tsgit add them', () => {
        it('Then both refuse the unmatched pathspec alone and write nothing', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins(standard);
          const sut = add;
          const spec = ['x.log', 'nomatch*'];

          // Act
          const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '--', ...spec]);
          const thrown = await sut(createNodeContext({ workDir: tsgitRepo }), spec).catch(
            (error: unknown) => error,
          );

          // Assert
          expect(gitRun.exitCode).toBe(128);
          expect(gitRun.stderr).toBe("fatal: pathspec 'nomatch*' did not match any files\n");
          expect(thrown).toMatchObject({
            data: { code: 'PATHSPEC_NO_MATCH', pattern: 'nomatch*' },
          });
          expect(await snapshotOf(tsgitRepo)).toEqual(await snapshotOf(gitRepo));
        });
      });
    });
  },
);
