/**
 * Cross-tool interop — an added gitlink takes the directory standing at its path instead of
 * refusing it as untracked, exactly as real git does, while a file at that path still refuses.
 * tsgit is driven through the same fixtures and compared with git's own outcome.
 *
 * @proves
 *   surface:        repo.checkout, repo.merge.run, repo.cherryPick.run, repo.stash.apply
 *   bucket:         cross-tool-interop
 *   unique:         an added gitlink takes a directory standing at its path instead of refusing it as untracked, as canonical git does
 *   interopSurface: merge
 */
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
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

type Occupant = 'dir' | 'file';

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

const placeOccupant = (dir: string, occupant: Occupant): void => {
  const target = path.join(dir, GITLINK_PATH);
  rmSync(target, { recursive: true, force: true });
  if (occupant === 'file') {
    writeFileSync(target, PRECIOUS);
    return;
  }
  mkdirSync(target);
  writeFileSync(path.join(target, 'x'), 'x\n');
};

const stageGitlink = (dir: string): void => {
  const oid = git(dir, 'rev-parse', 'HEAD').trim();
  git(dir, 'update-index', '--add', '--cacheinfo', `160000,${oid},${GITLINK_PATH}`);
};

interface Shape {
  readonly diverged: boolean;
  readonly conflicting: boolean;
  readonly occupant: Occupant;
  readonly secondHead?: boolean;
}

const buildAdded = (dir: string, ignorecase: string, shape: Shape): void => {
  initTwin(dir, ignorecase);
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  writeFileSync(path.join(dir, 'c.txt'), 'c\n');
  git(dir, 'add', '.');
  commit(dir, 'base');
  git(dir, 'checkout', '-q', '-b', 'G');
  stageGitlink(dir);
  if (shape.conflicting) {
    writeFileSync(path.join(dir, 'c.txt'), 'theirs\n');
    git(dir, 'add', 'c.txt');
  }
  commit(dir, 'gitlink');
  if (shape.secondHead === true) {
    git(dir, 'checkout', '-q', '-b', 'H2', 'main');
    writeFileSync(path.join(dir, 'd.txt'), 'd\n');
    git(dir, 'add', 'd.txt');
    commit(dir, 'second head');
  }
  git(dir, 'checkout', '-q', 'main');
  rmSync(path.join(dir, GITLINK_PATH), { recursive: true, force: true });
  if (shape.conflicting) {
    writeFileSync(path.join(dir, 'c.txt'), 'ours\n');
    git(dir, 'add', 'c.txt');
  }
  if (shape.diverged || shape.conflicting) {
    writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    git(dir, 'add', 'b.txt');
    commit(dir, 'b');
  }
  placeOccupant(dir, shape.occupant);
};

const buildStashed = (dir: string, ignorecase: string): void => {
  initTwin(dir, ignorecase);
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', 'a.txt');
  commit(dir, 'base');
  stageGitlink(dir);
  placeOccupant(dir, 'dir');
  writeFileSync(path.join(dir, 'a.txt'), 'edited\n');
  runGit(['-C', dir, 'stash', 'push'], { env: COMMIT_ENV });
  placeOccupant(dir, 'dir');
};

const MODIFIED_GITLINK = '0123456789abcdef0123456789abcdef01234567';

// The theirs branch moves the gitlink while ours drops it: a modify/delete conflict on a gitlink.
const buildModifyDelete = (dir: string, ignorecase: string): void => {
  initTwin(dir, ignorecase);
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', 'a.txt');
  commit(dir, 'base');
  stageGitlink(dir);
  commit(dir, 'gitlink');
  git(dir, 'checkout', '-q', '-b', 'T');
  git(dir, 'update-index', '--cacheinfo', `160000,${MODIFIED_GITLINK},${GITLINK_PATH}`);
  commit(dir, 'move');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'rm', '-q', '--cached', GITLINK_PATH);
  commit(dir, 'drop');
  placeOccupant(dir, 'dir');
};

interface Snapshot {
  readonly occupant: string;
  readonly stage: string;
  readonly status: string;
  readonly succeeded: boolean;
  readonly subject: string;
}

const snapshotOf = (dir: string, succeeded: boolean): Snapshot => ({
  occupant: occupantAt(path.join(dir, GITLINK_PATH)),
  stage: lsStage(dir),
  status: tryRunGitWithExit(['-C', dir, 'status', '--porcelain=v1', '-uall']).stdout,
  succeeded,
  subject: tryRunGitWithExit(['-C', dir, 'log', '-1', '--format=%s']).stdout,
});

interface Twin {
  readonly git: Snapshot;
  readonly tsgit: Snapshot;
  readonly gitStderr: string;
  readonly tsgitError: unknown;
  readonly tsgitResult: unknown;
}

const compareTwins = async (
  pair: PeerPair,
  gitArgs: ReadonlyArray<string>,
  act: (repo: Repository) => Promise<unknown>,
): Promise<Twin> => {
  const gitRun = tryRunGitWithExit(['-C', pair.peer, ...gitArgs], { env: COMMIT_ENV });
  const repo = await openRepository({ cwd: pair.ours });
  let error: unknown;
  let tsgitResult: unknown;
  try {
    tsgitResult = await act(repo);
  } catch (err) {
    error = err;
  } finally {
    await repo.dispose();
  }
  return {
    git: snapshotOf(pair.peer, gitRun.exitCode === 0),
    tsgit: snapshotOf(pair.ours, error === undefined),
    gitStderr: gitRun.stderr,
    tsgitError: error,
    tsgitResult,
  };
};

const PLAIN: Shape = { diverged: false, conflicting: false, occupant: 'dir' };
const DIVERGED: Shape = { diverged: true, conflicting: false, occupant: 'dir' };
const CONFLICTING: Shape = { diverged: false, conflicting: true, occupant: 'dir' };

interface Row {
  readonly id: string;
  readonly shape: Shape;
  readonly git: string[];
  readonly tsgit: (repo: Repository) => Promise<unknown>;
}

const ROWS: ReadonlyArray<Row> = [
  {
    id: 'A1 checkout',
    shape: PLAIN,
    git: ['checkout', 'G'],
    tsgit: (repo) => repo.checkout({ rev: 'G' }),
  },
  {
    id: 'A2 merge ff-only',
    shape: PLAIN,
    git: ['merge', '--ff-only', 'G'],
    tsgit: (repo) => repo.merge.run({ rev: 'G', fastForward: 'only' }),
  },
  {
    id: 'A3 merge',
    shape: DIVERGED,
    git: ['merge', '--no-edit', 'G'],
    tsgit: (repo) => repo.merge.run({ rev: 'G' }),
  },
  {
    id: 'A3r merge -s resolve',
    shape: DIVERGED,
    git: ['merge', '-s', 'resolve', '--no-edit', 'G'],
    tsgit: (repo) => repo.merge.run({ rev: 'G', strategy: 'resolve' }),
  },
  {
    id: 'A3o octopus merge',
    shape: { ...DIVERGED, secondHead: true },
    git: ['merge', '--no-edit', 'G', 'H2'],
    tsgit: (repo) => repo.merge.run({ rev: ['G', 'H2'] }),
  },
  {
    id: 'A4 cherry-pick',
    shape: DIVERGED,
    git: ['cherry-pick', 'G'],
    tsgit: (repo) => repo.cherryPick.run({ commits: ['G'] }),
  },
];

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'gitlink added over a directory interop',
  () => {
    describe.each(['false', 'true'] as const)(
      'Given core.ignorecase=%s in both twins',
      (ignorecase) => {
        let pair: PeerPair;
        beforeEach(async () => {
          pair = await makePeerPair('gitlink-added-over-directory');
        });
        afterEach(async () => {
          await pair.dispose();
        });

        describe('When a command adds a gitlink over a directory standing at its path', () => {
          it.each(ROWS)(
            'Then $id keeps the directory and stages the gitlink as git does',
            async (row) => {
              // Arrange
              buildAdded(pair.peer, ignorecase, row.shape);
              buildAdded(pair.ours, ignorecase, row.shape);

              // Act
              const result = await compareTwins(pair, row.git, row.tsgit);

              // Assert
              expect(result.tsgit).toEqual(result.git);
              expect(result.git.succeeded).toBe(true);
              expect(result.git.stage).toContain(`160000`);
              expect(result.git.occupant).toBe('dir:x');
            },
          );

          it('Then a conflicted merge keeps the directory and stages the gitlink as git does', async () => {
            // Arrange
            buildAdded(pair.peer, ignorecase, CONFLICTING);
            buildAdded(pair.ours, ignorecase, CONFLICTING);

            // Act
            const result = await compareTwins(pair, ['merge', '--no-edit', 'G'], (repo) =>
              repo.merge.run({ rev: 'G' }),
            );

            // Assert
            expect(result.git.succeeded).toBe(false);
            expect(result.tsgitError).toBeUndefined();
            expect(result.tsgitResult).toMatchObject({ kind: 'conflict' });
            expect({ ...result.tsgit, succeeded: false }).toEqual(result.git);
            expect(result.git.stage).toContain(`160000`);
            expect(result.git.occupant).toBe('dir:x');
          });

          it('Then stash apply keeps the directory and stages the gitlink as git does', async () => {
            // Arrange
            buildStashed(pair.peer, ignorecase);
            buildStashed(pair.ours, ignorecase);

            // Act
            const result = await compareTwins(pair, ['stash', 'apply'], (repo) =>
              repo.stash.apply(),
            );

            // Assert
            expect(result.tsgit).toEqual(result.git);
            expect(result.git.succeeded).toBe(true);
            expect(result.git.stage).toContain(`160000`);
            expect(result.git.occupant).toBe('dir:x');
          });
        });

        describe('When a modify/delete conflict leaves a gitlink over a directory standing at its path', () => {
          it.each([
            {
              id: 'merge',
              git: ['merge', '--no-edit', 'T'],
              tsgit: (repo: Repository) => repo.merge.run({ rev: 'T' }),
            },
            {
              id: 'cherry-pick',
              git: ['cherry-pick', 'T'],
              tsgit: (repo: Repository) => repo.cherryPick.run({ commits: ['T'] }),
            },
          ])(
            'Then $id keeps the directory and stages both gitlink sides as git does',
            async (row) => {
              // Arrange
              buildModifyDelete(pair.peer, ignorecase);
              buildModifyDelete(pair.ours, ignorecase);

              // Act
              const result = await compareTwins(pair, row.git, row.tsgit);

              // Assert
              expect(result.git.succeeded).toBe(false);
              expect(result.tsgitError).toBeUndefined();
              expect({ ...result.tsgit, succeeded: false }).toEqual(result.git);
              expect(result.git.stage).toContain(`160000 ${MODIFIED_GITLINK} 3`);
              expect(result.git.occupant).toBe('dir:x');
            },
          );
        });

        describe('When checkout adds a gitlink over a file standing at its path', () => {
          it('Then it refuses as untracked and changes nothing as git does', async () => {
            // Arrange
            const shape: Shape = { ...PLAIN, occupant: 'file' };
            buildAdded(pair.peer, ignorecase, shape);
            buildAdded(pair.ours, ignorecase, shape);

            // Act
            const result = await compareTwins(pair, ['checkout', 'G'], (repo) =>
              repo.checkout({ rev: 'G' }),
            );

            // Assert
            expect(result.tsgit).toEqual(result.git);
            expect(result.git.succeeded).toBe(false);
            expect(result.git.occupant).toBe(`file:${PRECIOUS}`);
            expect(outcomeOfGitStderr(result.gitStderr).untracked).toEqual([GITLINK_PATH]);
            expect(result.tsgitError).toBeInstanceOf(TsgitError);
            expect((result.tsgitError as TsgitError).data).toMatchObject({
              code: 'CHECKOUT_OVERWRITE_DIRTY',
              localChanges: [],
              untracked: [GITLINK_PATH],
            });
          });
        });
      },
    );
  },
);
