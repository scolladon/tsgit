/**
 * Cross-tool interop — `mergeBase`. Builds repositories with canonical git
 * (deterministic dates, signing off), then asserts that tsgit's merge-base
 * selection matches `git merge-base` faithfully — with and without a
 * commit-graph, and with the graph coming from git itself or from tsgit's
 * own maintenance.
 *
 * @proves
 *   surface:        mergeBase
 *   bucket:         cross-tool-interop
 *   unique:         tsgit's newest-base selection matches `git merge-base`,
 *                   including a same-committer-second tie
 *   interopSurface: mergeBase
 */

import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { mergeBase } from '../../src/application/primitives/merge-base.js';
import type { ObjectId } from '../../src/domain/objects/object-id.js';
import { openRepository } from '../../src/index.node.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, runGit, runGitAsync, runGitEnv } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;

const datedEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'A U Thor',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_NAME: 'A U Thor',
  GIT_COMMITTER_EMAIL: 'author@example.com',
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

const makeRepo = async (slug: string): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-merge-base-${slug}-`));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'A U Thor');
  git(dir, 'config', 'user.email', 'author@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  return dir;
};

/** A commit with no specific committer date — used where the fixture's
 *  shape (not its exact timestamps) drives the expected result. */
const addCommit = (dir: string, name: string): string => {
  writeFileSync(path.join(dir, `${name}.txt`), `${name}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-gpg-sign', '-m', name);
  return git(dir, 'rev-parse', 'HEAD').trim();
};

/** A commit at a specific committer second — used where the fixture
 *  deliberately pins two candidates to the same second. */
const datedCommit = (dir: string, name: string, ts: number): string => {
  writeFileSync(path.join(dir, `${name}.txt`), `${name}\n`);
  runGit(['-C', dir, 'add', '-A']);
  runGit(['-C', dir, 'commit', '-q', '--no-gpg-sign', '-m', name], { env: datedEnv(ts) });
  return git(dir, 'rev-parse', 'HEAD').trim();
};

/** Merge a branch (by name) into HEAD; parents are [current HEAD, theirs]. */
const mergeBranch = (dir: string, theirBranch: string, msg: string): string => {
  git(dir, 'merge', '--no-ff', '--no-gpg-sign', '-m', msg, theirBranch);
  return git(dir, 'rev-parse', 'HEAD').trim();
};

/** Merge a specific commit (by sha, not a moving branch ref) into HEAD at a
 *  specific committer second — required for the criss-cross fixture, where
 *  merging "the other branch name" after the first merge has already moved
 *  that ref would silently pull the first merge in too. */
const mergeShaDated = (dir: string, theirSha: string, ts: number, msg: string): string => {
  runGit(['-C', dir, 'merge', '--no-ff', '--no-gpg-sign', '-m', msg, theirSha], {
    env: datedEnv(ts),
  });
  return git(dir, 'rev-parse', 'HEAD').trim();
};

const asSortedSet = (ids: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(ids)].sort();

/**
 * A history with a merged side branch and a branch (`topic`) forked partway
 * through it: `main` m0, m1 (`side` forks here), m2, m3 = `--no-ff` merge of
 * `side`, m4; `side` s0, s1 (`topic` forks here), s2, s3; `topic` t0. Since
 * `side`'s tip is itself an ancestor of `main` after the merge, and `topic`
 * forks from a point on `side`, every merge-base row below is topologically
 * forced — no committer-date tie-break is exercised here (that is the
 * criss-cross fixture's job).
 */
const buildForkedSideHistory = async (): Promise<{ dir: string; ctx: Context }> => {
  const dir = await makeRepo('forked-side-history');
  const ctx = createNodeContext({ workDir: dir });
  addCommit(dir, 'm0');
  const m1 = addCommit(dir, 'm1');
  git(dir, 'checkout', '-q', '-b', 'side', m1);
  addCommit(dir, 's0');
  const s1 = addCommit(dir, 's1');
  git(dir, 'checkout', '-q', '-b', 'topic', s1);
  addCommit(dir, 't0');
  git(dir, 'checkout', '-q', 'side');
  addCommit(dir, 's2');
  addCommit(dir, 's3');
  git(dir, 'checkout', '-q', 'main');
  addCommit(dir, 'm2');
  mergeBranch(dir, 'side', 'merge side into main');
  addCommit(dir, 'm4');
  return { dir, ctx };
};

/**
 * A criss-cross whose two bases (B on `b1`, C on `main`) share a committer
 * second: `d1` = C with B merged in (parents [C, B]); `e1` = B with C merged
 * in (parents [B, C]), merging the ORIGINAL C sha so the second merge does
 * not accidentally pull in the first (which has already advanced `main`).
 */
const buildSameSecondCrissCross = async (): Promise<{ dir: string; ctx: Context }> => {
  const dir = await makeRepo('same-second-criss-cross');
  const ctx = createNodeContext({ workDir: dir });
  datedCommit(dir, 'a', 1_700_000_000);
  git(dir, 'checkout', '-q', '-b', 'b1');
  const b = datedCommit(dir, 'b', 1_700_000_100);
  git(dir, 'checkout', '-q', 'main');
  const c = datedCommit(dir, 'c', 1_700_000_100);
  mergeShaDated(dir, b, 1_700_000_200, 'd1');
  git(dir, 'checkout', '-q', 'b1');
  mergeShaDated(dir, c, 1_700_000_200, 'e1');
  return { dir, ctx };
};

describe.skipIf(!GIT_AVAILABLE)('mergeBase interop', () => {
  describe('Given a history with a merged side branch and a fork mid-branch', () => {
    let dir = '';
    let ctx: Context;
    let main = '' as ObjectId;
    let topic = '' as ObjectId;
    let side = '' as ObjectId;

    beforeAll(async () => {
      const built = await buildForkedSideHistory();
      dir = built.dir;
      ctx = built.ctx;
      main = git(dir, 'rev-parse', 'main').trim() as ObjectId;
      topic = git(dir, 'rev-parse', 'topic').trim() as ObjectId;
      side = git(dir, 'rev-parse', 'side').trim() as ObjectId;
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(dir, { recursive: true, force: true }));

    describe('When run with no commit-graph', () => {
      it('Then the single result matches git merge-base main topic', async () => {
        // Arrange
        const expected = git(dir, 'merge-base', main, topic).trim();

        // Act
        const result = await mergeBase(ctx, [main, topic]);

        // Assert
        expect(result).toEqual([expected]);
      });

      it('Then the { all: true } result set matches git merge-base --all main topic', async () => {
        // Arrange
        const expected = git(dir, 'merge-base', '--all', main, topic).trim().split('\n');

        // Act
        const result = await mergeBase(ctx, [main, topic], { all: true });

        // Assert — set equality, not order
        expect(asSortedSet(result)).toEqual(asSortedSet(expected));
      });

      it('Then the octopus fold matches git merge-base --octopus main topic side', async () => {
        // Arrange
        const expected = git(dir, 'merge-base', '--octopus', main, topic, side).trim();

        // Act
        const result = await mergeBase(ctx, [main, topic, side], { octopus: true });

        // Assert
        expect(result).toEqual([expected]);
      });
    });

    describe('When run against a commit-graph git itself wrote', () => {
      it('Then every row still matches, from a fresh Context', async () => {
        // Arrange
        await runGitAsync(['-C', dir, 'commit-graph', 'write', '--reachable']);
        const freshCtx = createNodeContext({ workDir: dir });
        const expectedSingle = git(dir, 'merge-base', main, topic).trim();
        const expectedAll = git(dir, 'merge-base', '--all', main, topic).trim().split('\n');
        const expectedOctopus = git(dir, 'merge-base', '--octopus', main, topic, side).trim();

        // Act
        const single = await mergeBase(freshCtx, [main, topic]);
        const all = await mergeBase(freshCtx, [main, topic], { all: true });
        const octopus = await mergeBase(freshCtx, [main, topic, side], { octopus: true });

        // Assert
        expect(single).toEqual([expectedSingle]);
        expect(asSortedSet(all)).toEqual(asSortedSet(expectedAll));
        expect(octopus).toEqual([expectedOctopus]);
      });
    });

    describe('When the commit-graph is written by tsgit maintenance instead', () => {
      it('Then every row still matches', async () => {
        // Arrange
        const expectedSingle = git(dir, 'merge-base', main, topic).trim();
        const expectedAll = git(dir, 'merge-base', '--all', main, topic).trim().split('\n');
        const repo = await openRepository({ cwd: dir });
        await repo.maintenance({ tasks: ['commit-graph'] });

        // Act
        const single = await repo.primitives.mergeBase([main, topic]);
        const all = await repo.primitives.mergeBase([main, topic], { all: true });

        // Assert
        expect(single).toEqual([expectedSingle]);
        expect(asSortedSet(all)).toEqual(asSortedSet(expectedAll));
      });
    });
  });

  describe('Given a criss-cross whose two bases share a committer second', () => {
    let dir = '';
    let ctx: Context;
    let d1 = '' as ObjectId;
    let e1 = '' as ObjectId;

    beforeAll(async () => {
      const built = await buildSameSecondCrissCross();
      dir = built.dir;
      ctx = built.ctx;
      d1 = git(dir, 'rev-parse', 'main').trim() as ObjectId;
      e1 = git(dir, 'rev-parse', 'b1').trim() as ObjectId;
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(dir, { recursive: true, force: true }));

    describe('When run with no commit-graph', () => {
      it('Then the single result matches git merge-base on the measured tie', async () => {
        // Arrange
        const expected = git(dir, 'merge-base', d1, e1).trim();

        // Act
        const result = await mergeBase(ctx, [d1, e1]);

        // Assert
        expect(result).toEqual([expected]);
      });

      it('Then the { all: true } result set matches git merge-base --all d1 e1', async () => {
        // Arrange
        const expected = git(dir, 'merge-base', '--all', d1, e1).trim().split('\n');

        // Act
        const result = await mergeBase(ctx, [d1, e1], { all: true });

        // Assert
        expect(asSortedSet(result)).toEqual(asSortedSet(expected));
      });
    });

    describe('When run against a commit-graph git itself wrote', () => {
      it('Then the same-second tie still matches git, from a fresh Context', async () => {
        // Arrange
        await runGitAsync(['-C', dir, 'commit-graph', 'write', '--reachable']);
        const freshCtx = createNodeContext({ workDir: dir });
        const expectedSingle = git(dir, 'merge-base', d1, e1).trim();
        const expectedAll = git(dir, 'merge-base', '--all', d1, e1).trim().split('\n');

        // Act
        const single = await mergeBase(freshCtx, [d1, e1]);
        const all = await mergeBase(freshCtx, [d1, e1], { all: true });

        // Assert
        expect(single).toEqual([expectedSingle]);
        expect(asSortedSet(all)).toEqual(asSortedSet(expectedAll));
      });
    });
  });
});
