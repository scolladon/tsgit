/**
 * Interop — a plain directory standing where the index holds a regular file, a symlink or an
 * unmerged path. git's `check_removed` (status, stash, rm) reads it as removed; its
 * `verify_uptodate` (checkout, merge, cherry-pick) reads it as a change and refuses. Each row
 * seeds two identical repositories, runs one operation in canonical git and in tsgit, and
 * compares the report, the index and what is left on disk.
 *
 * @proves
 *   surface:        repo.status, repo.rm, repo.stash.push, repo.checkout, repo.merge.run, repo.cherryPick.run, repo.rebase.run
 *   bucket:         worktree
 *   unique:         a directory at a tracked non-gitlink path reads removed to status/rm/stash and changed to the overwrite check, as canonical git does
 *   interopSurface: status, rm, stash, checkout, merge, sequencer
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TsgitError } from '../../src/domain/index.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  lsStage,
  makePeerPair,
  type PeerPair,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';
import { COMMIT_ENV } from './occupant-displacement-fixtures.js';
import { trackedRepositories } from './repository-lifecycle.js';

const AUTHOR = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;
const ROW_TIMEOUT = 60_000;
const NO_WORKTREE_MODE = '000000';
const TRACKED = 'm';
const SIDE = 'side';
const GIT_FATAL_EXIT = 128;

const open = trackedRepositories();

const sh = (dir: string, ...args: ReadonlyArray<string>): string =>
  runGit(['-C', dir, ...args], { env: COMMIT_ENV });

type Kind = 'regular' | 'symlink';
const KINDS: ReadonlyArray<Kind> = ['regular', 'symlink'];

const writeTracked = (dir: string, kind: Kind, variant: string): void =>
  kind === 'symlink'
    ? symlinkSync(`target-${variant}`, join(dir, TRACKED))
    : writeFileSync(join(dir, TRACKED), `${variant}\n`);

/** `main` tracks `m`; `side` rewrites it (or adds a bystander); `m` is then a directory on `main`. */
const seedTwin = (
  dir: string,
  ignoreCase: string,
  kind: Kind,
  sideTouchesTracked: boolean,
): void => {
  sh(dir, 'config', 'core.ignorecase', ignoreCase);
  writeFileSync(join(dir, 'base'), 'base\n');
  writeTracked(dir, kind, 'one');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'base');
  sh(dir, 'checkout', '-q', '-b', SIDE);
  if (sideTouchesTracked) {
    rmSync(join(dir, TRACKED));
    writeTracked(dir, kind, 'two');
  } else {
    writeFileSync(join(dir, 'bystander'), 'b\n');
  }
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'side');
  sh(dir, 'checkout', '-q', 'main');
  rmSync(join(dir, TRACKED));
  mkdirSync(join(dir, TRACKED));
  writeFileSync(join(dir, TRACKED, 'inner'), 'inner\n');
};

/** `m` is assume-unchanged and a directory stands at it; `side` and `main` both moved on. */
const seedAssumeUnchanged = (
  dir: string,
  ignoreCase: string,
  fileMode: string,
  sideTouchesTracked: boolean,
): void => {
  sh(dir, 'config', 'core.ignorecase', ignoreCase);
  sh(dir, 'config', 'core.filemode', fileMode);
  writeFileSync(join(dir, 'base'), 'base\n');
  writeFileSync(join(dir, TRACKED), 'one\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'base');
  sh(dir, 'checkout', '-q', '-b', SIDE);
  if (sideTouchesTracked) writeFileSync(join(dir, TRACKED), 'two\n');
  else writeFileSync(join(dir, 'bystander'), 'b\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'side');
  sh(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'c'), 'c\n');
  sh(dir, 'add', 'c');
  sh(dir, 'commit', '-q', '-m', 'main2');
  sh(dir, 'update-index', '--assume-unchanged', TRACKED);
  rmSync(join(dir, TRACKED));
  mkdirSync(join(dir, TRACKED));
  writeFileSync(join(dir, TRACKED, 'inner'), 'inner\n');
};

const stashCount = (dir: string): number =>
  sh(dir, 'stash', 'list').split('\n').filter(Boolean).length;

const gitUnstagedRows = (dir: string): ReadonlyArray<string> =>
  sh(dir, 'status', '--porcelain=v2', '-uno')
    .split('\n')
    .filter((line) => line.startsWith('1 '))
    .map((line) => line.split(' '))
    .map((cols) => `${cols[1]} ${cols[2]} ${cols[3]} ${cols[4]} ${cols[5]} ${cols[8]}`);

const COLUMN: Readonly<Record<string, string>> = {
  deleted: 'D',
  modified: 'M',
  'type-changed': 'T',
};

const tsgitUnstagedRows = async (repo: Repository): Promise<ReadonlyArray<string>> =>
  (await repo.status()).changes.map(
    (change) =>
      `.${change.unstaged === undefined ? '.' : COLUMN[change.unstaged]} N... ${change.head?.mode} ${change.index?.mode} ${change.worktree?.mode ?? NO_WORKTREE_MODE} ${change.path}`,
  );

interface Attempt {
  readonly status: 'ok' | 'refused';
  readonly data?: unknown;
}

const attempt = async (run: () => Promise<unknown>): Promise<Attempt> => {
  try {
    await run();
    return { status: 'ok' };
  } catch (err) {
    if (err instanceof TsgitError) return { status: 'refused', data: err.data };
    throw err;
  }
};

const gitAttempt = (dir: string, ...args: ReadonlyArray<string>): 'ok' | 'refused' =>
  tryRunGitWithExit(['-C', dir, ...args], { env: COMMIT_ENV }).exitCode === 0 ? 'ok' : 'refused';

const onDisk = (dir: string): string => {
  const stat = lstatSync(join(dir, TRACKED));
  if (stat.isSymbolicLink()) return 'symlink';
  if (!stat.isDirectory()) return 'file';
  return `directory:${readdirSync(join(dir, TRACKED)).sort().join(',')}`;
};

describe.skipIf(!GIT_AVAILABLE)('directory at a tracked path interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('directory-at-tracked-path');
    for (const dir of [pair.peer, pair.ours]) {
      runGit(['init', '-q', '-b', 'main', dir]);
      sh(dir, 'config', 'user.name', 'Ada');
      sh(dir, 'config', 'user.email', 'ada@example.com');
    }
  });

  afterEach(async () => {
    await pair.dispose();
  });

  const seedBoth = (ignoreCase: string, kind: Kind, sideTouchesTracked = true): void => {
    seedTwin(pair.peer, ignoreCase, kind, sideTouchesTracked);
    seedTwin(pair.ours, ignoreCase, kind, sideTouchesTracked);
  };

  describe.each(['false', 'true'] as const)('core.ignorecase=%s in both twins', (ignoreCase) => {
    describe.each(KINDS)('Given a tracked %s replaced by a directory', (kind) => {
      describe('When both tools report the status', () => {
        it(
          'Then both report the path deleted with no work-tree mode',
          async () => {
            // Arrange
            seedBoth(ignoreCase, kind);
            const sut = await open({ cwd: pair.ours });

            // Act
            const result = await tsgitUnstagedRows(sut);

            // Assert
            expect(result).toEqual(gitUnstagedRows(pair.peer));
            expect(result).toHaveLength(1);
            expect(result[0]?.startsWith('.D')).toBe(true);
          },
          ROW_TIMEOUT,
        );
      });

      describe('When both tools stash push', () => {
        it(
          'Then both save the stash with the index entry kept and replace the directory the same way',
          async () => {
            // Arrange
            seedBoth(ignoreCase, kind);
            const sut = await open({ cwd: pair.ours });

            // Act
            const gitRun = gitAttempt(pair.peer, 'stash', 'push');
            const result = await attempt(() => sut.stash.push({}));

            // Assert
            expect(result.status).toBe(gitRun);
            expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
            expect(sh(pair.ours, 'ls-tree', '-r', 'stash@{0}^{tree}')).toBe(
              sh(pair.peer, 'ls-tree', '-r', 'stash@{0}^{tree}'),
            );
            expect(onDisk(pair.ours)).toBe(onDisk(pair.peer));
          },
          ROW_TIMEOUT,
        );
      });

      describe.each([
        ['rm', {}],
        ['rm -f', { force: true }],
      ] as const)('When both tools %s it', (_label, options) => {
        it(
          'Then neither removes the index entry or the directory',
          async () => {
            // Arrange
            seedBoth(ignoreCase, kind);
            const sut = await open({ cwd: pair.ours });

            // Act
            const gitExit = tryRunGitWithExit(
              ['-C', pair.peer, 'rm', '-q', ...('force' in options ? ['-f'] : []), TRACKED],
              { env: COMMIT_ENV },
            ).exitCode;
            const gitRun = gitExit === 0 ? 'ok' : 'refused';
            const result = await attempt(() => sut.rm([TRACKED], options));

            // Assert
            expect(gitRun).toBe('refused');
            expect(gitExit).toBe(GIT_FATAL_EXIT);
            expect(result.data).toMatchObject({ code: 'CHECKOUT_OVERWRITE_DIRTY' });
            expect(result.status).toBe(gitRun);
            expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
            expect(onDisk(pair.ours)).toBe(onDisk(pair.peer));
          },
          ROW_TIMEOUT,
        );
      });

      describe('When both tools rm --cached it', () => {
        it(
          'Then both drop the index entry and keep the directory',
          async () => {
            // Arrange
            seedBoth(ignoreCase, kind);
            const sut = await open({ cwd: pair.ours });

            // Act
            const gitRun = gitAttempt(pair.peer, 'rm', '-q', '--cached', TRACKED);
            const result = await attempt(() => sut.rm([TRACKED], { cached: true }));

            // Assert
            expect(result.status).toBe(gitRun);
            expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
            expect(onDisk(pair.ours)).toBe(onDisk(pair.peer));
          },
          ROW_TIMEOUT,
        );
      });

      describe.each([
        [
          'checkout',
          (repo: Repository) => repo.checkout({ rev: SIDE }),
          ['checkout', SIDE],
          'CHECKOUT_OVERWRITE_DIRTY',
        ],
        [
          'merge',
          (repo: Repository) => repo.merge.run({ rev: SIDE, message: 'm', author: AUTHOR }),
          ['merge', '-m', 'm', SIDE],
          'WORKING_TREE_DIRTY',
        ],
        [
          'cherry-pick',
          (repo: Repository) => repo.cherryPick.run({ commits: [SIDE] }),
          ['cherry-pick', SIDE],
          'WORKING_TREE_DIRTY',
        ],
        [
          'rebase',
          (repo: Repository) => repo.rebase.run({ upstream: SIDE }),
          ['rebase', SIDE],
          'WORKING_TREE_DIRTY',
        ],
      ] as const)(
        'When both tools %s a branch rewriting the path',
        (_label, run, gitArgs, refusalCode) => {
          it(
            'Then both refuse and leave the index and the directory alone',
            async () => {
              // Arrange
              seedBoth(ignoreCase, kind);
              const sut = await open({ cwd: pair.ours });
              const indexBefore = lsStage(pair.ours);

              // Act
              const gitRun = gitAttempt(pair.peer, ...gitArgs);
              const result = await attempt(() => run(sut));

              // Assert
              expect(gitRun).toBe('refused');
              expect(result.status).toBe('refused');
              expect(result.data).toMatchObject({ code: refusalCode, localChanges: [TRACKED] });
              expect(lsStage(pair.ours)).toBe(indexBefore);
              expect(lsStage(pair.peer)).toBe(indexBefore);
              expect(onDisk(pair.ours)).toBe('directory:inner');
            },
            ROW_TIMEOUT,
          );
        },
      );

      describe('When both tools check out a branch leaving the path alone', () => {
        it(
          'Then both switch and keep the directory and the index entry',
          async () => {
            // Arrange
            seedBoth(ignoreCase, kind, false);
            const sut = await open({ cwd: pair.ours });

            // Act
            const gitRun = gitAttempt(pair.peer, 'checkout', SIDE);
            const result = await attempt(() => sut.checkout({ rev: SIDE }));

            // Assert
            expect(gitRun).toBe('ok');
            expect(result.status).toBe('ok');
            expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
            expect(existsSync(join(pair.ours, TRACKED, 'inner'))).toBe(true);
          },
          ROW_TIMEOUT,
        );
      });
    });

    describe.each(['false', 'true'] as const)(
      'Given an assume-unchanged file replaced by a directory under core.fileMode=%s',
      (fileMode) => {
        const seedAssumed = (sideTouchesTracked: boolean): void => {
          seedAssumeUnchanged(pair.peer, ignoreCase, fileMode, sideTouchesTracked);
          seedAssumeUnchanged(pair.ours, ignoreCase, fileMode, sideTouchesTracked);
        };

        describe('When both tools report the status', () => {
          it(
            'Then both trust the entry and report nothing',
            async () => {
              // Arrange
              seedAssumed(true);
              const sut = await open({ cwd: pair.ours });

              // Act
              const result = await tsgitUnstagedRows(sut);

              // Assert
              expect(result).toEqual(gitUnstagedRows(pair.peer));
              expect(result).toEqual([]);
            },
            ROW_TIMEOUT,
          );
        });

        describe('When both tools stash push', () => {
          it(
            'Then neither saves a stash and the directory with its content survives',
            async () => {
              // Arrange
              seedAssumed(true);
              const sut = await open({ cwd: pair.ours });
              const indexBefore = lsStage(pair.ours);

              // Act
              const gitRun = gitAttempt(pair.peer, 'stash', 'push');
              const result = await attempt(() => sut.stash.push({}));

              // Assert
              expect(result.status).toBe(gitRun);
              expect(stashCount(pair.peer)).toBe(0);
              expect(stashCount(pair.ours)).toBe(0);
              expect(lsStage(pair.ours)).toBe(indexBefore);
              expect(lsStage(pair.peer)).toBe(indexBefore);
              expect(onDisk(pair.ours)).toBe('directory:inner');
              expect(onDisk(pair.peer)).toBe('directory:inner');
            },
            ROW_TIMEOUT,
          );
        });

        describe('When both tools rebase onto a branch leaving the path alone', () => {
          it(
            'Then both pass the clean-tree pre-flight and keep the directory',
            async () => {
              // Arrange
              seedAssumed(false);
              const sut = await open({ cwd: pair.ours });

              // Act
              const gitRun = gitAttempt(pair.peer, 'rebase', SIDE);
              const result = await attempt(() => sut.rebase.run({ upstream: SIDE }));

              // Assert
              expect(gitRun).toBe('ok');
              expect(result.status).toBe('ok');
              expect(onDisk(pair.ours)).toBe(onDisk(pair.peer));
              expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
            },
            ROW_TIMEOUT,
          );
        });

        describe('When both tools check out a branch rewriting the path', () => {
          it(
            'Then both refuse and leave the index and the directory alone',
            async () => {
              // Arrange
              seedAssumed(true);
              const sut = await open({ cwd: pair.ours });
              const indexBefore = lsStage(pair.ours);

              // Act
              const gitRun = gitAttempt(pair.peer, 'checkout', SIDE);
              const result = await attempt(() => sut.checkout({ rev: SIDE }));

              // Assert
              expect(gitRun).toBe('refused');
              expect(result.status).toBe('refused');
              expect(result.data).toMatchObject({
                code: 'CHECKOUT_OVERWRITE_DIRTY',
                localChanges: [TRACKED],
              });
              expect(lsStage(pair.ours)).toBe(indexBefore);
              expect(onDisk(pair.ours)).toBe('directory:inner');
            },
            ROW_TIMEOUT,
          );
        });
      },
    );

    describe.each([
      ['a regular file stage', '100755'],
      ['a gitlink stage', '160000'],
    ] as const)('Given an unmerged path with %s replaced by a directory', (_label, oursMode) => {
      describe('When both tools report the status', () => {
        it(
          'Then neither reports a work-tree mode',
          async () => {
            // Arrange
            for (const dir of [pair.peer, pair.ours]) {
              sh(dir, 'config', 'core.ignorecase', ignoreCase);
              const oid = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], {
                env: COMMIT_ENV,
                input: 'blob\n',
              }).trim();
              const ours = oursMode === '160000' ? 'a'.repeat(40) : oid;
              runGit(['-C', dir, 'update-index', '--index-info'], {
                env: COMMIT_ENV,
                input: `100644 ${oid} 1\t${TRACKED}\n${oursMode} ${ours} 2\t${TRACKED}\n100644 ${oid} 3\t${TRACKED}\n`,
              });
              mkdirSync(join(dir, TRACKED));
              writeFileSync(join(dir, TRACKED, 'inner'), 'inner\n');
            }
            const sut = await open({ cwd: pair.ours });

            // Act
            const status = await sut.status();
            const gitLine = sh(pair.peer, 'status', '--porcelain=v2')
              .split('\n')
              .find((line) => line.startsWith('u '));

            // Assert
            expect(gitLine?.split(' ')[6]).toBe(NO_WORKTREE_MODE);
            expect(status.unmerged).toHaveLength(1);
            expect(status.unmerged[0]?.worktree).toBeUndefined();
          },
          ROW_TIMEOUT,
        );
      });
    });
  });
});
