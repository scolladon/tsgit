/**
 * Cross-tool interop — commit-graph-backed walks (Pin D). Builds one commit
 * history with canonical `git`, then reads it through `openRepository` under
 * FOUR on-disk commit-graph states — absent, single-file
 * (`commit-graph write --reachable`), chain/split (two `--split=no-merge`
 * passes, mirroring Pin D's own empirical reproduction), and a stale chain
 * (a referenced layer file deleted after the split) — proving every form
 * yields the identical oid sequence, both to each other and to real git.
 * The commit-graph is git's own cache: a correct reader changes nothing about
 * the walk's visible set/order, only how cheaply it gets there.
 *
 * @proves
 *   surface:        log (walkCommits / walkCommitsByDate via the commit-graph reader)
 *   bucket:         cross-tool-interop
 *   unique:         commit-graph single-file / chain-split / absent / stale-chain parity
 *   interopSurface: commit-graph
 */
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, git, runGit, runGitAsync, runGitEnv } from './interop-helpers.js';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
} as const;

const dateEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  ...IDENTITY,
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

const oidLines = (out: string): ReadonlyArray<string> =>
  out.split('\n').filter((line) => line.length > 0);

interface Scenario {
  readonly dir: string;
  readonly dispose: () => Promise<void>;
}

/**
 * base ← b (main) and base ← c (side), merge(b, c) — a small diamond with
 * strictly-increasing committer dates. No commit-graph is written here —
 * each test below establishes its own on-disk graph state explicitly, so
 * tests never depend on ordering or on a state a sibling test left behind.
 */
const buildScenario = async (): Promise<Scenario> => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-cgraph-interop-')));
  runGit(['init', '-q', '-b', 'main', dir]);

  const commit = async (epoch: number, file: string, message: string): Promise<void> => {
    await writeFile(path.join(dir, file), `${file}\n`);
    git(dir, 'add', '.');
    runGit(['-C', dir, 'commit', '-q', '-m', message], { env: dateEnv(epoch) });
  };

  await commit(1700000001, 'base.txt', 'base');
  const base = git(dir, 'rev-parse', 'HEAD').trim();
  await commit(1700000002, 'b.txt', 'b on main');
  runGit(['-C', dir, 'checkout', '-q', '-b', 'side', base]);
  await commit(1700000003, 'c.txt', 'c on side');
  git(dir, 'checkout', '-q', 'main');
  runGit(['-C', dir, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side'], {
    env: dateEnv(1700000004),
  });

  const dispose = (): Promise<void> => rm(dir, { recursive: true, force: true });
  return { dir, dispose };
};

const resetCommitGraphState = async (dir: string): Promise<void> => {
  await rm(path.join(dir, '.git', 'objects', 'info', 'commit-graph'), { force: true });
  await rm(path.join(dir, '.git', 'objects', 'info', 'commit-graphs'), {
    recursive: true,
    force: true,
  });
};

/**
 * A genuine two-layer chain (Pin D's own reproduction shape): the first
 * split write from the `side` checkout covers {base, c} (layer 1); the
 * second, from `main`, covers the remaining reachable delta {b, merge}
 * (layer 2) — so the merge commit's two parents resolve one cross-layer
 * (c, in layer 1) and one within its own layer (b). `--split=no-merge`
 * forces two on-disk layers instead of git auto-combining them.
 */
const buildChainGraph = async (dir: string): Promise<void> => {
  await resetCommitGraphState(dir);
  await runGitAsync(['-C', dir, 'checkout', '-q', 'side']);
  await runGitAsync(['-C', dir, 'commit-graph', 'write', '--reachable', '--split=no-merge']);
  await runGitAsync(['-C', dir, 'checkout', '-q', 'main']);
  await runGitAsync(['-C', dir, 'commit-graph', 'write', '--reachable', '--split=no-merge']);
};

const oursOidSequences = async (
  dir: string,
): Promise<{
  readonly dateOrder: ReadonlyArray<string>;
  readonly firstParent: ReadonlyArray<string>;
}> => {
  const repo = await openRepository({ cwd: dir });
  try {
    const dateOrder = (await repo.log()).map((entry) => entry.id);
    const firstParent = (await repo.log({ order: 'first-parent' })).map((entry) => entry.id);
    return { dateOrder, firstParent };
  } finally {
    await repo.dispose();
  }
};

const SETUP_TIMEOUT = 60_000;

describe.skipIf(!GIT_AVAILABLE)('commit-graph walk interop', () => {
  let scenario: Scenario;
  let peerDateOrder: ReadonlyArray<string>;
  let peerFirstParent: ReadonlyArray<string>;

  beforeAll(async () => {
    scenario = await buildScenario();
    peerDateOrder = oidLines(git(scenario.dir, 'log', '--format=%H'));
    peerFirstParent = oidLines(git(scenario.dir, 'log', '--first-parent', '--format=%H'));
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await scenario.dispose();
  }, 60_000);

  // Every test below establishes its OWN on-disk commit-graph state up front
  // (never relies on a sibling test's leftover state), so declaration order
  // is irrelevant to correctness.

  describe('Given the history with no commit-graph on disk', () => {
    describe('When walked', () => {
      it('Then the date-order and first-parent sequences match real git', async () => {
        // Arrange
        await resetCommitGraphState(scenario.dir);

        // Act
        const ours = await oursOidSequences(scenario.dir);

        // Assert
        expect(ours.dateOrder).toEqual(peerDateOrder);
        expect(ours.firstParent).toEqual(peerFirstParent);
      });
    });
  });

  describe('Given a fresh single-file commit-graph (git commit-graph write --reachable)', () => {
    describe('When walked', () => {
      it('Then the date-order and first-parent sequences match real git', async () => {
        // Arrange
        await resetCommitGraphState(scenario.dir);
        await runGitAsync(['-C', scenario.dir, 'commit-graph', 'write', '--reachable']);

        // Act
        const ours = await oursOidSequences(scenario.dir);

        // Assert
        expect(ours.dateOrder).toEqual(peerDateOrder);
        expect(ours.firstParent).toEqual(peerFirstParent);
      });
    });
  });

  describe('Given a genuine two-layer chain/split commit-graph', () => {
    describe('When walked', () => {
      it('Then the date-order and first-parent sequences match real git', async () => {
        // Arrange
        await buildChainGraph(scenario.dir);

        // Act
        const ours = await oursOidSequences(scenario.dir);

        // Assert
        expect(ours.dateOrder).toEqual(peerDateOrder);
        expect(ours.firstParent).toEqual(peerFirstParent);
      });
    });
  });

  describe('Given a chain/split commit-graph whose most-recent layer file was then deleted', () => {
    describe('When walked (stale chain)', () => {
      it('Then it falls back to object reads and the sequences still match real git', async () => {
        // Arrange
        await buildChainGraph(scenario.dir);
        const chainPath = path.join(
          scenario.dir,
          '.git',
          'objects',
          'info',
          'commit-graphs',
          'commit-graph-chain',
        );
        const chainText = await readFile(chainPath, 'utf8');
        const tipHash = chainText.trim().split('\n').at(-1)!;
        await rm(
          path.join(
            scenario.dir,
            '.git',
            'objects',
            'info',
            'commit-graphs',
            `graph-${tipHash}.graph`,
          ),
        );

        // Act
        const ours = await oursOidSequences(scenario.dir);

        // Assert
        expect(ours.dateOrder).toEqual(peerDateOrder);
        expect(ours.firstParent).toEqual(peerFirstParent);
      });
    });
  });
});
