/**
 * Cross-tool interop — a gitlink leaving the index only asks `rmdir` to remove its path, so a
 * file or symlink standing there survives and a populated directory is kept, exactly as real git
 * leaves them. tsgit is driven through the same fixtures and compared with git's own outcome;
 * warnings are rebuilt from tsgit's logger, never asked for as text.
 *
 * @proves
 *   surface:        repo.reset, repo.checkout, repo.stash.push, repo.stash.apply, repo.merge.run, repo.cherryPick.run, repo.revert.run
 *   bucket:         cross-tool-interop
 *   unique:         a gitlink leaving the index only calls rmdir on its path and keeps a file or symlink standing there as canonical git does
 *   interopSurface: checkout
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  git,
  lsStage,
  makePeerPair,
  type PeerPair,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';
import { COMMIT_ENV, outcomeOfGitStderr } from './occupant-displacement-fixtures.js';

const GITLINK_PATH = 'new';
const PRECIOUS = 'precious\n';
const RMDIR_WARNING = 'unable to rmdir';

type Placement = 'index-only' | 'in-head';
type Occupant = 'file' | 'symlink' | 'dir' | 'emptydir';
type Op = 'reset-hard' | 'checkout-f' | 'stash-push' | 'stash-push-u';
type TargetOp = 'T1' | 'T2' | 'T3' | 'T4' | 'T5';

const occupantAt = (p: string): string => {
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (st === undefined) return 'absent';
  if (st.isSymbolicLink()) return `symlink->${readlinkSync(p)}`;
  if (st.isFile()) return `file:${readFileSync(p, 'utf8')}`;
  return st.isDirectory() ? `dir:${readdirSync(p).sort().join(',')}` : 'other';
};

const commit = (dir: string, message: string): void => {
  runGit(['-C', dir, 'commit', '-q', '-m', message], { env: COMMIT_ENV });
};

const initTwin = (dir: string, ignorecase: string): void => {
  runGit(['init', '-q', '-b', 'main', dir]);
  git(dir, 'config', 'core.ignorecase', ignorecase);
  git(dir, 'config', 'user.name', 'p');
  git(dir, 'config', 'user.email', 'p@p');
  git(dir, 'config', 'commit.gpgsign', 'false');
};

const placeOccupant = (dir: string, occupant: Occupant, name = GITLINK_PATH): void => {
  const target = path.join(dir, name);
  rmSync(target, { recursive: true, force: true });
  if (occupant === 'file') writeFileSync(target, PRECIOUS);
  if (occupant === 'symlink') symlinkSync('a.txt', target);
  if (occupant === 'emptydir') mkdirSync(target);
  if (occupant === 'dir') {
    mkdirSync(target);
    writeFileSync(path.join(target, 'x'), 'x\n');
  }
};

const stageGitlink = (dir: string): void => {
  const oid = git(dir, 'rev-parse', 'HEAD').trim();
  git(dir, 'update-index', '--add', '--cacheinfo', `160000,${oid},${GITLINK_PATH}`);
};

const buildIndexed = (
  dir: string,
  ignorecase: string,
  placement: Placement,
  occupant: Occupant,
): void => {
  initTwin(dir, ignorecase);
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', 'a.txt');
  commit(dir, 'base');
  git(dir, 'branch', 'base');
  stageGitlink(dir);
  if (placement === 'in-head') commit(dir, 'gitlink');
  placeOccupant(dir, occupant);
  writeFileSync(path.join(dir, 'a.txt'), 'edited\n');
};

const buildRemoval = (
  dir: string,
  ignorecase: string,
  diverged: boolean,
  occupant: Occupant,
): void => {
  initTwin(dir, ignorecase);
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', 'a.txt');
  commit(dir, 'base');
  git(dir, 'branch', 'base');
  stageGitlink(dir);
  commit(dir, 'gitlink');
  git(dir, 'branch', 'G');
  git(dir, 'checkout', '-q', '-b', 'rmg');
  git(dir, 'rm', '-q', '--cached', GITLINK_PATH);
  commit(dir, 'drop');
  git(dir, 'checkout', '-q', 'main');
  if (diverged) {
    writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    git(dir, 'add', 'b.txt');
    commit(dir, 'b');
  }
  placeOccupant(dir, occupant);
};

interface Snapshot {
  readonly occupant: string;
  readonly stage: string;
  readonly status: string;
  readonly succeeded: boolean;
  readonly warnings: ReadonlyArray<string>;
}

const snapshotOf = (
  dir: string,
  succeeded: boolean,
  warnings: ReadonlyArray<string>,
  at = GITLINK_PATH,
): Snapshot => ({
  occupant: occupantAt(path.join(dir, at)),
  stage: lsStage(dir),
  status: tryRunGitWithExit(['-C', dir, 'status', '--porcelain=v1', '-uall']).stdout,
  succeeded,
  warnings,
});

const gitWarnings = (stderr: string): string[] =>
  stderr.split('\n').filter((l) => l.includes(RMDIR_WARNING));

interface Twin {
  readonly git: Snapshot;
  readonly tsgit: Snapshot;
  readonly gitStderr: string;
  readonly tsgitError: unknown;
}

const runGitTwin = (dir: string, args: ReadonlyArray<string>) =>
  tryRunGitWithExit(['-C', dir, ...args], { env: COMMIT_ENV });

const runTsgitTwin = async (
  dir: string,
  act: (repo: Repository) => Promise<unknown>,
  at = GITLINK_PATH,
): Promise<{ snapshot: Snapshot; error: unknown }> => {
  const warnings: string[] = [];
  const repo = await openRepository({
    cwd: dir,
    logger: { warn: (m: string) => warnings.push(m) },
  });
  let error: unknown;
  try {
    await act(repo);
  } catch (err) {
    error = err;
  } finally {
    await repo.dispose();
  }
  const reported = warnings.filter((w) => w.includes(RMDIR_WARNING)).map((w) => `warning: ${w}`);
  return { snapshot: snapshotOf(dir, error === undefined, reported, at), error };
};

const compareTwins = async (
  pair: PeerPair,
  gitArgs: ReadonlyArray<string>,
  act: (repo: Repository) => Promise<unknown>,
  at = GITLINK_PATH,
): Promise<Twin> => {
  const result = runGitTwin(pair.peer, gitArgs);
  const ours = await runTsgitTwin(pair.ours, act, at);
  return {
    git: snapshotOf(pair.peer, result.exitCode === 0, gitWarnings(result.stderr), at),
    tsgit: ours.snapshot,
    gitStderr: result.stderr,
    tsgitError: ours.error,
  };
};

const OPS: Readonly<
  Record<
    Op,
    { git: (t: string) => string[]; tsgit: (t: string) => (repo: Repository) => Promise<unknown> }
  >
> = {
  'reset-hard': {
    git: (t) => ['reset', '--hard', t],
    tsgit: (t) => (repo) => repo.reset({ mode: 'hard', rev: t }),
  },
  'checkout-f': {
    git: (t) => ['checkout', '-f', '--detach', t],
    tsgit: (t) => (repo) => repo.checkout({ rev: t, force: true, detach: true }),
  },
  'stash-push': {
    git: () => ['stash', 'push'],
    tsgit: () => (repo) => repo.stash.push({}),
  },
  'stash-push-u': {
    git: () => ['stash', 'push', '-u'],
    tsgit: () => (repo) => repo.stash.push({ includeUntracked: true }),
  },
};

const OP_NAMES = Object.keys(OPS) as Op[];
const PLACEMENTS: Placement[] = ['index-only', 'in-head'];
const OCCUPANTS: Occupant[] = ['file', 'symlink', 'dir', 'emptydir'];
const isStash = (op: Op): boolean => op.startsWith('stash');
const isKeptOccupantRow = (placement: Placement, occupant: Occupant): boolean =>
  placement === 'index-only' && (occupant === 'file' || occupant === 'symlink');

const STASH_REF_PROBE = ['rev-parse', '-q', '--verify', 'stash^3'];
const UNTRACKED_TREE_PROBE = ['rev-parse', '-q', '--verify', 'stash^3^{tree}'];

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'gitlink removal occupant interop',
  () => {
    describe.each(['false', 'true'] as const)(
      'Given core.ignorecase=%s in both twins',
      (ignorecase) => {
        let pair: PeerPair;
        beforeEach(async () => {
          pair = await makePeerPair('gitlink-removal-occupant');
        });
        afterEach(async () => {
          await pair.dispose();
        });

        describe.each(OP_NAMES)('When %s runs over a path indexed as a gitlink', (op) => {
          const cells = PLACEMENTS.flatMap((placement) =>
            OCCUPANTS.map((occupant) => ({ placement, occupant })),
          );
          it.each(cells)(
            'Then $placement with a $occupant at its path ends as git ends',
            async ({ placement, occupant }) => {
              // Arrange
              buildIndexed(pair.peer, ignorecase, placement, occupant);
              buildIndexed(pair.ours, ignorecase, placement, occupant);
              const target = placement === 'in-head' ? 'base' : 'HEAD';

              // Act
              const result = await compareTwins(pair, OPS[op].git(target), OPS[op].tsgit(target));

              // Assert
              expect(result.tsgit).toEqual(result.git);
              if (isKeptOccupantRow(placement, occupant)) {
                expect(result.git.occupant).not.toBe('absent');
              }
              if (isStash(op)) {
                expect(runGitTwin(pair.ours, STASH_REF_PROBE).exitCode).toBe(
                  runGitTwin(pair.peer, STASH_REF_PROBE).exitCode,
                );

                if (op === 'stash-push-u') {
                  expect(runGitTwin(pair.ours, UNTRACKED_TREE_PROBE).stdout).toBe(
                    runGitTwin(pair.peer, UNTRACKED_TREE_PROBE).stdout,
                  );
                }
              }
            },
          );

          const applyCells = cells.filter(
            ({ placement, occupant }) =>
              isStash(op) &&
              !(placement === 'index-only' && occupant === 'dir' && op === 'stash-push'),
          );
          it.each(applyCells)(
            'Then stash apply after it, $placement with a $occupant at the path, ends as git ends',
            async ({ placement, occupant }) => {
              // Arrange
              buildIndexed(pair.peer, ignorecase, placement, occupant);
              buildIndexed(pair.ours, ignorecase, placement, occupant);
              const target = placement === 'in-head' ? 'base' : 'HEAD';
              await compareTwins(pair, OPS[op].git(target), OPS[op].tsgit(target));

              // Act
              const result = await compareTwins(pair, ['stash', 'apply'], (repo) =>
                repo.stash.apply(),
              );

              // Assert
              expect(result.tsgit).toEqual(result.git);
              if (isKeptOccupantRow(placement, occupant)) {
                expect(result.git.succeeded).toBe(false);
                expect(result.tsgitError).toBeInstanceOf(TsgitError);
                const data = (result.tsgitError as TsgitError).data;
                expect(data).toMatchObject({
                  code: 'STASH_APPLY_WOULD_OVERWRITE',
                  paths: [GITLINK_PATH],
                  untracked: [GITLINK_PATH],
                });
                expect(outcomeOfGitStderr(result.gitStderr).untracked).toEqual([GITLINK_PATH]);
              }
            },
          );
        });

        describe.each(PLACEMENTS)(
          'Given a %s gitlink over a populated directory and an untracked u.txt, When stash push -u runs',
          (placement) => {
            it('Then it collects only u.txt and keeps the directory as git does', async () => {
              // Arrange
              const build = (dir: string): void => {
                buildIndexed(dir, ignorecase, placement, 'dir');
                writeFileSync(path.join(dir, 'u.txt'), 'u\n');
              };
              build(pair.peer);
              build(pair.ours);
              const untrackedTree = (dir: string): string =>
                tryRunGitWithExit(['-C', dir, 'ls-tree', '-r', '--name-only', 'stash^3']).stdout;

              // Act
              const result = await compareTwins(pair, OPS['stash-push-u'].git('HEAD'), (repo) =>
                repo.stash.push({ includeUntracked: true }),
              );

              // Assert
              expect(result.tsgit).toEqual(result.git);
              expect(untrackedTree(pair.ours)).toBe(untrackedTree(pair.peer));
              expect(untrackedTree(pair.peer)).toBe('u.txt\n');
              expect(result.git.occupant).toBe('dir:x');
              expect(existsSync(path.join(pair.ours, 'u.txt'))).toBe(false);
            });
          },
        );

        describe.each(['file', 'symlink'] as const)(
          'Given a %s at the path of a gitlink a branch change removes',
          (occupant) => {
            const TARGET_OPS: ReadonlyArray<{
              id: TargetOp;
              diverged: boolean;
              git: string[];
              tsgit: (repo: Repository) => Promise<unknown>;
            }> = [
              {
                id: 'T1',
                diverged: false,
                git: ['checkout', 'base'],
                tsgit: (repo) => repo.checkout({ rev: 'base' }),
              },
              {
                id: 'T2',
                diverged: false,
                git: ['merge', '--ff-only', 'rmg'],
                tsgit: (repo) => repo.merge.run({ rev: 'rmg', fastForward: 'only' }),
              },
              {
                id: 'T3',
                diverged: true,
                git: ['merge', '--no-edit', 'rmg'],
                tsgit: (repo) => repo.merge.run({ rev: 'rmg' }),
              },
              {
                id: 'T4',
                diverged: true,
                git: ['cherry-pick', 'rmg'],
                tsgit: (repo) => repo.cherryPick.run({ commits: ['rmg'] }),
              },
              {
                id: 'T5',
                diverged: true,
                git: ['revert', '--no-edit', 'G'],
                tsgit: (repo) => repo.revert.run({ commits: ['G'] }),
              },
            ];
            it.each(TARGET_OPS)('Then $id keeps it as git does', async (row) => {
              // Arrange
              buildRemoval(pair.peer, ignorecase, row.diverged, occupant);
              buildRemoval(pair.ours, ignorecase, row.diverged, occupant);

              // Act
              const result = await compareTwins(pair, row.git, row.tsgit);

              // Assert
              expect(result.tsgit).toEqual(result.git);
              expect(result.git.occupant).not.toBe('absent');
            });
          },
        );

        describe.each(['file', 'symlink'] as const)(
          'Given a %s at a gitlink path in a linked worktree, When reset --hard runs',
          (occupant) => {
            it('Then it keeps the occupant as git does', async () => {
              // Arrange
              const build = (root: string): string => {
                const main = path.join(root, 'main');
                mkdirSync(main);
                initTwin(main, ignorecase);
                writeFileSync(path.join(main, 'a.txt'), 'a\n');
                git(main, 'add', 'a.txt');
                commit(main, 'base');
                git(main, 'worktree', 'add', '-q', '-b', 'side', '../wt');
                const wt = path.join(root, 'wt');
                stageGitlink(wt);
                placeOccupant(wt, occupant);
                return wt;
              };
              const peerWt = build(pair.peer);
              const oursWt = build(pair.ours);
              const gitRun = runGitTwin(peerWt, ['reset', '--hard', 'HEAD']);

              // Act
              const ours = await runTsgitTwin(oursWt, (repo) =>
                repo.reset({ mode: 'hard', rev: 'HEAD' }),
              );

              // Assert
              expect(ours.snapshot).toEqual(
                snapshotOf(peerWt, gitRun.exitCode === 0, gitWarnings(gitRun.stderr)),
              );
              expect(ours.snapshot.occupant).not.toBe('absent');
            });
          },
        );
      },
    );
  },
);
