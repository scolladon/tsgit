/**
 * Continuing a stopped cherry-pick, rebase or revert writes the index the way
 * git's `write_index_as_tree` does: the resolved path's cache-tree chain is
 * rebuilt (TREE bytes equal git's), the resolve-undo record survives (REUC
 * bytes equal git's), and a clean file touched since the stop has its index
 * stat refreshed, as git's commit refresh does. Each row runs git on one twin
 * and tsgit on the other from a git-built stop.
 *
 * @proves
 *   surface:        cherryPick, rebase, revert
 *   bucket:         cross-tool-interop
 *   unique:         a sequencer --continue rewrites TREE and refreshes a touched clean entry like git
 *   interopSurface: index
 */
import { mkdir, stat, utimes, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { add } from '../../src/application/commands/add.js';
import { cherryPickContinue, cherryPickRun } from '../../src/application/commands/cherry-pick.js';
import { rebaseContinue, rebaseRun } from '../../src/application/commands/rebase.js';
import { revertContinue, revertRun } from '../../src/application/commands/revert.js';
import { readIndex } from '../../src/application/primitives/read-index.js';
import type { Context } from '../../src/ports/context.js';
import {
  GIT_AVAILABLE,
  git,
  makePeerPair,
  type PeerPair,
  runGit,
  tryRunGit,
  tryRunGitWithExit,
} from './interop-helpers.js';

const ROW_TIMEOUT_MS = 60_000;
const PAST_SECONDS = 20;
const TOUCH_SECONDS = 5;
const BYSTANDER = 'c/f';
const RESOLVED = 'fixed\n';

const secondsAgo = (seconds: number): Date => new Date(Date.now() - seconds * 1000);

const write = async (dir: string, file: string, body: string): Promise<void> => {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), body);
};

const commitAll = (dir: string, message: string): void => {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
};

const buildBase = async (dir: string): Promise<void> => {
  runGit(['init', '-q', '-b', 'main', dir]);
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.com');
  git(dir, 'config', 'gc.auto', '0');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.editor', 'true');
  for (const file of ['a/f', 'b/f', BYSTANDER]) await write(dir, file, `${file}\n`);
  commitAll(dir, 'base');
  git(dir, 'checkout', '-q', '-b', 'side');
  await write(dir, 'a/f', 'side\n');
  commitAll(dir, 'side');
  git(dir, 'checkout', '-q', 'main');
  await write(dir, 'a/f', 'main\n');
  commitAll(dir, 'main');
  git(dir, 'checkout', '-q', '-b', 'linear');
  await write(dir, 'a/f', 'one\n');
  commitAll(dir, 'one');
  await write(dir, 'a/f', 'two\n');
  commitAll(dir, 'two');
};

const settleStats = async (dir: string): Promise<void> => {
  const past = secondsAgo(PAST_SECONDS);
  for (const file of git(dir, 'ls-files').split('\n').filter(Boolean)) {
    await utimes(path.join(dir, file), past, past);
  }
  git(dir, 'update-index', '--refresh');
};

interface Operation {
  readonly title: string;
  readonly branch: string;
  readonly gitStop: (dir: string) => void;
  readonly gitContinue: (dir: string) => void;
  readonly tsgitStop: (ctx: Context) => Promise<unknown>;
  readonly tsgitContinue: (ctx: Context) => Promise<unknown>;
}

const OPERATIONS: ReadonlyArray<Operation> = [
  {
    title: 'cherry-pick',
    branch: 'main',
    gitStop: (dir) => void tryRunGit(['-C', dir, 'cherry-pick', 'side']),
    gitContinue: (dir) => void git(dir, 'cherry-pick', '--continue'),
    tsgitStop: (ctx) => cherryPickRun(ctx, { commits: ['side'] }),
    tsgitContinue: (ctx) => cherryPickContinue(ctx),
  },
  {
    title: 'rebase',
    branch: 'side',
    gitStop: (dir) => void tryRunGit(['-C', dir, 'rebase', 'main']),
    gitContinue: (dir) => void git(dir, 'rebase', '--continue'),
    tsgitStop: (ctx) => rebaseRun(ctx, { upstream: 'main' }),
    tsgitContinue: (ctx) => rebaseContinue(ctx),
  },
  {
    title: 'revert',
    branch: 'linear',
    gitStop: (dir) => void tryRunGit(['-C', dir, 'revert', 'linear~1']),
    gitContinue: (dir) => void git(dir, 'revert', '--continue'),
    tsgitStop: (ctx) => revertRun(ctx, { commits: ['linear~1'] }),
    tsgitContinue: (ctx) => revertContinue(ctx),
  },
];

const extensionOf = async (ctx: Context, signature: string): Promise<Uint8Array | undefined> =>
  (await readIndex(ctx)).extensions.find((extension) => extension.signature === signature)?.data;

const entryMtimeOf = async (ctx: Context): Promise<number | undefined> =>
  (await readIndex(ctx)).entries.find((entry) => entry.path === BYSTANDER)?.mtimeSeconds;

const fileMtimeOf = async (dir: string): Promise<number> =>
  Math.floor((await stat(path.join(dir, BYSTANDER))).mtimeMs / 1000);

interface Outcome {
  readonly ours: Context;
  readonly peer: Context;
  readonly pair: PeerPair;
}

const play = async (
  pair: PeerPair,
  operation: Operation,
  touchBystander: boolean,
): Promise<Outcome> => {
  for (const dir of [pair.peer, pair.ours]) {
    await buildBase(dir);
    git(dir, 'checkout', '-q', operation.branch);
    await settleStats(dir);
  }
  const peer = createNodeContext({ workDir: pair.peer });
  const ours = createNodeContext({ workDir: pair.ours });
  operation.gitStop(pair.peer);
  await operation.tsgitStop(ours);
  const touched = secondsAgo(TOUCH_SECONDS);
  for (const dir of [pair.peer, pair.ours]) {
    await write(dir, 'a/f', RESOLVED);
    if (touchBystander) await utimes(path.join(dir, BYSTANDER), touched, touched);
  }
  git(pair.peer, 'add', 'a/f');
  await add(ours, ['a/f']);
  operation.gitContinue(pair.peer);
  await operation.tsgitContinue(ours);
  return { ours, peer, pair };
};

describe.skipIf(!GIT_AVAILABLE)('sequencer continue index interop', () => {
  for (const operation of OPERATIONS) {
    describe(`Given a ${operation.title} stopped on a conflict and resolved with add`, () => {
      describe('When --continue runs in tsgit and in git on a twin', () => {
        let outcome: Outcome;

        beforeAll(async () => {
          outcome = await play(await makePeerPair('seq-continue'), operation, false);
        }, ROW_TIMEOUT_MS);

        afterAll(async () => {
          await outcome.pair.dispose();
        });

        it('Then TREE bytes equal git', async () => {
          // Arrange + Act
          const ours = await extensionOf(outcome.ours, 'TREE');
          const peer = await extensionOf(outcome.peer, 'TREE');

          // Assert
          expect(peer).toBeDefined();
          expect(ours).toEqual(peer);
        });

        it('Then REUC bytes equal git', async () => {
          // Arrange + Act
          const ours = await extensionOf(outcome.ours, 'REUC');
          const peer = await extensionOf(outcome.peer, 'REUC');

          // Assert
          expect(peer).toBeDefined();
          expect(ours).toEqual(peer);
        });

        it('Then git fsck exits 0', () => {
          // Arrange + Act
          const result = tryRunGitWithExit(['-C', outcome.pair.ours, 'fsck']);

          // Assert
          expect(result.exitCode).toBe(0);
        });
      });
    });

    describe(`Given a ${operation.title} resolved while a clean file was touched`, () => {
      describe('When --continue runs in tsgit and in git on a twin', () => {
        let outcome: Outcome;

        beforeAll(async () => {
          outcome = await play(await makePeerPair('seq-continue-touch'), operation, true);
        }, ROW_TIMEOUT_MS);

        afterAll(async () => {
          await outcome.pair.dispose();
        });

        it('Then the touched entry carries the file mtime, as in git', async () => {
          // Arrange + Act
          const ours = await entryMtimeOf(outcome.ours);
          const peer = await entryMtimeOf(outcome.peer);

          // Assert
          expect(peer).toBe(await fileMtimeOf(outcome.pair.peer));
          expect(ours).toBe(await fileMtimeOf(outcome.pair.ours));
        });

        it('Then git fsck exits 0', () => {
          // Arrange + Act
          const result = tryRunGitWithExit(['-C', outcome.pair.ours, 'fsck']);

          // Assert
          expect(result.exitCode).toBe(0);
        });
      });
    });
  }
});
