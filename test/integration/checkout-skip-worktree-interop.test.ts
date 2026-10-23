/**
 * Cross-tool interop — a path restore from the index or from HEAD leaves
 * skip-worktree entries out of the pathspec's universe, as git's
 * `checkout -- <paths>` does: a pathspec that only they name is refused, and a
 * pathspec that also names a plain file restores that file alone.
 *
 * @proves
 *   surface:        checkout
 *   bucket:         cross-tool-interop
 *   unique:         a path restore leaves skip-worktree paths as git does
 *   interopSurface: checkout
 */
import { mkdtemp, readFile, realpath, rm as removeTree, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { TsgitError } from '../../src/domain/index.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const PINNED_DATE = '@1700000000 +0000';
const UNMATCHED_LINE = /^error: pathspec '(.*)' did not match any file\(s\) known to git$/;

const snapshotOf = async (repo: string) => ({
  flags: runGit(['-C', repo, 'ls-files', '-v']),
  sw: await readFile(path.join(repo, 'sw.txt'), 'utf8'),
  n: await readFile(path.join(repo, 'n.txt'), 'utf8'),
});

const unmatchedOf = (stderr: string): string[] =>
  stderr.split('\n').flatMap((line) => UNMATCHED_LINE.exec(line)?.[1] ?? []);

const refusedPatterns = async (run: () => Promise<unknown>): Promise<string[]> => {
  try {
    await run();
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'PATHSPEC_NO_MATCH') {
      return [...err.data.patterns];
    }
    throw err;
  }
  return [];
};

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'checkout path restore over skip-worktree entries',
  () => {
    let root = '';
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-checkout-sw-')));
    });

    afterAll(async () => {
      await removeTree(root, { recursive: true, force: true });
    });

    const setUp = async (repo: string): Promise<void> => {
      runGit(['init', '-q', '-b', 'main', repo]);
      await writeFile(path.join(repo, 'sw.txt'), 'sw');
      await writeFile(path.join(repo, 'n.txt'), 'n');
      runGit(['-C', repo, 'add', '-A']);
      runGit(['-C', repo, '-c', 'user.name=A', '-c', 'user.email=a@a', 'commit', '-qm', 'c'], {
        env: { ...runGitEnv(), GIT_AUTHOR_DATE: PINNED_DATE, GIT_COMMITTER_DATE: PINNED_DATE },
      });
      runGit(['-C', repo, 'update-index', '--skip-worktree', 'sw.txt']);
      await writeFile(path.join(repo, 'sw.txt'), 'sw-dirty');
      await writeFile(path.join(repo, 'n.txt'), 'n-dirty');
    };

    const twins = async () => {
      counter += 1;
      const gitRepo = path.join(root, `git-${counter}`);
      const tsgitRepo = path.join(root, `tsgit-${counter}`);
      await setUp(gitRepo);
      await setUp(tsgitRepo);
      return { gitRepo, tsgitRepo };
    };

    const setUpTwoCommits = async (repo: string): Promise<void> => {
      const env = { ...runGitEnv(), GIT_AUTHOR_DATE: PINNED_DATE, GIT_COMMITTER_DATE: PINNED_DATE };
      const commitAll = (message: string) => {
        runGit(['-C', repo, 'add', '-A']);
        runGit(
          ['-C', repo, '-c', 'user.name=A', '-c', 'user.email=a@a', 'commit', '-qm', message],
          {
            env,
          },
        );
      };
      runGit(['init', '-q', '-b', 'main', repo]);
      await writeFile(path.join(repo, 'sw.txt'), 'sw-v1');
      await writeFile(path.join(repo, 'n.txt'), 'n-v1');
      commitAll('first');
      await writeFile(path.join(repo, 'sw.txt'), 'sw-v2');
      await writeFile(path.join(repo, 'n.txt'), 'n-v2');
      commitAll('second');
      runGit(['-C', repo, 'update-index', '--skip-worktree', 'sw.txt']);
      await writeFile(path.join(repo, 'sw.txt'), 'sw-dirty');
      await writeFile(path.join(repo, 'n.txt'), 'n-dirty');
    };

    /** HEAD~1 holds `sw.txt` as a regular file, HEAD as an executable one with the same blob; skip-worktree and dirty. */
    const setUpModeOnly = async (repo: string): Promise<void> => {
      const env = { ...runGitEnv(), GIT_AUTHOR_DATE: PINNED_DATE, GIT_COMMITTER_DATE: PINNED_DATE };
      const commitAll = (message: string) =>
        runGit(
          ['-C', repo, '-c', 'user.name=A', '-c', 'user.email=a@a', 'commit', '-qm', message],
          { env },
        );
      runGit(['init', '-q', '-b', 'main', repo]);
      await writeFile(path.join(repo, 'sw.txt'), 'sw-v1\n');
      await writeFile(path.join(repo, 'n.txt'), 'n\n');
      runGit(['-C', repo, 'add', '-A']);
      commitAll('first');
      runGit(['-C', repo, 'update-index', '--chmod=+x', 'sw.txt']);
      commitAll('second');
      runGit(['-C', repo, 'update-index', '--skip-worktree', 'sw.txt']);
      await writeFile(path.join(repo, 'sw.txt'), 'sw-dirty');
    };

    const stagedSnapshotOf = async (repo: string) => ({
      ...(await snapshotOf(repo)),
      staged: runGit(['-C', repo, 'ls-files', '-s']),
    });

    describe.each([{ spec: ['sw.txt'] }, { spec: ['sw*'] }, { spec: ['sw.txt', 'n.txt'] }])(
      'Given a skip-worktree file whose blob differs in HEAD~1',
      ({ spec }) => {
        describe(`When ${JSON.stringify(spec)} is restored from HEAD~1`, () => {
          it('Then git and tsgit write the file, stage the source blob and clear the bit', async () => {
            // Arrange
            counter += 1;
            const gitRepo = path.join(root, `git-${counter}`);
            const tsgitRepo = path.join(root, `tsgit-${counter}`);
            await setUpTwoCommits(gitRepo);
            await setUpTwoCommits(tsgitRepo);
            const sut = checkout;

            // Act
            const gitRun = tryRunGitWithExit(['-C', gitRepo, 'checkout', 'HEAD~1', '--', ...spec]);
            await sut(createNodeContext({ workDir: tsgitRepo }), { paths: spec, source: 'HEAD~1' });

            // Assert
            expect(gitRun.exitCode).toBe(0);
            expect(await readFile(path.join(gitRepo, 'sw.txt'), 'utf8')).toBe('sw-v1');
            expect(runGit(['-C', gitRepo, 'ls-files', '-v'])).toContain('H sw.txt');
            expect(await stagedSnapshotOf(tsgitRepo)).toEqual(await stagedSnapshotOf(gitRepo));
          });
        });
      },
    );

    describe('Given a skip-worktree file whose blob equals HEAD~1 but whose mode differs', () => {
      describe('When it is restored from HEAD~1', () => {
        it('Then git and tsgit write the file, stage the source mode and clear the bit', async () => {
          // Arrange
          counter += 1;
          const gitRepo = path.join(root, `git-${counter}`);
          const tsgitRepo = path.join(root, `tsgit-${counter}`);
          await setUpModeOnly(gitRepo);
          await setUpModeOnly(tsgitRepo);
          const sut = checkout;

          // Act
          const gitRun = tryRunGitWithExit(['-C', gitRepo, 'checkout', 'HEAD~1', '--', 'sw.txt']);
          await sut(createNodeContext({ workDir: tsgitRepo }), {
            paths: ['sw.txt'],
            source: 'HEAD~1',
          });

          // Assert
          expect(gitRun.exitCode).toBe(0);
          expect(runGit(['-C', gitRepo, 'ls-files', '-s', 'sw.txt'])).toContain('100644');
          expect(runGit(['-C', gitRepo, 'ls-files', '-v'])).toContain('H sw.txt');
          expect(await readFile(path.join(gitRepo, 'sw.txt'), 'utf8')).toBe('sw-v1\n');
          expect(await stagedSnapshotOf(tsgitRepo)).toEqual(await stagedSnapshotOf(gitRepo));
        });
      });
    });

    describe.each([
      { sourceLabel: 'the index', source: undefined },
      { sourceLabel: 'HEAD', source: 'HEAD' },
    ])('Given a restore from $sourceLabel', ({ source }) => {
      describe.each([
        { spec: ['sw*'] },
        { spec: ['sw.txt'] },
        { spec: ['sw.txt', 'n.txt'] },
        { spec: ['sw*', 'n*'] },
      ])('When a refused pathspec $spec is restored', ({ spec }) => {
        it('Then git and tsgit refuse the same patterns and leave the same files', async () => {
          // Arrange
          const { gitRepo, tsgitRepo } = await twins();
          const sut = checkout;

          // Act
          const gitRun = tryRunGitWithExit([
            '-C',
            gitRepo,
            'checkout',
            ...(source === undefined ? [] : [source]),
            '--',
            ...spec,
          ]);
          const patterns = await refusedPatterns(() =>
            sut(createNodeContext({ workDir: tsgitRepo }), {
              paths: spec,
              ...(source === undefined ? {} : { source }),
            }),
          );

          // Assert
          expect(gitRun.exitCode).toBe(1);
          expect(patterns).toEqual(unmatchedOf(gitRun.stderr));
          expect(await snapshotOf(tsgitRepo)).toEqual(await snapshotOf(gitRepo));
        });
      });

      describe.each([{ spec: ['*.txt'] }, { spec: ['.'] }])(
        'When the accepted pathspec $spec is restored',
        ({ spec }) => {
          it('Then git and tsgit restore the plain file alone', async () => {
            // Arrange
            const { gitRepo, tsgitRepo } = await twins();
            const sut = checkout;

            // Act
            const gitRun = tryRunGitWithExit([
              '-C',
              gitRepo,
              'checkout',
              ...(source === undefined ? [] : [source]),
              '--',
              ...spec,
            ]);
            await sut(createNodeContext({ workDir: tsgitRepo }), {
              paths: spec,
              ...(source === undefined ? {} : { source }),
            });

            // Assert
            expect(gitRun.exitCode).toBe(0);
            expect(await snapshotOf(tsgitRepo)).toEqual(await snapshotOf(gitRepo));
          });
        },
      );
    });
  },
);
