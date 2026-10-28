/**
 * Cross-tool interop — `stash push` opening step. Real git refreshes the index and refuses an
 * unmerged one before it writes any object, ref or reflog; tsgit is driven through the same
 * fixtures and compared with git's own outcome. Refusal text is rebuilt from tsgit's structured
 * fields.
 *
 * @proves
 *   surface:        repo.stash.push
 *   bucket:         cross-tool-interop
 *   unique:         stash push refreshes the index and refuses an unmerged one as canonical git does
 *   interopSurface: stash
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  makePeerPair,
  type PeerPair,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';
import {
  buildHistory,
  COMMIT_ENV,
  commitOn,
  emptyDirectoryAt,
  fileWith,
  gitlink,
  indexIdentity,
  indexState,
  KEEP,
  linkAt,
  listing,
  observe,
  regular,
  settleIndex,
  staleEntries,
  statSnapshot,
  symlink,
  type TreeEntry,
  touchedAt,
  unmergedAbsentAt,
  unmergedAt,
  v1,
  WORK_TREE_SHAPES,
} from './occupant-displacement-fixtures.js';

const GIT_REFUSAL_EXIT = 1;
const COULD_NOT_WRITE_INDEX = 'error: could not write index\n';

const looseObjectCount = (dir: string): number =>
  readdirSync(path.join(dir, '.git', 'objects'), { withFileTypes: true })
    .filter((fan) => fan.isDirectory() && fan.name.length === 2)
    .reduce((sum, fan) => sum + readdirSync(path.join(dir, '.git', 'objects', fan.name)).length, 0);

const reflogOf = (dir: string, ref: string): string => {
  const file = path.join(dir, '.git', 'logs', ref);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

interface Written {
  readonly objects: number;
  readonly stashRef: boolean;
  readonly index: string;
  readonly work: string[];
  readonly headLog: string;
  readonly mainLog: string;
}

const writtenState = (dir: string): Written => ({
  objects: looseObjectCount(dir),
  stashRef: existsSync(path.join(dir, '.git', 'refs', 'stash')),
  index: readFileSync(path.join(dir, '.git', 'index')).toString('hex'),
  work: listing(dir),
  headLog: reflogOf(dir, 'HEAD'),
  mainLog: reflogOf(dir, 'refs/heads/main'),
});

const dataOf = async (run: () => Promise<unknown>): Promise<{ readonly paths?: string[] }> =>
  run().then(
    () => ({}),
    (error: unknown) => (error as TsgitError).data as { readonly paths?: string[] },
  );

const needsMerge = (paths: ReadonlyArray<string>): string =>
  paths.map((rel) => `${rel}: needs merge\n`).join('');

const UNMERGED_SHAPES = {
  'stages 1-3 of f': { rel: 'f', plant: unmergedAt('f') },
  'stages 2-3 of n': { rel: 'n', plant: unmergedAbsentAt('n') },
};

const PUSH_VARIANTS = {
  'a plain push': { git: [], opts: {} },
  'an include-untracked push': { git: ['-u'], opts: { includeUntracked: true } },
  'a keep-index push': { git: ['--keep-index'], opts: { keepIndex: true } },
};

describe.skipIf(!GIT_AVAILABLE)('stash push opening step interop', () => {
  let pair: PeerPair;
  let repo: Repository;

  beforeEach(async () => {
    pair = await makePeerPair('stash-push-reset');
  });

  afterEach(async () => {
    await repo?.dispose();
    await pair.dispose();
  });

  const open = async (): Promise<void> => {
    repo = await openRepository({ cwd: pair.ours });
  };

  describe.each(Object.entries(UNMERGED_SHAPES))('Given an index holding %s', (_name, shape) => {
    describe.each(Object.entries(PUSH_VARIANTS))(
      'When git and tsgit run %s',
      (_variant, variant) => {
        it('Then both refuse and write nothing', async () => {
          // Arrange
          const tracked = [v1('f'), regular('g', 'g1\n')];
          for (const dir of [pair.peer, pair.ours]) {
            runGit(['init', '-q', '-b', 'main', dir]);
            buildHistory(dir, tracked, tracked);
            settleIndex(dir);
            shape.plant(dir);
            fileWith('u', 'untracked\n')(dir);
          }
          await open();
          const peerBefore = writtenState(pair.peer);
          const oursBefore = writtenState(pair.ours);
          const sut = repo.stash.push;

          // Act
          const git = tryRunGitWithExit(['-C', pair.peer, 'stash', 'push', '-q', ...variant.git], {
            env: COMMIT_ENV,
          });
          const data = await dataOf(() => sut(variant.opts));

          // Assert
          expect(git.exitCode).toBe(GIT_REFUSAL_EXIT);
          expect(git.stderr).toBe(COULD_NOT_WRITE_INDEX);
          expect(needsMerge(data.paths ?? [])).toBe(git.stdout);
          expect(writtenState(pair.peer)).toEqual(peerBefore);
          expect(writtenState(pair.ours)).toEqual(oursBefore);
        });
      },
    );
  });

  describe('Given a merge left conflicted on f', () => {
    describe('When git and tsgit stash push', () => {
      it('Then both refuse on the unmerged index and write nothing', async () => {
        // Arrange
        for (const dir of [pair.peer, pair.ours]) {
          runGit(['init', '-q', '-b', 'main', dir]);
          const base = commitOn(dir, [KEEP, regular('f', 'base\n')]);
          const side = commitOn(dir, [KEEP, regular('f', 'side\n')], base);
          const main = commitOn(dir, [KEEP, regular('f', 'main\n')], base);
          runGit(['-C', dir, 'update-ref', 'refs/heads/main', main]);
          runGit(['-C', dir, 'update-ref', 'refs/heads/side', side]);
          runGit(['-C', dir, 'reset', '-q', '--hard', 'main']);
          const merged = tryRunGitWithExit(['-C', dir, 'merge', '-q', 'side'], { env: COMMIT_ENV });
          expect(merged.exitCode).toBe(GIT_REFUSAL_EXIT);
        }
        await open();
        const before = writtenState(pair.ours);
        const sut = repo.stash.push;

        // Act
        const git = tryRunGitWithExit(['-C', pair.peer, 'stash', 'push', '-q'], {
          env: COMMIT_ENV,
        });
        const data = await dataOf(() => sut({}));

        // Assert
        expect(git.exitCode).toBe(GIT_REFUSAL_EXIT);
        expect(git.stderr).toBe(COULD_NOT_WRITE_INDEX);
        expect(needsMerge(data.paths ?? [])).toBe(git.stdout);
        expect(writtenState(pair.ours)).toEqual(before);
      });
    });
  });

  describe('Given a merge left conflicted on f and a stat-drifted clean entry', () => {
    describe('When git and tsgit stash push', () => {
      it('Then both refresh the clean entry and write the index before refusing', async () => {
        // Arrange
        const DRIFTED = new Date('2025-01-01T00:00:00Z');
        for (const dir of [pair.peer, pair.ours]) {
          runGit(['init', '-q', '-b', 'main', dir]);
          const base = commitOn(dir, [KEEP, regular('f', 'base\n'), regular('clean', 'c\n')]);
          const side = commitOn(dir, [KEEP, regular('f', 'side\n'), regular('clean', 'c\n')], base);
          const main = commitOn(dir, [KEEP, regular('f', 'main\n'), regular('clean', 'c\n')], base);
          runGit(['-C', dir, 'update-ref', 'refs/heads/main', main]);
          runGit(['-C', dir, 'update-ref', 'refs/heads/side', side]);
          runGit(['-C', dir, 'reset', '-q', '--hard', 'main']);
          tryRunGitWithExit(['-C', dir, 'merge', '-q', 'side'], { env: COMMIT_ENV });
          utimesSync(path.join(dir, 'clean'), DRIFTED, DRIFTED);
        }
        await open();
        const cachedMtime = (dir: string): string =>
          runGit(['-C', dir, 'ls-files', '--debug', 'clean'])
            .split('\n')
            .filter((line) => line.includes('mtime:'))
            .join('');
        const staleBefore = staleEntries(pair.ours);
        const sut = repo.stash.push;

        // Act
        const git = tryRunGitWithExit(['-C', pair.peer, 'stash', 'push', '-q'], {
          env: COMMIT_ENV,
        });
        const data = await dataOf(() => sut({}));

        // Assert
        expect(staleBefore).toContain('clean');
        expect(git.exitCode).toBe(GIT_REFUSAL_EXIT);
        expect(needsMerge(data.paths ?? [])).toBe(git.stdout);
        expect(staleEntries(pair.peer)).not.toContain('clean');
        expect(staleEntries(pair.ours)).not.toContain('clean');
        expect(cachedMtime(pair.ours)).toBe(cachedMtime(pair.peer));
      });
    });
  });

  describe.each(['C', 'E', 'T'])('Given the work tree shape %s over a settled index', (name) => {
    describe('When git and tsgit stash push', () => {
      it('Then the work tree, the index, its flags and the stale and rewritten sets match git', async () => {
        // Arrange
        const shape = WORK_TREE_SHAPES[name];
        if (shape === undefined) throw new Error(`unknown shape ${name}`);
        for (const dir of [pair.peer, pair.ours]) {
          runGit(['init', '-q', '-b', 'main', dir]);
          buildHistory(dir, shape.tracked, shape.tracked);
          settleIndex(dir);
          shape.plant(dir);
        }
        await open();
        const peerBefore = statSnapshot(pair.peer);
        const oursBefore = statSnapshot(pair.ours);
        expect(statSync(path.join(pair.ours, 'keep')).isFile()).toBe(true);

        // Act
        runGit(['-C', pair.peer, 'stash', 'push', '-q'], { env: COMMIT_ENV });
        await repo.stash.push({});

        // Assert
        expect(observe(pair.ours, oursBefore)).toEqual(observe(pair.peer, peerBefore));
      });
    });
  });
});

const logEntries = (dir: string, ref: string): string[] =>
  reflogOf(dir, ref)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [head, message = ''] = line.split('\t');
      const [oldId, newId] = (head ?? '').split(' ');
      return `${oldId} ${newId} ${message}`;
    });

const origHeadOf = (dir: string): string => {
  const file = path.join(dir, '.git', 'ORIG_HEAD');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

const refTail = (dir: string): unknown => ({
  head: logEntries(dir, 'HEAD').slice(1),
  main: logEntries(dir, 'refs/heads/main').length,
  origHead: origHeadOf(dir),
  stashLog: logEntries(dir, 'refs/stash').map((entry) => entry.split(' ').slice(2).join(' ')),
});

const REF_TAIL_VARIANTS = {
  'a quiet push': { git: [], opts: {} },
  'an include-untracked push': { git: ['-u'], opts: { includeUntracked: true } },
  'a keep-index push': { git: ['--keep-index'], opts: { keepIndex: true } },
};

describe.skipIf(!GIT_AVAILABLE)('stash push ref tail interop', () => {
  let pair: PeerPair;
  let repo: Repository;

  beforeEach(async () => {
    pair = await makePeerPair('stash-push-ref-tail');
  });

  afterEach(async () => {
    await repo?.dispose();
    await pair.dispose();
  });

  const arrange = async (detach: boolean): Promise<void> => {
    const tracked = [v1('f'), regular('g', 'g1\n')];
    for (const dir of [pair.peer, pair.ours]) {
      runGit(['init', '-q', '-b', 'main', dir]);
      buildHistory(dir, tracked, tracked);
      settleIndex(dir);
      rmSync(path.join(dir, '.git', 'ORIG_HEAD'), { force: true });
      runGit(['-C', dir, 'config', 'user.name', 'Ada']);
      runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);
      fileWith('f', 'edited\n')(dir);
      fileWith('u', 'untracked\n')(dir);
      if (detach) runGit(['-C', dir, 'checkout', '-q', '--detach']);
    }
    repo = await openRepository({ cwd: pair.ours });
  };

  describe.each(Object.entries(REF_TAIL_VARIANTS))('Given an edited file and %s', (_n, variant) => {
    describe('When git and tsgit push', () => {
      it('Then the HEAD reflog, the branch reflog, ORIG_HEAD and the stash reflog match git', async () => {
        // Arrange
        await arrange(false);
        const sut = repo.stash.push;

        // Act
        runGit(['-C', pair.peer, 'stash', 'push', '-q', ...variant.git], { env: COMMIT_ENV });
        await sut(variant.opts);

        // Assert
        expect(refTail(pair.ours)).toEqual(refTail(pair.peer));
        expect(origHeadOf(pair.ours)).not.toBe('');
      });
    });
  });

  describe('Given a detached HEAD and an edited file', () => {
    describe('When git and tsgit push', () => {
      it('Then no HEAD entry is written and ORIG_HEAD names HEAD as git does', async () => {
        // Arrange
        await arrange(true);
        const sut = repo.stash.push;

        // Act
        runGit(['-C', pair.peer, 'stash', 'push', '-q'], { env: COMMIT_ENV });
        await sut({});

        // Assert
        expect(refTail(pair.ours)).toEqual(refTail(pair.peer));
        expect(origHeadOf(pair.ours)).not.toBe('');
      });
    });
  });

  describe('Given two pushes in a row', () => {
    describe('When git and tsgit push twice', () => {
      it('Then the HEAD reflog holds two reset entries as git does', async () => {
        // Arrange
        await arrange(false);
        const sut = repo.stash.push;

        // Act
        runGit(['-C', pair.peer, 'stash', 'push', '-q'], { env: COMMIT_ENV });
        fileWith('f', 'edited again\n')(pair.peer);
        await sut({});
        fileWith('f', 'edited again\n')(pair.ours);
        runGit(['-C', pair.peer, 'stash', 'push', '-q'], { env: COMMIT_ENV });
        await sut({});

        // Assert
        expect(refTail(pair.ours)).toEqual(refTail(pair.peer));
        expect(
          (refTail(pair.ours) as { head: string[] }).head.filter((e) =>
            e.endsWith('reset: moving to HEAD'),
          ),
        ).toHaveLength(2);
      });
    });
  });
});

const HOOK_LOG = 'hook-log';
const APPEND_ARGS_HOOK = `#!/bin/sh\nprintf '%s\\n' "$*" >> "$(git rev-parse --git-dir)/${HOOK_LOG}"\n`;

const installLoggingHook = (dir: string): void => {
  const hook = path.join(dir, '.git', 'hooks', 'post-checkout');
  writeFileSync(hook, APPEND_ARGS_HOOK);
  chmodSync(hook, 0o755);
};

const hookLogOf = (dir: string): string => {
  const file = path.join(dir, '.git', HOOK_LOG);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

const stagedListing = (dir: string): string => runGit(['-C', dir, 'ls-files', '-s']).toString();

const POST_CHECKOUT_VARIANTS = {
  'a keep-index push': { git: ['--keep-index'], opts: { keepIndex: true }, fires: true },
  'an include-untracked keep-index push': {
    git: ['-u', '--keep-index'],
    opts: { includeUntracked: true, keepIndex: true },
    fires: true,
  },
  'a plain push': { git: [], opts: {}, fires: false },
  'an include-untracked push': { git: ['-u'], opts: { includeUntracked: true }, fires: false },
};

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'stash push post-checkout interop',
  () => {
    let pair: PeerPair;
    let repo: Repository;

    beforeEach(async () => {
      pair = await makePeerPair('stash-push-post-checkout');
    });

    afterEach(async () => {
      await repo?.dispose();
      await pair.dispose();
    });

    const arrange = async (): Promise<void> => {
      const tracked = [v1('f'), regular('g', 'g1\n')];
      for (const dir of [pair.peer, pair.ours]) {
        runGit(['init', '-q', '-b', 'main', dir]);
        buildHistory(dir, tracked, tracked);
        settleIndex(dir);
        runGit(['-C', dir, 'config', 'user.name', 'Ada']);
        runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);
        fileWith('f', 'staged\n')(dir);
        runGit(['-C', dir, 'add', 'f']);
        fileWith('f', 'edited\n')(dir);
        fileWith('u', 'untracked\n')(dir);
        installLoggingHook(dir);
      }
      repo = await openRepository({ cwd: pair.ours });
    };

    describe.each(Object.entries(POST_CHECKOUT_VARIANTS))(
      'Given a staged and an edited file and %s',
      (_n, variant) => {
        describe('When git and tsgit push', () => {
          it('Then the post-checkout log, the index and the listing match git', async () => {
            // Arrange
            await arrange();
            const sut = repo.stash.push;

            // Act
            runGit(['-C', pair.peer, 'stash', 'push', '-q', ...variant.git], { env: COMMIT_ENV });
            await sut(variant.opts);

            // Assert
            expect(hookLogOf(pair.ours)).toBe(hookLogOf(pair.peer));
            expect(hookLogOf(pair.ours) !== '').toBe(variant.fires);
            expect(stagedListing(pair.ours)).toBe(stagedListing(pair.peer));
            expect(listing(pair.ours)).toEqual(listing(pair.peer));
          });
        });
      },
    );
  },
);

const MARKER_FILES = [
  'MERGE_HEAD',
  'MERGE_MODE',
  'MERGE_MSG',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'sequencer',
  'rebase-merge',
];
const PLANTED_MARKERS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD'];
const EDIT_FIRST_PICK = "sed -i.bak '1s/^pick/edit/'";

const gitIn = (dir: string, args: string[], env: NodeJS.ProcessEnv = COMMIT_ENV): void => {
  tryRunGitWithExit(['-C', dir, ...args], { env });
};

const seedBranches = (dir: string): void => {
  runGit(['init', '-q', '-b', 'main', dir]);
  const base = commitOn(dir, [KEEP, regular('f', 'base\n')]);
  const side = commitOn(dir, [KEEP, regular('f', 'side\n')], base);
  const main = commitOn(dir, [KEEP, regular('f', 'main\n')], base);
  runGit(['-C', dir, 'update-ref', 'refs/heads/main', main]);
  runGit(['-C', dir, 'update-ref', 'refs/heads/side', side]);
  runGit(['-C', dir, 'reset', '-q', '--hard', 'main']);
};

const resolveAndEdit = (dir: string): void => {
  fileWith('f', 'resolved\n')(dir);
  runGit(['-C', dir, 'add', 'f']);
  fileWith('keep', 'edited\n')(dir);
};

const plantMarker = (marker: string) => (dir: string) => {
  seedBranches(dir);
  const head = runGit(['-C', dir, 'rev-parse', 'HEAD']).trim();
  writeFileSync(path.join(dir, '.git', marker), `${head}\n`);
  fileWith('f', 'edited\n')(dir);
};

const PENDING_SHAPES: Record<string, (dir: string) => void> = {
  'a resolved merge': (dir) => {
    seedBranches(dir);
    gitIn(dir, ['merge', '-q', 'side']);
    resolveAndEdit(dir);
  },
  'a resolved cherry-pick': (dir) => {
    seedBranches(dir);
    gitIn(dir, ['cherry-pick', 'side']);
    resolveAndEdit(dir);
  },
  'a rebase stopped at an edit': (dir) => {
    runGit(['init', '-q', '-b', 'main', dir]);
    for (const name of ['a', 'b', 'c']) {
      fileWith(name, `${name}\n`)(dir);
      runGit(['-C', dir, 'add', name]);
      runGit(['-C', dir, 'commit', '-q', '-m', name], { env: COMMIT_ENV });
    }
    gitIn(dir, ['rebase', '-i', '--root'], { ...COMMIT_ENV, GIT_SEQUENCE_EDITOR: EDIT_FIRST_PICK });
    fileWith('a', 'edited\n')(dir);
  },
  ...Object.fromEntries(
    PLANTED_MARKERS.map((marker) => [`a planted ${marker}`, plantMarker(marker)]),
  ),
};

const pendingObservation = (dir: string): unknown => ({
  stash: existsSync(path.join(dir, '.git', 'refs', 'stash')),
  markers: MARKER_FILES.filter((name) => existsSync(path.join(dir, '.git', name))),
  headTop: logEntries(dir, 'HEAD').at(-1)?.split(' ').slice(2).join(' '),
  origHead: origHeadOf(dir),
});

describe.skipIf(!GIT_AVAILABLE)('stash push pending operation interop', () => {
  let pair: PeerPair;
  let repo: Repository;

  beforeEach(async () => {
    pair = await makePeerPair('stash-push-pending');
  });

  afterEach(async () => {
    await repo?.dispose();
    await pair.dispose();
  });

  describe.each(Object.entries(PENDING_SHAPES))('Given %s and an edited file', (_name, plant) => {
    describe('When git and tsgit stash push', () => {
      it('Then both save the stash and leave the same markers, HEAD log and ORIG_HEAD', async () => {
        // Arrange
        for (const dir of [pair.peer, pair.ours]) {
          plant(dir);
          runGit(['-C', dir, 'config', 'user.name', 'Ada']);
          runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);
          rmSync(path.join(dir, '.git', 'ORIG_HEAD'), { force: true });
        }
        repo = await openRepository({ cwd: pair.ours });
        const sut = repo.stash.push;

        // Act
        const git = tryRunGitWithExit(['-C', pair.peer, 'stash', 'push', '-q'], {
          env: COMMIT_ENV,
        });
        await sut({});

        // Assert
        expect(git.exitCode).toBe(0);
        expect(pendingObservation(pair.ours)).toEqual(pendingObservation(pair.peer));
        expect((pendingObservation(pair.peer) as { stash: boolean }).stash).toBe(true);
      });
    });
  });
});

const SWAP_SEED = [
  regular('d/x', 'x\n'),
  regular('n/s/y', 'y\n'),
  regular('f', 'f\n'),
  symlink('l', 'keep'),
];

const SWAPS: Record<string, (dir: string) => void> = {
  'a directory swapped for a file': (dir) => {
    rmSync(path.join(dir, 'd'), { recursive: true });
    fileWith('d', 'untracked\n')(dir);
  },
  'a nested directory swapped for a file': (dir) => {
    rmSync(path.join(dir, 'n'), { recursive: true });
    fileWith('n', 'untracked\n')(dir);
  },
  'a file swapped for a directory': (dir) => {
    rmSync(path.join(dir, 'f'));
    fileWith('f/y', 'untracked\n')(dir);
  },
  'a symlink swapped for a directory': (dir) => {
    rmSync(path.join(dir, 'l'));
    fileWith('l/y', 'untracked\n')(dir);
  },
};

const treeAt = (dir: string, rev: string): string =>
  runGit(['-C', dir, 'rev-parse', `${rev}^{tree}`])
    .toString()
    .trim();

describe.skipIf(!GIT_AVAILABLE)('stash push include-untracked interop', () => {
  let pair: PeerPair;
  let repo: Repository;

  beforeEach(async () => {
    pair = await makePeerPair('stash-push-untracked');
  });

  afterEach(async () => {
    await repo?.dispose();
    await pair.dispose();
  });

  const indexInode = indexIdentity;
  const inodesBefore = new Map<string, string>();

  const arrange = async (
    edit: (dir: string) => void,
    seed: ReadonlyArray<TreeEntry> = SWAP_SEED,
  ): Promise<void> => {
    for (const dir of [pair.peer, pair.ours]) {
      runGit(['init', '-q', '-b', 'main', dir]);
      buildHistory(dir, seed, seed);
      settleIndex(dir);
      touchedAt('keep')(dir);
      inodesBefore.set(dir, indexInode(dir));
      rmSync(path.join(dir, '.git', 'ORIG_HEAD'), { force: true });
      runGit(['-C', dir, 'config', 'user.name', 'Ada']);
      runGit(['-C', dir, 'config', 'user.email', 'ada@example.com']);
      edit(dir);
    }
    repo = await openRepository({ cwd: pair.ours });
  };

  const expectSameIndexOutcome = (): void => {
    expect(indexState(pair.ours)).toEqual(indexState(pair.peer));
    expect(staleEntries(pair.ours)).toEqual(staleEntries(pair.peer));
    const rewritten = (dir: string): boolean => indexInode(dir) !== inodesBefore.get(dir);
    expect(rewritten(pair.ours)).toBe(rewritten(pair.peer));
  };

  describe.each(Object.entries(SWAPS))('Given %s', (_name, swap) => {
    describe('When git and tsgit stash push -u', () => {
      it('Then both save, reset the tree and write the same ref tail', async () => {
        // Arrange
        await arrange(swap);
        const sut = repo.stash.push;

        // Act
        runGit(['-C', pair.peer, 'stash', 'push', '-q', '-u'], { env: COMMIT_ENV });
        const result = await sut({ includeUntracked: true });

        // Assert
        expect(result.kind).toBe('saved');
        expect(listing(pair.ours)).toEqual(listing(pair.peer));
        for (const rev of ['stash@{0}', 'stash@{0}^2', 'stash@{0}^3']) {
          expect(treeAt(pair.ours, rev)).toBe(treeAt(pair.peer, rev));
        }
        expect(refTail(pair.ours)).toEqual(refTail(pair.peer));
        expectSameIndexOutcome();
      });
    });
  });

  const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const gitOut = (dir: string, args: string[]): string =>
    runGit(['-C', dir, ...args])
      .toString()
      .trim();

  const PUSH_FLAGS = [
    { name: 'quietly', git: [], ours: {} },
    { name: '-u', git: ['-u'], ours: { includeUntracked: true } },
  ] as const;

  const stageGitlinkOver =
    (stand: (dir: string) => void) =>
    (dir: string): void => {
      const head = gitOut(dir, ['rev-parse', 'HEAD']);
      runGit(['-C', dir, 'rm', '-q', '--cached', 'f']);
      runGit(['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${head},f`]);
      rmSync(path.join(dir, 'f'), { force: true });
      stand(dir);
    };

  const GITLINK_STAND_INS: Record<string, (dir: string) => void> = {
    'a regular file': fileWith('f', 'precious\n'),
    'a symlink': linkAt('f', 'target'),
    nothing: () => undefined,
    'a directory holding an untracked file': fileWith('f/u', 'u\n'),
  };

  describe.each(Object.entries(GITLINK_STAND_INS))(
    'Given an index gitlink with %s standing at its path',
    (_name, stand) => {
      describe.each(PUSH_FLAGS)('When git and tsgit stash push $name', (push) => {
        it('Then both stash the same trees, reset the same tree and leave the same index', async () => {
          // Arrange
          await arrange(stageGitlinkOver(stand));
          const sut = repo.stash.push;

          // Act
          runGit(['-C', pair.peer, 'stash', 'push', '-q', ...push.git], { env: COMMIT_ENV });
          const result = await sut(push.ours);

          // Assert
          expect(result.kind).toBe('saved');
          expect(listing(pair.ours)).toEqual(listing(pair.peer));
          for (const rev of ['stash@{0}', 'stash@{0}^2']) {
            expect(treeAt(pair.ours, rev)).toBe(treeAt(pair.peer, rev));
          }
          expect(refTail(pair.ours)).toEqual(refTail(pair.peer));
          expectSameIndexOutcome();
        });
      });
    },
  );

  describe.each([
    ['a regular file', fileWith('f', 'precious\n')],
    ['a symlink', linkAt('f', 'target')],
  ] as const)('Given an index gitlink with %s standing at its path', (_name, stand) => {
    describe.each(PUSH_FLAGS)('When git and tsgit stash push $name then apply', (push) => {
      it('Then both bring the path back the same', async () => {
        // Arrange
        await arrange(stageGitlinkOver(stand));
        const sut = repo.stash;

        // Act
        runGit(['-C', pair.peer, 'stash', 'push', '-q', ...push.git], { env: COMMIT_ENV });
        await sut.push(push.ours);
        runGit(['-C', pair.peer, 'stash', 'apply', '-q'], { env: COMMIT_ENV });
        await sut.apply();

        // Assert
        expect(listing(pair.ours)).toEqual(listing(pair.peer));
        expect(indexState(pair.ours)).toEqual(indexState(pair.peer));
        expect(staleEntries(pair.ours)).toEqual(staleEntries(pair.peer));
      });
    });
  });

  const withTop = (dir: string): void => fileWith('keep', 'edited\n')(dir);
  const HEAD_ONLY_SEED = [...SWAP_SEED, gitlink('sub')];
  const loseGitlink = (stand: (dir: string) => void) => (dir: string) => {
    runGit(['-C', dir, 'rm', '-q', '--cached', 'sub']);
    rmSync(path.join(dir, 'sub'), { recursive: true, force: true });
    stand(dir);
  };

  const LOST_GITLINK_STAND_INS: Record<string, (dir: string) => void> = {
    'a regular file': fileWith('sub', 'precious\n'),
    'a symlink': linkAt('sub', 'target'),
    nothing: () => undefined,
    'an empty directory': emptyDirectoryAt('sub'),
  };

  describe.each(Object.entries(LOST_GITLINK_STAND_INS))(
    'Given a HEAD gitlink the index lost with %s standing at its path and another file edited',
    (_name, stand) => {
      describe.each(PUSH_FLAGS)('When git and tsgit stash push $name', (push) => {
        it('Then both stash the same trees and leave the same tree and index', async () => {
          // Arrange
          await arrange((dir) => {
            loseGitlink(stand)(dir);
            withTop(dir);
          }, HEAD_ONLY_SEED);
          const sut = repo.stash.push;

          // Act
          runGit(['-C', pair.peer, 'stash', 'push', '-q', ...push.git], { env: COMMIT_ENV });
          const result = await sut(push.ours);

          // Assert
          expect(result.kind).toBe('saved');
          expect(listing(pair.ours)).toEqual(listing(pair.peer));
          for (const rev of ['stash@{0}', 'stash@{0}^2']) {
            expect(treeAt(pair.ours, rev)).toBe(treeAt(pair.peer, rev));
          }
          expect(refTail(pair.ours)).toEqual(refTail(pair.peer));
          expectSameIndexOutcome();
        });
      });
    },
  );

  describe.each(Object.entries(LOST_GITLINK_STAND_INS))(
    'Given a HEAD gitlink the index lost with %s standing at its path and nothing else changed',
    (_name, stand) => {
      describe('When git and tsgit stash push', () => {
        it('Then neither saves and no stash ref exists', async () => {
          // Arrange
          await arrange(loseGitlink(stand), HEAD_ONLY_SEED);
          const sut = repo.stash.push;

          // Act
          const git = tryRunGitWithExit(['-C', pair.peer, 'stash', 'push', '-q'], {
            env: COMMIT_ENV,
          });
          const result = await sut({});

          // Assert
          expect(git.exitCode).toBe(0);
          expect(result).toStrictEqual({ kind: 'no-local-changes' });
          expect(existsSync(path.join(pair.peer, '.git', 'refs', 'stash'))).toBe(false);
          expect(existsSync(path.join(pair.ours, '.git', 'refs', 'stash'))).toBe(false);
        });
      });
    },
  );

  describe('Given a gitlink in HEAD and the index with nothing standing at its path and another file edited', () => {
    describe.each(PUSH_FLAGS)('When git and tsgit stash push $name', (push) => {
      it('Then both drop the gitlink from W and leave the same tree', async () => {
        // Arrange
        await arrange((dir) => {
          rmSync(path.join(dir, 'sub'), { recursive: true, force: true });
          withTop(dir);
        }, HEAD_ONLY_SEED);
        const sut = repo.stash.push;

        // Act
        runGit(['-C', pair.peer, 'stash', 'push', '-q', ...push.git], { env: COMMIT_ENV });
        const result = await sut(push.ours);

        // Assert
        expect(result.kind).toBe('saved');
        expect(listing(pair.ours)).toEqual(listing(pair.peer));
        for (const rev of ['stash@{0}', 'stash@{0}^2']) {
          expect(treeAt(pair.ours, rev)).toBe(treeAt(pair.peer, rev));
        }
        expect(refTail(pair.ours)).toEqual(refTail(pair.peer));
        expectSameIndexOutcome();
      });
    });
  });

  const COMMITTED_GITLINK_SEED = [...SWAP_SEED, gitlink('m'), gitlink('lead/m')];
  const outsideOf = (dir: string): string => `${dir}-outside`;
  const redirectLeadingDirectory =
    (holder: (outside: string) => void) =>
    (dir: string): void => {
      const outside = outsideOf(dir);
      mkdirSync(outside, { recursive: true });
      holder(outside);
      rmSync(path.join(dir, 'lead'), { recursive: true, force: true });
      symlinkSync(path.relative(dir, outside), path.join(dir, 'lead'));
    };
  const replacingGitlink = (stand: (dir: string) => void) => (dir: string) => {
    rmSync(path.join(dir, 'm'), { recursive: true, force: true });
    stand(dir);
  };

  const COMMITTED_GITLINK_STAND_INS: Record<string, (dir: string) => void> = {
    'a regular file': replacingGitlink(fileWith('m', 'precious\n')),
    'a symlink': replacingGitlink(linkAt('m', 'target')),
    'a symlink to a directory': replacingGitlink(linkAt('m', 'd')),
    nothing: replacingGitlink(() => undefined),
  };

  const BEYOND_SYMLINK_STAND_INS: Record<string, (dir: string) => void> = {
    'a symlinked leading directory over a file': redirectLeadingDirectory((outside) =>
      writeFileSync(path.join(outside, 'm'), 'outside\n'),
    ),
    'a symlinked leading directory over nothing': redirectLeadingDirectory(() => undefined),
  };

  describe.each(Object.entries(COMMITTED_GITLINK_STAND_INS))(
    'Given a gitlink in HEAD and the index with %s at its path and nothing else changed',
    (_name, stand) => {
      describe.each(PUSH_FLAGS)('When git and tsgit stash push $name', (push) => {
        it('Then neither saves, no stash ref exists and the work tree is untouched', async () => {
          // Arrange
          await arrange(stand, COMMITTED_GITLINK_SEED);
          const before = listing(pair.ours);
          const sut = repo.stash.push;

          // Act
          const git = tryRunGitWithExit(['-C', pair.peer, 'stash', 'push', '-q', ...push.git], {
            env: COMMIT_ENV,
          });
          const result = await sut(push.ours);

          // Assert
          expect(git.exitCode).toBe(0);
          expect(result).toStrictEqual({ kind: 'no-local-changes' });
          expect(existsSync(path.join(pair.peer, '.git', 'refs', 'stash'))).toBe(false);
          expect(existsSync(path.join(pair.ours, '.git', 'refs', 'stash'))).toBe(false);
          expect(listing(pair.ours)).toEqual(before);
          expect(listing(pair.ours)).toEqual(listing(pair.peer));
        });
      });
    },
  );

  describe.each(Object.entries(BEYOND_SYMLINK_STAND_INS))(
    'Given a gitlink in HEAD and the index with %s and nothing else changed',
    (_name, stand) => {
      describe('When git and tsgit stash push', () => {
        it('Then neither saves, no stash ref exists and the work tree is untouched', async () => {
          // Arrange
          await arrange(stand, COMMITTED_GITLINK_SEED);
          const before = listing(pair.ours);
          const sut = repo.stash.push;

          // Act
          const git = tryRunGitWithExit(['-C', pair.peer, 'stash', 'push', '-q'], {
            env: COMMIT_ENV,
          });
          const result = await sut({});

          // Assert
          expect(git.exitCode).toBe(0);
          expect(result).toStrictEqual({ kind: 'no-local-changes' });
          expect(existsSync(path.join(pair.ours, '.git', 'refs', 'stash'))).toBe(false);
          expect(listing(pair.ours)).toEqual(before);
        });
      });
    },
  );

  const moveGitlink = (dir: string): void => {
    const moved = gitOut(dir, ['rev-parse', 'HEAD']);
    runGit(['-C', dir, 'update-index', '--cacheinfo', `160000,${moved},sub`]);
  };
  const addGitlink = (dir: string): void => {
    const added = gitOut(dir, ['rev-parse', 'HEAD']);
    runGit(['-C', dir, 'update-index', '--add', '--cacheinfo', `160000,${added},sub`]);
  };
  const standingAtSub =
    (stand: (dir: string) => void) =>
    (dir: string): void => {
      rmSync(path.join(dir, 'sub'), { recursive: true, force: true });
      stand(dir);
    };
  const standingAt =
    (name: string, stand: (dir: string) => void) =>
    (dir: string): void => {
      rmSync(path.join(dir, name), { recursive: true, force: true });
      stand(dir);
    };
  const nestedCheckoutAtSub = (dir: string): void => {
    runGit(['-C', path.join(dir, 'sub'), 'init', '-q']);
  };

  interface GitlinkProjection {
    readonly seed: ReadonlyArray<TreeEntry>;
    readonly plant: (dir: string) => void;
  }

  const GITLINK_PROJECTIONS: Record<string, GitlinkProjection> = {
    'a gitlink unmoved from HEAD with a regular file at its path': {
      seed: HEAD_ONLY_SEED,
      plant: standingAtSub(fileWith('sub', 'precious\n')),
    },
    'a gitlink unmoved from HEAD with a symlink at its path': {
      seed: HEAD_ONLY_SEED,
      plant: standingAtSub(linkAt('sub', 'target')),
    },
    'a gitlink unmoved from HEAD with a symlink to a directory at its path': {
      seed: HEAD_ONLY_SEED,
      plant: standingAtSub(linkAt('sub', 'd')),
    },
    'a leading gitlink unmoved from HEAD with a regular file at its path': {
      seed: [...SWAP_SEED, gitlink('a')],
      plant: (dir) => {
        standingAt('a', fileWith('a', 'precious\n'))(dir);
        fileWith('0-untracked', 'u\n')(dir);
      },
    },
    'a leading gitlink unmoved from HEAD with a symlink at its path': {
      seed: [...SWAP_SEED, gitlink('a')],
      plant: standingAt('a', linkAt('a', 'target')),
    },
    'two leading gitlinks unmoved from HEAD with files at their paths': {
      seed: [...SWAP_SEED, gitlink('a'), gitlink('b')],
      plant: (dir) => {
        standingAt('a', fileWith('a', 'precious\n'))(dir);
        standingAt('b', fileWith('b', 'precious\n'))(dir);
      },
    },
    'two gitlinks unmoved from HEAD with files at their paths around an edited file': {
      seed: [...SWAP_SEED, gitlink('a'), regular('b', 'b\n'), gitlink('c')],
      plant: (dir) => {
        standingAt('a', fileWith('a', 'precious\n'))(dir);
        standingAt('c', fileWith('c', 'precious\n'))(dir);
        fileWith('b', 'edited\n')(dir);
      },
    },
    'a deleted gitlink beside a leading gitlink unmoved from HEAD with a file at its path': {
      seed: [...SWAP_SEED, gitlink('a'), gitlink('b')],
      plant: (dir) => {
        rmSync(path.join(dir, 'a'), { recursive: true, force: true });
        standingAt('b', fileWith('b', 'precious\n'))(dir);
      },
    },
    'a lost gitlink beside a leading gitlink unmoved from HEAD with a file at its path': {
      seed: [...SWAP_SEED, gitlink('a'), gitlink('b')],
      plant: (dir) => {
        runGit(['-C', dir, 'rm', '-q', '--cached', 'a']);
        rmSync(path.join(dir, 'a'), { recursive: true, force: true });
        standingAt('b', fileWith('b', 'precious\n'))(dir);
      },
    },
    'a gitlink unmoved from HEAD with a file at its path behind a file the index lost': {
      seed: [...SWAP_SEED, regular('a0', 'a0\n'), gitlink('b')],
      plant: (dir) => {
        runGit(['-C', dir, 'rm', '-q', '--cached', 'a0']);
        standingAt('b', fileWith('b', 'precious\n'))(dir);
      },
    },
    'a gitlink unmoved from HEAD with a file at its path behind a staged-only change': {
      seed: [...SWAP_SEED, regular('a0', 'a0\n'), gitlink('b')],
      plant: (dir) => {
        fileWith('a0', 'staged\n')(dir);
        runGit(['-C', dir, 'add', 'a0']);
        standingAt('b', fileWith('b', 'precious\n'))(dir);
      },
    },
    'a gitlink unmoved from HEAD with a file at its path behind a staged mode change': {
      seed: [...SWAP_SEED, regular('a0', 'a0\n'), gitlink('b')],
      plant: (dir) => {
        chmodSync(path.join(dir, 'a0'), 0o755);
        runGit(['-C', dir, 'add', 'a0']);
        standingAt('b', fileWith('b', 'precious\n'))(dir);
      },
    },
    'a gitlink unmoved from HEAD with a file at its path behind a file lost from the index and the disk':
      {
        seed: [...SWAP_SEED, regular('a0', 'a0\n'), gitlink('b')],
        plant: (dir) => {
          runGit(['-C', dir, 'rm', '-q', '--cached', 'a0']);
          rmSync(path.join(dir, 'a0'));
          standingAt('b', fileWith('b', 'precious\n'))(dir);
        },
      },
    'two leading gitlinks unmoved from HEAD with nothing at their paths': {
      seed: [...SWAP_SEED, gitlink('a'), gitlink('b')],
      plant: (dir) => {
        rmSync(path.join(dir, 'a'), { recursive: true, force: true });
        rmSync(path.join(dir, 'b'), { recursive: true, force: true });
      },
    },
    'a gitlink moved from HEAD with a regular file at its path': {
      seed: HEAD_ONLY_SEED,
      plant: (dir) => {
        moveGitlink(dir);
        standingAtSub(fileWith('sub', 'precious\n'))(dir);
      },
    },
    'a gitlink moved from HEAD with a real checkout at its path': {
      seed: HEAD_ONLY_SEED,
      plant: (dir) => {
        moveGitlink(dir);
        nestedCheckoutAtSub(dir);
      },
    },
    'a gitlink newly staged with nothing at its path': {
      seed: SWAP_SEED,
      plant: (dir) => addGitlink(dir),
    },
  };

  describe.each(PUSH_FLAGS)(
    'Given a gitlink newly staged with a regular file at its path and another file edited, When git and tsgit stash push $name',
    (push) => {
      it('Then both stash the same trees', async () => {
        // Arrange
        await arrange((dir) => {
          addGitlink(dir);
          fileWith('sub', 'precious\n')(dir);
          withTop(dir);
        }, SWAP_SEED);
        const sut = repo.stash.push;

        // Act
        runGit(['-C', pair.peer, 'stash', 'push', '-q', ...push.git], { env: COMMIT_ENV });
        const result = await sut(push.ours);

        // Assert
        expect(result.kind).toBe('saved');
        for (const rev of ['stash@{0}', 'stash@{0}^2']) {
          expect(treeAt(pair.ours, rev)).toBe(treeAt(pair.peer, rev));
        }
        expect(refTail(pair.ours)).toEqual(refTail(pair.peer));
      });
    },
  );

  const ALONE_IS_NO_CHANGE = [
    'a leading gitlink unmoved from HEAD with a regular file at its path',
    'a gitlink unmoved from HEAD with a regular file at its path',
    'a gitlink unmoved from HEAD with a symlink at its path',
    'a gitlink unmoved from HEAD with a symlink to a directory at its path',
    'a gitlink moved from HEAD with a regular file at its path',
  ];

  describe.each(Object.entries(GITLINK_PROJECTIONS))(
    'Given %s and another file edited',
    (_name, shape) => {
      describe.each(PUSH_FLAGS)('When git and tsgit stash push $name', (push) => {
        it('Then both stash the same trees and leave the same tree and index', async () => {
          // Arrange
          await arrange((dir) => {
            shape.plant(dir);
            withTop(dir);
          }, shape.seed);
          const sut = repo.stash.push;

          // Act
          runGit(['-C', pair.peer, 'stash', 'push', '-q', ...push.git], { env: COMMIT_ENV });
          const result = await sut(push.ours);

          // Assert
          expect(result.kind).toBe('saved');
          expect(listing(pair.ours)).toEqual(listing(pair.peer));
          for (const rev of ['stash@{0}', 'stash@{0}^2']) {
            expect(treeAt(pair.ours, rev)).toBe(treeAt(pair.peer, rev));
          }
          expect(refTail(pair.ours)).toEqual(refTail(pair.peer));
          expectSameIndexOutcome();
        });
      });
    },
  );

  describe.each(ALONE_IS_NO_CHANGE)('Given %s and nothing else changed', (name) => {
    describe('When git and tsgit stash push', () => {
      it('Then neither saves, no stash ref exists and the work tree is untouched', async () => {
        // Arrange
        const shape = GITLINK_PROJECTIONS[name];
        if (shape === undefined) throw new Error(`unknown shape ${name}`);
        await arrange(shape.plant, shape.seed);
        const before = listing(pair.ours);
        const sut = repo.stash.push;

        // Act
        const git = tryRunGitWithExit(['-C', pair.peer, 'stash', 'push', '-q'], {
          env: COMMIT_ENV,
        });
        const result = await sut({});

        // Assert
        expect(git.exitCode).toBe(0);
        expect(result).toStrictEqual({ kind: 'no-local-changes' });
        expect(existsSync(path.join(pair.peer, '.git', 'refs', 'stash'))).toBe(false);
        expect(existsSync(path.join(pair.ours, '.git', 'refs', 'stash'))).toBe(false);
        expect(listing(pair.ours)).toEqual(before);
        expect(listing(pair.ours)).toEqual(listing(pair.peer));
      });
    });
  });

  const SHAPES: Record<string, (dir: string) => void> = {
    'an edited file': fileWith('f', 'edited\n'),
    'a staged edit of a file': (dir) => {
      fileWith('f', 'staged\n')(dir);
      runGit(['-C', dir, 'add', 'f']);
    },
  };

  describe.each(Object.entries(SHAPES))('Given %s and no untracked file', (_name, edit) => {
    describe('When git and tsgit stash push -u', () => {
      it('Then the W commit has three parents and an empty untracked tree as git writes', async () => {
        // Arrange
        await arrange(edit);
        const sut = repo.stash.push;

        // Act
        runGit(['-C', pair.peer, 'stash', 'push', '-q', '-u'], { env: COMMIT_ENV });
        await sut({ includeUntracked: true });

        // Assert
        for (const dir of [pair.peer, pair.ours]) {
          expect(
            gitOut(dir, ['rev-list', '--parents', '-n', '1', 'stash@{0}']).split(' '),
          ).toHaveLength(4);
          expect(treeAt(dir, 'stash@{0}^3')).toBe(EMPTY_TREE);
          expect(
            gitOut(dir, ['rev-list', '--parents', '-n', '1', 'stash@{0}^3']).split(' '),
          ).toHaveLength(1);
        }
        const untrackedSubject = (dir: string): string =>
          gitOut(dir, ['log', '-1', '--format=%s', 'stash@{0}^3']);
        expect(untrackedSubject(pair.ours)).toBe(untrackedSubject(pair.peer));
        expectSameIndexOutcome();
      });
    });
  });

  describe('Given an edited f and untracked m/z and deep/er/w', () => {
    describe('When git and tsgit stash push -u', () => {
      it('Then both leave no emptied directory and the same ref tail', async () => {
        // Arrange
        await arrange((dir) => {
          fileWith('f', 'edited\n')(dir);
          fileWith('m/z', 'z\n')(dir);
          fileWith('deep/er/w', 'w\n')(dir);
        });
        const sut = repo.stash.push;

        // Act
        runGit(['-C', pair.peer, 'stash', 'push', '-q', '-u'], { env: COMMIT_ENV });
        await sut({ includeUntracked: true });

        // Assert
        expect(existsSync(path.join(pair.peer, 'm'))).toBe(false);
        expect(existsSync(path.join(pair.peer, 'deep'))).toBe(false);
        expect(existsSync(path.join(pair.ours, 'm'))).toBe(false);
        expect(existsSync(path.join(pair.ours, 'deep'))).toBe(false);
        expect(listing(pair.ours)).toEqual(listing(pair.peer));
        for (const rev of ['stash@{0}', 'stash@{0}^2', 'stash@{0}^3']) {
          expect(treeAt(pair.ours, rev)).toBe(treeAt(pair.peer, rev));
        }
        expect(refTail(pair.ours)).toEqual(refTail(pair.peer));
        expectSameIndexOutcome();
      });
    });
  });

  const EXCLUDED_PATTERNS = ['*.cache', 'build/', 'out/'];
  const excludeAll = (dir: string): void =>
    writeFileSync(path.join(dir, '.git', 'info', 'exclude'), `${EXCLUDED_PATTERNS.join('\n')}\n`);

  interface EmptyDirectoryShape {
    readonly plant: ReadonlyArray<(dir: string) => void>;
    readonly seed?: ReadonlyArray<TreeEntry>;
    readonly withoutTop?: true;
    readonly withoutKeepEdit?: true;
    readonly stageForKeepIndex?: (dir: string) => void;
  }

  const stageKeep = (dir: string): void => {
    runGit(['-C', dir, 'add', 'keep']);
  };

  const EMPTY_DIRECTORY_SHAPES: Record<string, EmptyDirectoryShape> = {
    'an empty directory': { plant: [emptyDirectoryAt('emptydir')] },
    'a nested empty directory': { plant: [emptyDirectoryAt('nest/inner')] },
    'a file beside an empty directory': {
      plant: [fileWith('w/u', 'u\n'), emptyDirectoryAt('w/e')],
    },
    'empty, nested empty and file-holding directories': {
      plant: [emptyDirectoryAt('emptydir'), emptyDirectoryAt('nest/inner'), fileWith('w/u', 'u\n')],
    },
    'two nested empty directories': {
      plant: [emptyDirectoryAt('nest/i1'), emptyDirectoryAt('nest/i2/i3')],
    },
    'an empty directory under a tracked directory': { plant: [emptyDirectoryAt('d/b')] },
    'a file and an empty directory under a tracked directory': {
      plant: [fileWith('d/z', 'z\n'), emptyDirectoryAt('d/e')],
    },
    'an empty directory beside an empty ignored directory': {
      plant: [emptyDirectoryAt('nest/inner'), emptyDirectoryAt('nest/build')],
    },
    'an empty directory and no untracked file': {
      plant: [emptyDirectoryAt('emptydir')],
      withoutTop: true,
    },
    'a tracked file replaced by an empty directory': {
      plant: [
        (dir) => {
          rmSync(path.join(dir, 'f'));
          emptyDirectoryAt('f')(dir);
        },
      ],
      withoutTop: true,
      withoutKeepEdit: true,
      stageForKeepIndex: (dir) => {
        runGit(['-C', dir, 'rm', '-q', '--cached', 'f']);
      },
    },
    'an ignored file beside an untracked file': {
      plant: [fileWith('m/.cache', 'cache\n'), fileWith('m/z', 'z\n')],
    },
    'an empty ignored directory': { plant: [emptyDirectoryAt('build')] },
    'an empty directory under an ignored directory': { plant: [emptyDirectoryAt('out/e')] },
    'an ignored file deep under untracked directories': {
      plant: [fileWith('x/y/.cache', 'cache\n')],
    },
    'an empty ignored directory under an untracked directory': {
      plant: [emptyDirectoryAt('p/build')],
    },
    'a link to a tracked directory': { plant: [linkAt('alias', 'd')] },
    'an empty directory at a gitlink': {
      plant: [],
      seed: [...SWAP_SEED, gitlink('sub')],
    },
  };

  const PUSHES = [
    { name: '-u', git: ['-u'], ours: { includeUntracked: true, keepIndex: false } },
    {
      name: '-u --keep-index',
      git: ['-u', '--keep-index'],
      ours: { includeUntracked: true, keepIndex: true },
    },
  ] as const;

  const statusOf = (dir: string): string =>
    runGit(['-C', dir, 'status', '--porcelain', '-uall']).toString();

  describe.each(Object.entries(EMPTY_DIRECTORY_SHAPES))('Given %s', (_name, shape) => {
    describe.each(PUSHES)('When git and tsgit stash push $name', (push) => {
      it('Then both leave the same work tree, stash trees and index', async () => {
        // Arrange
        const stage = shape.stageForKeepIndex ?? stageKeep;
        await arrange((dir) => {
          excludeAll(dir);
          for (const plant of shape.plant) plant(dir);
          if (shape.withoutKeepEdit === undefined) fileWith('keep', 'edited\n')(dir);
          if (shape.withoutTop === undefined) fileWith('top', 'top\n')(dir);
          if (push.ours.keepIndex === true) stage(dir);
        }, shape.seed);
        const sut = repo.stash.push;

        // Act
        const peerStatus = statusOf(pair.peer);
        const oursStatus = statusOf(pair.ours);
        runGit(['-C', pair.peer, 'stash', 'push', '-q', ...push.git], { env: COMMIT_ENV });
        const result = await sut(push.ours);

        // Assert
        expect(oursStatus).toBe(peerStatus);
        expect(peerStatus.split('\n').filter((line) => line.endsWith('/'))).toEqual([]);
        expect(result.kind).toBe('saved');
        expect(listing(pair.ours)).toEqual(listing(pair.peer));
        for (const rev of ['stash@{0}', 'stash@{0}^2', 'stash@{0}^3']) {
          expect(treeAt(pair.ours, rev)).toBe(treeAt(pair.peer, rev));
        }
        expectSameIndexOutcome();
      });
    });
  });

  describe('Given a clean tree', () => {
    describe('When git and tsgit stash push -u', () => {
      it('Then neither saves and no stash ref exists', async () => {
        // Arrange
        await arrange(() => undefined);
        const sut = repo.stash.push;

        // Act
        const git = tryRunGitWithExit(['-C', pair.peer, 'stash', 'push', '-q', '-u'], {
          env: COMMIT_ENV,
        });
        const result = await sut({ includeUntracked: true });

        // Assert
        expect(git.exitCode).toBe(0);
        expect(result).toEqual({ kind: 'no-local-changes' });
        expect(existsSync(path.join(pair.peer, '.git', 'refs', 'stash'))).toBe(false);
        expect(existsSync(path.join(pair.ours, '.git', 'refs', 'stash'))).toBe(false);
      });
    });
  });
  describe.each(PUSHES)('Given only an empty directory and nothing else changed', (push) => {
    describe(`When git and tsgit stash push ${push.name}`, () => {
      it('Then neither saves, the directory stays and no stash ref exists', async () => {
        // Arrange
        await arrange(emptyDirectoryAt('emptydir'));
        const sut = repo.stash.push;

        // Act
        const git = tryRunGitWithExit(['-C', pair.peer, 'stash', 'push', '-q', ...push.git], {
          env: COMMIT_ENV,
        });
        const result = await sut(push.ours);

        // Assert
        expect(git.exitCode).toBe(0);
        expect(result).toEqual({ kind: 'no-local-changes' });
        expect(listing(pair.ours)).toEqual(listing(pair.peer));
        expect(existsSync(path.join(pair.ours, 'emptydir'))).toBe(true);
        expect(existsSync(path.join(pair.peer, '.git', 'refs', 'stash'))).toBe(false);
        expect(existsSync(path.join(pair.ours, '.git', 'refs', 'stash'))).toBe(false);
      });
    });
  });
});
