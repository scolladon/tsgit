/**
 * Cross-tool interop — a forced checkout that lands on the commit HEAD already holds, or on
 * another one. The same history is built with git plumbing in a canonical-git peer and in a
 * tsgit repo, a work-tree shape is planted over a settled index in both, git runs the forced
 * checkout in its peer and tsgit in the other, and the work tree, the index, its flags and
 * the stale and rewritten sets are compared.
 *
 * @proves
 *   surface:        repo.checkout
 *   bucket:         cross-tool-interop
 *   unique:         forced checkout rewrites every stale entry and resets conflicts as git does
 *   interopSurface: checkout
 */
import { existsSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  git,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  topReflogSubject,
  tryRunGitWithExit,
} from './interop-helpers.js';
import {
  assumingUnchanged,
  buildHistory,
  fileWith,
  flagListing,
  observe,
  regular,
  settleIndex,
  skipWorktreeAt,
  staleEntries,
  statSnapshot,
  touchedAt,
  v1,
  WORK_TREE_SHAPES,
} from './occupant-displacement-fixtures.js';

const TAG = 'tg';

interface Spelling {
  readonly name: string;
  readonly detachFirst: boolean;
  readonly resolve: (dir: string) => string;
}

const SPELLINGS: ReadonlyArray<Spelling> = [
  { name: '-f HEAD', detachFirst: false, resolve: () => 'HEAD' },
  { name: '-f main', detachFirst: false, resolve: () => 'main' },
  {
    name: '-f <oid>',
    detachFirst: false,
    resolve: (dir) => git(dir, 'rev-parse', 'main').trim(),
  },
  { name: '-f tag', detachFirst: false, resolve: () => TAG },
  { name: '-f @', detachFirst: false, resolve: () => '@' },
  { name: 'detached -f HEAD', detachFirst: true, resolve: () => 'HEAD' },
];

interface HeadCheckout {
  readonly name: string;
  readonly detachFirst: boolean;
  readonly gitArgs: ReadonlyArray<string>;
  readonly tsgit: Parameters<Repository['checkout']>[0];
}

const HEAD_CHECKOUTS: ReadonlyArray<HeadCheckout> = [
  { name: 'checkout HEAD', detachFirst: false, gitArgs: ['HEAD'], tsgit: { rev: 'HEAD' } },
  { name: 'checkout @', detachFirst: false, gitArgs: ['@'], tsgit: { rev: '@' } },
  { name: 'checkout HEAD~0', detachFirst: false, gitArgs: ['HEAD~0'], tsgit: { rev: 'HEAD~0' } },
  {
    name: 'checkout --detach HEAD',
    detachFirst: false,
    gitArgs: ['--detach', 'HEAD'],
    tsgit: { rev: 'HEAD', detach: true },
  },
  {
    name: 'checkout -f --detach HEAD',
    detachFirst: false,
    gitArgs: ['-f', '--detach', 'HEAD'],
    tsgit: { rev: 'HEAD', detach: true, force: true },
  },
  {
    name: 'checkout -b nb HEAD',
    detachFirst: false,
    gitArgs: ['-b', 'nb', 'HEAD'],
    tsgit: { rev: 'HEAD', createBranch: { name: 'nb' } },
  },
  { name: 'detached checkout HEAD', detachFirst: true, gitArgs: ['HEAD'], tsgit: { rev: 'HEAD' } },
];

const STATE_FILES = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'ORIG_HEAD'];

const plantStateFiles = (dir: string): void => {
  const head = git(dir, 'rev-parse', 'HEAD').trim();
  for (const name of STATE_FILES) writeFileSync(path.join(dir, '.git', name), `${head}\n`);
};

const remainingStateFiles = (dir: string): readonly string[] =>
  STATE_FILES.filter((name) => existsSync(path.join(dir, '.git', name)));

const headState = (dir: string): readonly string[] => [
  git(dir, 'rev-parse', '--symbolic-full-name', 'HEAD').trim(),
  git(dir, 'rev-parse', 'HEAD').trim(),
  String(git(dir, 'reflog', 'show', 'HEAD').trim().split('\n').length),
  topReflogSubject(dir, 'HEAD'),
];

describe.skipIf(!GIT_AVAILABLE)('checkout forced same-commit interop', () => {
  let pair: PeerPair;
  let repo: Repository | undefined;

  beforeEach(async () => {
    pair = await makePeerPair('forced-checkout');
    initBothRepos(pair.peer, pair.ours);
    repo = undefined;
  });

  afterEach(async () => {
    await repo?.dispose();
    await pair.dispose();
  });

  describe.each(SPELLINGS)('Given the spelling $name', (spelling) => {
    describe.each(Object.entries(WORK_TREE_SHAPES))(
      'And the work tree shape %s over a settled index',
      (_name, shape) => {
        describe('When git and tsgit force the checkout', () => {
          it('Then the work tree, the index, its flags and the stale and rewritten sets match git', async () => {
            // Arrange
            for (const dir of [pair.peer, pair.ours]) {
              buildHistory(dir, [...shape.tracked, regular('other')], shape.tracked);
              git(dir, 'tag', TAG, 't');
              if (spelling.detachFirst) git(dir, 'checkout', '-q', '--detach');
              settleIndex(dir);
              shape.plant(dir);
            }
            repo = await openRepository({ cwd: pair.ours });
            const peerBefore = statSnapshot(pair.peer);
            const oursBefore = statSnapshot(pair.ours);

            // Act
            git(pair.peer, 'checkout', '-q', '-f', spelling.resolve(pair.peer));
            await repo.checkout({ rev: spelling.resolve(pair.ours), force: true });

            // Assert
            expect(observe(pair.ours, oursBefore)).toEqual(observe(pair.peer, peerBefore));
            expect(headState(pair.ours)).toEqual(headState(pair.peer));
          });
        });
      },
    );
  });

  describe.each(HEAD_CHECKOUTS)('Given the command $name', (command) => {
    describe('When git and tsgit run it over an edited tracked file', () => {
      it('Then the work tree, the index, HEAD and its reflog match git', async () => {
        // Arrange
        for (const dir of [pair.peer, pair.ours]) {
          buildHistory(dir, [v1('f')], [v1('f')]);
          if (command.detachFirst) git(dir, 'checkout', '-q', '--detach');
          settleIndex(dir);
          fileWith('f', 'edited\n')(dir);
        }
        repo = await openRepository({ cwd: pair.ours });
        const peerBefore = statSnapshot(pair.peer);
        const oursBefore = statSnapshot(pair.ours);

        // Act
        git(pair.peer, 'checkout', '-q', ...command.gitArgs);
        await repo.checkout(command.tsgit);

        // Assert
        expect(observe(pair.ours, oursBefore)).toEqual(observe(pair.peer, peerBefore));
        expect(headState(pair.ours)).toEqual(headState(pair.peer));
      });
    });
  });

  describe.each([
    ['-f HEAD', 'HEAD'],
    ['-f main', 'main'],
  ])('Given pending operation state files and checkout %s', (_name, rev) => {
    describe('When git and tsgit run it', () => {
      it('Then the same state files remain', async () => {
        // Arrange
        for (const dir of [pair.peer, pair.ours]) {
          buildHistory(dir, [v1('f')], [v1('f')]);
          settleIndex(dir);
          plantStateFiles(dir);
        }
        repo = await openRepository({ cwd: pair.ours });

        // Act
        git(pair.peer, 'checkout', '-q', '-f', rev);
        await repo.checkout({ rev, force: true });

        // Assert
        expect(remainingStateFiles(pair.ours)).toEqual(remainingStateFiles(pair.peer));
      });
    });
  });

  describe('Given a tracked a/payload and a work tree holding a symlink a to an outside directory', () => {
    describe('When git and tsgit force the checkout of HEAD', () => {
      it('Then a becomes a directory holding payload and the outside directory stays empty', async () => {
        // Arrange
        const outsides = {
          peer: await mkdtemp(path.join(os.tmpdir(), 'tsgit-forced-outside-peer-')),
          ours: await mkdtemp(path.join(os.tmpdir(), 'tsgit-forced-outside-ours-')),
        };
        try {
          for (const [dir, outside] of [
            [pair.peer, outsides.peer],
            [pair.ours, outsides.ours],
          ] as const) {
            buildHistory(dir, [regular('a/payload'), regular('other')], [regular('a/payload')]);
            settleIndex(dir);
            rmSync(path.join(dir, 'a'), { recursive: true });
            symlinkSync(outside, path.join(dir, 'a'));
          }
          repo = await openRepository({ cwd: pair.ours });
          const peerBefore = statSnapshot(pair.peer);
          const oursBefore = statSnapshot(pair.ours);

          // Act
          git(pair.peer, 'checkout', '-q', '-f', 'main');
          await repo.checkout({ rev: 'main', force: true });

          // Assert
          expect(observe(pair.ours, oursBefore)).toEqual(observe(pair.peer, peerBefore));
          expect(readdirSync(outsides.ours)).toEqual(readdirSync(outsides.peer));
        } finally {
          await rm(outsides.peer, { recursive: true, force: true });
          await rm(outsides.ours, { recursive: true, force: true });
        }
      });
    });
  });
});

/** `t` changes `g` and adds `other`; every other tracked path is the same on both branches. */
const SWITCH_DUE = [v1('f'), v1('a'), v1('s'), regular('g', 'g2\n'), regular('other')];
const SWITCH_TRACKED = [v1('f'), v1('a'), v1('s'), v1('g')];

interface UnforcedSwitch {
  readonly name: string;
  readonly gitArgs: ReadonlyArray<string>;
  readonly tsgit: Parameters<Repository['checkout']>[0];
}

const UNFORCED_SWITCHES: ReadonlyArray<UnforcedSwitch> = [
  { name: 'checkout HEAD', gitArgs: ['HEAD'], tsgit: { rev: 'HEAD' } },
  { name: 'checkout main', gitArgs: ['main'], tsgit: { rev: 'main' } },
  { name: 'checkout t', gitArgs: ['t'], tsgit: { rev: 't' } },
  {
    name: 'checkout --detach main',
    gitArgs: ['--detach', 'main'],
    tsgit: { rev: 'main', detach: true },
  },
];

const indexBytes = (dir: string): Buffer => readFileSync(path.join(dir, '.git', 'index'));

describe.skipIf(!GIT_AVAILABLE)('unforced checkout refreshes drifted index stats', () => {
  let pair: PeerPair;
  let repo: Repository | undefined;

  beforeEach(async () => {
    pair = await makePeerPair('unforced-checkout-refresh');
    initBothRepos(pair.peer, pair.ours);
    repo = undefined;
  });

  afterEach(async () => {
    await repo?.dispose();
    await pair.dispose();
  });

  const seed = (plant: (dir: string) => void): void => {
    for (const dir of [pair.peer, pair.ours]) {
      buildHistory(dir, SWITCH_DUE, SWITCH_TRACKED);
      settleIndex(dir);
      plant(dir);
    }
  };

  const observedStaleAndFlags = (dir: string): { stale: string[]; flags: string } => ({
    stale: staleEntries(dir),
    flags: flagListing(dir),
  });

  describe.each(UNFORCED_SWITCHES)(
    'Given a touched clean file and the command $name',
    (command) => {
      describe('When git and tsgit run it', () => {
        it('Then the stale entries and the flags match git', async () => {
          // Arrange
          seed(touchedAt('f'));
          repo = await openRepository({ cwd: pair.ours });

          // Act
          git(pair.peer, 'checkout', '-q', ...command.gitArgs);
          await repo.checkout(command.tsgit);

          // Assert
          expect(observedStaleAndFlags(pair.ours)).toEqual(observedStaleAndFlags(pair.peer));
        });
      });
    },
  );

  describe('Given touched, assume-unchanged, skip-worktree and edited files and the command checkout t', () => {
    describe('When git and tsgit run it', () => {
      it('Then the stale entries and the flags match git', async () => {
        // Arrange
        seed((dir) => {
          touchedAt('f')(dir);
          assumingUnchanged('a', touchedAt('a'))(dir);
          skipWorktreeAt('s', touchedAt('s'))(dir);
          fileWith('keep', 'edited\n')(dir);
          touchedAt('g')(dir);
        });
        repo = await openRepository({ cwd: pair.ours });

        // Act
        git(pair.peer, 'checkout', '-q', 't');
        await repo.checkout({ rev: 't' });

        // Assert
        expect(observedStaleAndFlags(pair.ours)).toEqual(observedStaleAndFlags(pair.peer));
      });
    });
  });

  describe('Given a touched file and an edited file that the target changes', () => {
    describe('When git and tsgit run checkout t', () => {
      it('Then both refuse on the edited file and leave the index bytes', async () => {
        // Arrange
        seed((dir) => {
          touchedAt('f')(dir);
          fileWith('g', 'edited\n')(dir);
        });
        repo = await openRepository({ cwd: pair.ours });
        const peerBefore = indexBytes(pair.peer);
        const oursBefore = indexBytes(pair.ours);

        // Act
        const gitRun = tryRunGitWithExit(['-C', pair.peer, 'checkout', 't']);
        const sut = await repo.checkout({ rev: 't' }).catch((err: unknown) => err);

        // Assert
        expect(gitRun.exitCode).toBe(1);
        expect(sut).toMatchObject({
          data: { code: 'CHECKOUT_OVERWRITE_DIRTY', localChanges: ['g'] },
        });
        expect(indexBytes(pair.peer)).toEqual(peerBefore);
        expect(indexBytes(pair.ours)).toEqual(oursBefore);
        expect(observedStaleAndFlags(pair.ours)).toEqual(observedStaleAndFlags(pair.peer));
      });
    });
  });
});
