/**
 * Cross-tool interop — `merge --abort` reflog faithfulness. A conflicted merge
 * never advances HEAD, so the abort resets to the (unchanged) tip: git records no
 * branch reflog entry (needs-commit no-move skip) and logs `reset: moving to HEAD`
 * on the coupled `HEAD` symref — the literal `HEAD`, not the oid, because
 * `merge --abort` delegates to a `reset` whose rev argument is `HEAD`. This pins
 * `repo.merge.abort` to that exact message + branch-skip against real `git`.
 *
 * @proves
 *   surface:        repo.merge.abort
 *   bucket:         cross-tool-interop
 *   unique:         merge --abort HEAD reflog message matches canonical git
 *   interopSurface: reflog
 */
import { existsSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  git,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
  topReflogSubject,
  tryRunGit,
  tryRunGitWithExit,
} from './interop-helpers.js';
import {
  COMMIT_ENV,
  directoryHolding,
  fileAt,
  gitlink,
  ignoring,
  indexState,
  listing,
  type Occupant,
  OK,
  type Outcome,
  regular,
  replacing,
  v1,
} from './occupant-displacement-fixtures.js';
import {
  ABORT_ROWS,
  buildStoppedMerge,
  entriesOf,
  firstClassified,
} from './stopped-state-fixtures.js';

const AUTHOR = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

const FIXED_DATE = '1700000000 +0000';

const configGit = (dir: string): void => {
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
};

const gitCommit = (dir: string, message: string): void => {
  runGit(['-C', dir, 'commit', '-q', '-m', message, '--author', 'Ada <ada@example.com>'], {
    env: { ...runGitEnv(), GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE },
  });
};

/**
 * Build identical pinned history where `feature` and `main` both re-edit the same
 * line of `f.txt` off a shared `base`, so merging `feature` into `main` conflicts.
 */
const buildConflictingMerge = (dir: string): void => {
  runGit(['init', '-q', '-b', 'main', dir]);
  configGit(dir);
  writeFileSync(path.join(dir, 'f.txt'), 'base\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'base');
  git(dir, 'branch', 'feature');
  writeFileSync(path.join(dir, 'f.txt'), 'MAIN\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'on-main');
  git(dir, 'checkout', '-q', 'feature');
  writeFileSync(path.join(dir, 'f.txt'), 'FEATURE\n');
  git(dir, 'add', 'f.txt');
  gitCommit(dir, 'on-feature');
  git(dir, 'checkout', '-q', 'main');
};

describe.skipIf(!GIT_AVAILABLE)('merge --abort reflog interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('merge-abort');
  });
  afterEach(async () => {
    await pair.dispose();
  });

  describe('Given a conflicted merge aborted on both tools', () => {
    describe('When merge --abort runs on both tools', () => {
      it('Then HEAD records `reset: moving to HEAD` and the branch reflog is unchanged', async () => {
        // Arrange — identical pinned conflicting-merge history in both repos.
        buildConflictingMerge(pair.peer);
        buildConflictingMerge(pair.ours);
        const peerBranchTop = topReflogSubject(pair.peer, 'refs/heads/main');
        const oursBranchTop = topReflogSubject(pair.ours, 'refs/heads/main');

        // Conflict on both tools (merge stops, HEAD unmoved).
        const peerMerge = tryRunGit(['-C', pair.peer, 'merge', 'feature']);
        expect(peerMerge.ok).toBe(false);
        const repo = await openRepository({ cwd: pair.ours });
        const oursMerge = await repo.merge.run({ rev: 'feature', author: AUTHOR });
        expect(oursMerge.kind).toBe('conflict');

        // Act — abort on both tools.
        runGit(['-C', pair.peer, 'merge', '--abort']);
        await repo.merge.abort();
        await repo.dispose();

        // Assert — identical faithful HEAD message, branch reflog left untouched.
        expect(topReflogSubject(pair.peer, 'HEAD')).toBe('reset: moving to HEAD');
        expect(topReflogSubject(pair.ours, 'HEAD')).toBe('reset: moving to HEAD');
        expect(topReflogSubject(pair.peer, 'refs/heads/main')).toBe(peerBranchTop);
        expect(topReflogSubject(pair.ours, 'refs/heads/main')).toBe(oursBranchTop);
      });
    });
  });
});

const gitOutcomeOfAbort = (dir: string): Outcome => {
  const result = tryRunGitWithExit(['-C', dir, 'merge', '--abort']);
  if (result.exitCode === 0) return OK;
  if (result.exitCode !== 128)
    throw new Error(`unexpected exit ${result.exitCode}: ${result.stderr}`);
  return firstClassified(result.stderr);
};

const tsgitOutcomeOfAbort = async (repo: Repository): Promise<Outcome> => {
  try {
    await repo.merge.abort();
    return OK;
  } catch (err) {
    if (!(err instanceof TsgitError)) throw err;
    const data = err.data;
    if (data.code !== 'WORKING_TREE_DIRTY') {
      return { refused: true, crash: data.code, localChanges: [], untracked: [] };
    }
    return { refused: true, localChanges: data.localChanges, untracked: data.untracked };
  }
};

const stopTsgitMerge = async (
  repo: Repository,
  extra: { autostash?: boolean } = {},
): Promise<void> => {
  const result = await repo.merge.run({ rev: 't', author: AUTHOR, ...extra });
  expect(result.kind).toBe('conflict');
};

const stopGitMerge = (dir: string, ...extra: ReadonlyArray<string>): void => {
  const result = tryRunGit(['-C', dir, 'merge', ...extra, 't'], { env: COMMIT_ENV });
  expect(result.ok).toBe(false);
};

const gitState = (dir: string): ReadonlyArray<unknown> => [
  listing(dir),
  indexState(dir),
  runGit(['-C', dir, 'rev-parse', 'HEAD']),
  existsSync(path.join(dir, '.git', 'MERGE_HEAD')),
  existsSync(path.join(dir, '.git', 'ORIG_HEAD')),
  existsSync(path.join(dir, '.git', 'MERGE_AUTOSTASH')),
  tryRunGit(['-C', dir, 'stash', 'list']).stdout,
];

describe.skipIf(!GIT_AVAILABLE)('merge --abort occupant interop', { timeout: 60_000 }, () => {
  let pair: PeerPair;
  let repo: Repository | undefined;

  beforeEach(async () => {
    pair = await makePeerPair('merge-abort-occupant');
    initBothRepos(pair.peer, pair.ours);
    repo = undefined;
  });
  afterEach(async () => {
    await repo?.dispose();
    await pair.dispose();
  });

  const abortOnBoth = async (): Promise<{ expected: Outcome; result: Outcome }> => {
    const opened = await openRepository({ cwd: pair.ours });
    repo = opened;
    const expected = gitOutcomeOfAbort(pair.peer);
    const result = await tsgitOutcomeOfAbort(opened);
    return { expected, result };
  };

  const stopBoth = async (
    entries: ReturnType<typeof entriesOf>,
    stopped?: Parameters<typeof buildStoppedMerge>[2],
  ): Promise<void> => {
    for (const dir of [pair.peer, pair.ours]) buildStoppedMerge(dir, entries, stopped);
    stopGitMerge(pair.peer);
    repo = await openRepository({ cwd: pair.ours });
    await stopTsgitMerge(repo);
    await repo.dispose();
  };

  const CASES = ABORT_ROWS.flatMap((row) =>
    row.variants.map((variant) => ({
      id: `${row.shape}/${variant}`,
      row,
      variant,
      occupant: variant === 'reset-adds' ? (row.addOccupant ?? row.occupant) : row.occupant,
    })),
  );

  describe.each(CASES)('Given the stopped merge $id', ({ row, variant, occupant }) => {
    describe('When both tools abort it', () => {
      it('Then the outcome, work tree, index and merge state match git', async () => {
        // Arrange
        await stopBoth(entriesOf(variant, row));
        occupant(pair.peer);
        occupant(pair.ours);

        // Act
        const { expected, result } = await abortOnBoth();

        // Assert
        expect(result).toEqual(expected);
        expect(listing(pair.ours)).toEqual(listing(pair.peer));
        expect(gitState(pair.ours)).toEqual(gitState(pair.peer));
      });
    });
  });

  describe('Given a stop where an untracked add precedes a local change in path order', () => {
    describe('When both tools abort it', () => {
      it('Then each names only the first path, in its class', async () => {
        // Arrange — t deletes a (abort re-adds it) and changes z.
        const entries = {
          base: [v1('a'), v1('z')],
          main: [v1('a'), v1('z')],
          theirs: [regular('z')],
        };
        await stopBoth(entries);
        for (const dir of [pair.peer, pair.ours]) {
          fileAt('a')(dir);
          replacing('z', directoryHolding('z', 'u'))(dir);
        }

        // Act
        const { expected, result } = await abortOnBoth();

        // Assert
        expect(expected).toEqual({ refused: true, localChanges: [], untracked: ['a'] });
        expect(result).toEqual(expected);
        expect(gitState(pair.ours)).toEqual(gitState(pair.peer));
      });
    });
  });

  describe('Given a stop where a local change precedes an untracked add in path order', () => {
    describe('When both tools abort it', () => {
      it('Then each names only the first path, in its class', async () => {
        // Arrange — t deletes z (abort re-adds it) and changes a.
        const entries = {
          base: [v1('a'), v1('z')],
          main: [v1('a'), v1('z')],
          theirs: [regular('a')],
        };
        await stopBoth(entries);
        for (const dir of [pair.peer, pair.ours]) {
          fileAt('z')(dir);
          replacing('a', directoryHolding('a', 'u'))(dir);
        }

        // Act
        const { expected, result } = await abortOnBoth();

        // Assert
        expect(expected).toEqual({ refused: true, localChanges: ['a'], untracked: [] });
        expect(result).toEqual(expected);
        expect(gitState(pair.ours)).toEqual(gitState(pair.peer));
      });
    });
  });

  const UNMERGED_OCCUPANTS: ReadonlyArray<readonly [string, Occupant, Outcome]> = [
    [
      'a directory holding an untracked file',
      replacing('keep', directoryHolding('keep', 'u')),
      { refused: true, localChanges: [], untracked: ['keep'] },
    ],
    [
      'a directory holding only an ignored file',
      replacing('keep', ignoring('keep/ign', directoryHolding('keep', 'ign'))),
      OK,
    ],
    ['a plain file', replacing('keep', fileAt('keep')), OK],
    ['a symlink', replacing('keep', (dir) => symlinkSync('nowhere', path.join(dir, 'keep'))), OK],
  ];

  describe.each(UNMERGED_OCCUPANTS)(
    'Given the unmerged keep replaced by %s',
    (_label, occupant, pinned) => {
      describe('When both tools abort it', () => {
        it('Then the outcome and the kept merge state match git', async () => {
          // Arrange
          await stopBoth({ base: [], main: [], theirs: [] });
          occupant(pair.peer);
          occupant(pair.ours);

          // Act
          const { expected, result } = await abortOnBoth();

          // Assert
          expect(expected).toEqual(pinned);
          expect(result).toEqual(expected);
          expect(listing(pair.ours)).toEqual(listing(pair.peer));
          expect(gitState(pair.ours)).toEqual(gitState(pair.peer));
        });
      });
    },
  );

  describe('Given a gitlink modified upstream and deleted here, then its directory populated', () => {
    describe('When both tools abort it', () => {
      it('Then the directory is left untracked and the merge state is cleared as in git', async () => {
        // Arrange
        const bumped = '2222222222222222222222222222222222222222';
        const entries = { base: [gitlink('sub')], main: [], theirs: [gitlink('sub', bumped)] };
        for (const dir of [pair.peer, pair.ours]) {
          buildStoppedMerge(dir, entries);
          stopGitMerge(dir);
          directoryHolding('sub', 'child')(dir);
        }

        // Act
        const { expected, result } = await abortOnBoth();

        // Assert
        expect(expected).toEqual(OK);
        expect(result).toEqual(expected);
        expect(listing(pair.ours)).toEqual(listing(pair.peer));
        expect(gitState(pair.ours)).toEqual(gitState(pair.peer));
      });
    });
  });

  describe('Given a merge stopped with --autostash, then a directory replacing the updated f', () => {
    describe('When both tools abort it', () => {
      it('Then the abort is refused, MERGE_AUTOSTASH is consumed and nothing is applied', async () => {
        // Arrange
        const entries = {
          base: [v1('f'), v1('dirty')],
          main: [v1('f'), v1('dirty')],
          theirs: [regular('f'), v1('dirty')],
        };
        for (const dir of [pair.peer, pair.ours]) {
          buildStoppedMerge(dir, entries);
          writeFileSync(path.join(dir, 'dirty'), 'local\n');
        }
        stopGitMerge(pair.peer, '--autostash');
        repo = await openRepository({ cwd: pair.ours });
        await stopTsgitMerge(repo, { autostash: true });
        for (const dir of [pair.peer, pair.ours]) {
          replacing('f', directoryHolding('f', 'u'))(dir);
        }

        // Act
        const { expected, result } = await abortOnBoth();

        // Assert
        expect(expected).toEqual({ refused: true, localChanges: ['f'], untracked: [] });
        expect(result).toEqual(expected);
        expect(existsSync(path.join(pair.peer, '.git', 'MERGE_AUTOSTASH'))).toBe(false);
        expect(existsSync(path.join(pair.ours, '.git', 'MERGE_AUTOSTASH'))).toBe(false);
        expect(gitState(pair.ours)).toEqual(gitState(pair.peer));
      });
    });
  });
});
