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
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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
  fileWith,
  KEEP,
  listing,
  observe,
  regular,
  settleIndex,
  statSnapshot,
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

  const refuseAsGit = async (
    shape: (typeof UNMERGED_SHAPES)[keyof typeof UNMERGED_SHAPES],
    variant: (typeof PUSH_VARIANTS)[keyof typeof PUSH_VARIANTS],
  ): Promise<void> => {
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
  };

  describe.each(Object.entries(UNMERGED_SHAPES))('Given an index holding %s', (_name, shape) => {
    describe.each(Object.entries(PUSH_VARIANTS))(
      'When git and tsgit run %s',
      (_variant, variant) => {
        it('Then both refuse and write nothing', async () => {
          await refuseAsGit(shape, variant);
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
