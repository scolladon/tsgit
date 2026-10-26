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
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
  listing,
  observe,
  regular,
  settleIndex,
  skipWorktreeAt,
  staleEntries,
  statSnapshot,
  touchedAt,
  unmergedAbsentAt,
  unmergedAt,
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

const G1 = regular('g', 'g1\n');
const HOOK_LOG = 'hook-log';
const APPEND_ARGS_HOOK = `#!/bin/sh\nprintf '%s\\n' "$*" >> "$(git rev-parse --git-dir)/${HOOK_LOG}"\n`;

const installLoggingHook = (dir: string): void => {
  const hook = path.join(dir, '.git', 'hooks', 'post-checkout');
  writeFileSync(hook, APPEND_ARGS_HOOK);
  chmodSync(hook, 0o755);
};

const hookLog = (dir: string): string => {
  const file = path.join(dir, '.git', HOOK_LOG);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

const unmergedLines = (paths: ReadonlyArray<string>): string =>
  paths.map((p) => `error: path '${p}' is unmerged\n`).join('');

interface PathRestoreRow {
  readonly name: string;
  readonly plant: (dir: string) => void;
  readonly paths: ReadonlyArray<string>;
  readonly unmerged: ReadonlyArray<string>;
}

const plantAll =
  (...plants: ReadonlyArray<(dir: string) => void>) =>
  (dir: string): void => {
    for (const plant of plants) plant(dir);
  };

const REFUSED_RESTORES: ReadonlyArray<PathRestoreRow> = [
  { name: 'f', plant: unmergedAt('f'), paths: ['f'], unmerged: ['f'] },
  { name: 'f keep', plant: unmergedAt('f'), paths: ['f', 'keep'], unmerged: ['f'] },
  { name: '.', plant: unmergedAt('f'), paths: ['.'], unmerged: ['f'] },
  {
    name: '. with f and g unmerged',
    plant: plantAll(unmergedAt('f'), unmergedAt('g')),
    paths: ['.'],
    unmerged: ['f', 'g'],
  },
  { name: 'n keep', plant: unmergedAbsentAt('n'), paths: ['n', 'keep'], unmerged: ['n'] },
  { name: "'k*' f", plant: unmergedAt('f'), paths: ['k*', 'f'], unmerged: ['f'] },
];

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'checkout path restore over an unmerged path',
  () => {
    let pair: PeerPair;
    let repo: Repository | undefined;

    beforeEach(async () => {
      pair = await makePeerPair('path-restore-unmerged');
      initBothRepos(pair.peer, pair.ours);
      repo = undefined;
    });

    afterEach(async () => {
      await repo?.dispose();
      await pair.dispose();
    });

    const seed = async (plant: (dir: string) => void): Promise<void> => {
      for (const dir of [pair.peer, pair.ours]) {
        buildHistory(dir, [v1('f'), G1], [v1('f'), G1]);
        settleIndex(dir);
        fileWith('keep', 'edited\n')(dir);
        installLoggingHook(dir);
        plant(dir);
      }
      repo = await openRepository({ cwd: pair.ours });
    };

    describe.each(REFUSED_RESTORES)('Given the paths $name from the index', (row) => {
      describe('When git and tsgit restore them', () => {
        it('Then both refuse naming the unmerged paths and leave everything untouched', async () => {
          // Arrange
          await seed(row.plant);
          const peerBytes = readFileSync(path.join(pair.peer, '.git', 'index'));
          const oursBytes = readFileSync(path.join(pair.ours, '.git', 'index'));
          const peerListing = listing(pair.peer);
          const oursListing = listing(pair.ours);

          // Act
          const gitRun = tryRunGitWithExit(['-C', pair.peer, 'checkout', '--', ...row.paths]);
          const sut = await repo?.checkout({ paths: row.paths }).catch((err: unknown) => err);

          // Assert
          expect(gitRun.exitCode).toBe(1);
          expect(gitRun.stderr).toBe(unmergedLines(row.unmerged));
          expect(sut).toMatchObject({
            data: { code: 'MERGE_HAS_CONFLICTS', count: row.unmerged.length, paths: row.unmerged },
          });
          expect(readFileSync(path.join(pair.peer, '.git', 'index'))).toEqual(peerBytes);
          expect(readFileSync(path.join(pair.ours, '.git', 'index'))).toEqual(oursBytes);
          expect(listing(pair.peer)).toEqual(peerListing);
          expect(listing(pair.ours)).toEqual(oursListing);
          expect([hookLog(pair.peer), hookLog(pair.ours)]).toEqual(['', '']);
        });
      });
    });

    describe('Given the paths nosuch and f from the index with f unmerged', () => {
      describe('When git and tsgit restore them', () => {
        it('Then both refuse the unmatched pathspec first', async () => {
          // Arrange
          await seed(unmergedAt('f'));

          // Act
          const gitRun = tryRunGitWithExit(['-C', pair.peer, 'checkout', '--', 'nosuch', 'f']);
          const sut = await repo?.checkout({ paths: ['nosuch', 'f'] }).catch((err: unknown) => err);

          // Assert
          expect(gitRun.exitCode).toBe(1);
          expect(gitRun.stderr).toBe(
            "error: pathspec 'nosuch' did not match any file(s) known to git\n",
          );
          expect(sut).toMatchObject({ data: { code: 'PATHSPEC_NO_MATCH', pattern: 'nosuch' } });
        });
      });
    });

    describe.each([
      { name: 'keep from the index', gitArgs: ['--', 'keep'], opts: { paths: ['keep'] } },
      {
        name: 'f keep from HEAD',
        gitArgs: ['HEAD', '--', 'f', 'keep'],
        opts: { source: 'HEAD', paths: ['f', 'keep'] },
      },
      {
        name: '. from HEAD',
        gitArgs: ['HEAD', '--', '.'],
        opts: { source: 'HEAD', paths: ['.'] },
      },
    ])('Given f unmerged and the paths $name', (command) => {
      describe('When git and tsgit restore them', () => {
        it('Then the work tree, the index and the hook log match git', async () => {
          // Arrange
          await seed(unmergedAt('f'));
          const peerBefore = statSnapshot(pair.peer);
          const oursBefore = statSnapshot(pair.ours);

          // Act
          git(pair.peer, 'checkout', ...command.gitArgs);
          await repo?.checkout(command.opts);

          // Assert
          expect(observe(pair.ours, oursBefore)).toEqual(observe(pair.peer, peerBefore));
          expect(hookLog(pair.ours)).toEqual(hookLog(pair.peer));
        });
      });
    });

    describe.each([
      { name: '. from HEAD', gitArgs: ['HEAD', '--', '.'], opts: { source: 'HEAD', paths: ['.'] } },
    ])('Given n unmerged and absent from HEAD and the paths $name', (command) => {
      describe('When git and tsgit restore them', () => {
        it('Then n keeps its stages as in git', async () => {
          // Arrange
          await seed(unmergedAbsentAt('n'));
          const peerBefore = statSnapshot(pair.peer);
          const oursBefore = statSnapshot(pair.ours);

          // Act
          git(pair.peer, 'checkout', ...command.gitArgs);
          await repo?.checkout(command.opts);

          // Assert
          expect(observe(pair.ours, oursBefore)).toEqual(observe(pair.peer, peerBefore));
          expect(hookLog(pair.ours)).toEqual(hookLog(pair.peer));
        });
      });
    });

    describe('Given n unmerged and absent from HEAD and the paths n from HEAD', () => {
      describe('When git and tsgit restore them', () => {
        it('Then both refuse n as an unknown pathspec', async () => {
          // Arrange
          await seed(unmergedAbsentAt('n'));

          // Act
          const gitRun = tryRunGitWithExit(['-C', pair.peer, 'checkout', 'HEAD', '--', 'n']);
          const sut = await repo
            ?.checkout({ source: 'HEAD', paths: ['n'] })
            .catch((err: unknown) => err);

          // Assert
          expect(gitRun.exitCode).toBe(1);
          expect(sut).toMatchObject({ data: { code: 'PATHSPEC_NO_MATCH', pattern: 'n' } });
        });
      });
    });

    describe.each(['C', 'T', 'AU', 'S2', 'ST'])('Given the work tree shape %s', (shapeName) => {
      describe.each([
        { name: '-- f keep', gitArgs: ['--', 'f', 'keep'], source: undefined },
        { name: 'HEAD -- f keep', gitArgs: ['HEAD', '--', 'f', 'keep'], source: 'HEAD' },
      ])('And the command $name', (command) => {
        describe('When git and tsgit restore the paths', () => {
          it('Then the work tree, the index, its flags and the rewritten set match git', async () => {
            // Arrange
            const shape = WORK_TREE_SHAPES[shapeName];
            if (shape === undefined) throw new Error(`unknown shape ${shapeName}`);
            for (const dir of [pair.peer, pair.ours]) {
              buildHistory(dir, [...shape.tracked, regular('other')], shape.tracked);
              settleIndex(dir);
              shape.plant(dir);
            }
            repo = await openRepository({ cwd: pair.ours });
            const peerBefore = statSnapshot(pair.peer);
            const oursBefore = statSnapshot(pair.ours);

            // Act
            git(pair.peer, 'checkout', ...command.gitArgs);
            await repo.checkout({
              paths: ['f', 'keep'],
              ...(command.source && { source: command.source }),
            });

            // Assert
            expect(observe(pair.ours, oursBefore)).toEqual(observe(pair.peer, peerBefore));
          });
        });
      });
    });
  },
);
