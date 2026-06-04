/**
 * Cross-tool interop — date-ordered history walk + folded subject. Builds a
 * diamond with a merge commit (strictly-distinct, increasing dates) via
 * canonical `git`, then opens the SAME repo through `openRepository` and proves:
 *
 *   1. `walkCommitsByDate` yields the same oid sequence as
 *      `git rev-list --date-order <merge>` — the all-parents, newest-date-first
 *      order;
 *   2. `foldSubject(message)` equals `git log -1 --format=%s <oid>` for every
 *      reachable commit, including a multi-line subject (the shape that
 *      separates `%s` from a naive first-line split).
 *
 * A merge is required so the order assertion distinguishes the all-parents reach
 * from a first-parent walk. The dates are strictly distinct and causally ordered
 * (parent older than child) — the regime where the lazy walk is byte-for-byte
 * `--date-order` (ADR-261); the deterministic equal-date tie-break is a unit-test
 * concern, and strict ordering under forged reverse-causal dates is out of scope.
 *
 * @proves
 *   surface:        walkCommitsByDate, foldSubject
 *   bucket:         cross-tool-interop
 *   unique:         date-order walk + %s subject match canonical git
 *   interopSurface: walkCommitsByDate
 */
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';
import { foldSubject } from '../../src/domain/objects/commit-message.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv } from './interop-helpers.js';

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

interface Diamond {
  readonly dir: string;
  readonly merge: ObjectId;
  readonly dispose: () => Promise<void>;
}

const buildDiamond = async (): Promise<Diamond> => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-history-interop-')));
  runGit(['init', '-q', '-b', 'main', dir]);

  const commit = async (
    epoch: number,
    file: string,
    content: string,
    message: string,
  ): Promise<void> => {
    await writeFile(path.join(dir, file), content);
    git(dir, 'add', '.');
    runGit(['-C', dir, 'commit', '-q', '-m', message], { env: dateEnv(epoch) });
  };

  // base ← b (main), base ← c (side); merge(b, c). Strictly increasing dates.
  await commit(1700000001, 'base.txt', 'base\n', 'base subject');
  const base = git(dir, 'rev-parse', 'HEAD').trim();
  await commit(1700000002, 'b.txt', 'b\n', 'Fix the parser\nin two lines');
  runGit(['-C', dir, 'checkout', '-q', '-b', 'side', base]);
  await commit(1700000003, 'c.txt', 'c\n', 'side work');
  git(dir, 'checkout', '-q', 'main');
  runGit(['-C', dir, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side'], {
    env: dateEnv(1700000004),
  });

  const merge = git(dir, 'rev-parse', 'HEAD').trim() as ObjectId;
  const dispose = (): Promise<void> => rm(dir, { recursive: true, force: true });
  return { dir, merge, dispose };
};

describe.skipIf(!GIT_AVAILABLE)('history interop', () => {
  describe('Given a diamond with a merge and strictly increasing dates', () => {
    describe('When walkCommitsByDate walks from the merge', () => {
      it('Then the oid sequence equals git rev-list --date-order', async () => {
        // Arrange
        const diamond = await buildDiamond();
        const repo = await openRepository({ cwd: diamond.dir });
        try {
          const peerOrder = git(diamond.dir, 'rev-list', '--date-order', diamond.merge)
            .split('\n')
            .filter((line) => line.length > 0);

          // Act
          const ours: ObjectId[] = [];
          for await (const commit of repo.primitives.walkCommitsByDate({ from: [diamond.merge] })) {
            ours.push(commit.id);
          }

          // Assert
          expect(ours).toEqual(peerOrder);
        } finally {
          await repo.dispose();
          await diamond.dispose();
        }
      });
    });

    describe('When foldSubject folds each commit message', () => {
      it('Then it matches git log --format=%s for every reachable commit', async () => {
        // Arrange
        const diamond = await buildDiamond();
        const repo = await openRepository({ cwd: diamond.dir });
        try {
          // Act
          const mismatches: Array<{ oid: ObjectId; ours: string; peer: string }> = [];
          for await (const commit of repo.primitives.walkCommitsByDate({ from: [diamond.merge] })) {
            const ours = foldSubject(commit.data.message);
            const peer = git(diamond.dir, 'log', '-1', '--format=%s', commit.id).replace(/\n$/, '');
            if (ours !== peer) mismatches.push({ oid: commit.id, ours, peer });
          }

          // Assert — the multi-line subject commit proves the fold, not a split.
          expect(mismatches).toEqual([]);
        } finally {
          await repo.dispose();
          await diamond.dispose();
        }
      });
    });
  });
});
