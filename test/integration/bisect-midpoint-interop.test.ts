/**
 * Cross-tool interop — `bisectMidpoint`. Builds repositories with canonical git
 * (deterministic dates, signing off), then asserts that tsgit's structured
 * `BisectMidpoint` fields reconstruct `git rev-list --bisect-vars` faithfully.
 *
 * @proves
 *   surface:        bisectMidpoint
 *   bucket:         cross-tool-interop
 *   unique:         tsgit's bisect data matches `git rev-list --bisect-vars`
 *   interopSurface: bisectMidpoint
 */

import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { bisectMidpoint } from '../../src/application/primitives/bisect-midpoint.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, git, runGit, runGitEnv } from './interop-helpers.js';

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
  const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-bisect-mid-${slug}-`));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'A U Thor');
  git(dir, 'config', 'user.email', 'author@example.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
};

const addCommit = (dir: string, name: string, ts: number): string => {
  writeFileSync(path.join(dir, `${name}.txt`), `${name}\n`);
  git(dir, 'add', '-A');
  runGit(['-C', dir, 'commit', '-q', '--no-gpg-sign', '-m', name], { env: datedEnv(ts) });
  return git(dir, 'rev-parse', 'HEAD').trim();
};

/** Merge two branches into HEAD; parents are [current HEAD, theirs]. */
const mergeCommit = (dir: string, theirBranch: string, ts: number, msg: string): string => {
  runGit(['-C', dir, 'merge', '--no-ff', '--no-gpg-sign', '-m', msg, theirBranch], {
    env: datedEnv(ts),
  });
  return git(dir, 'rev-parse', 'HEAD').trim();
};

interface BisectVars {
  rev: string;
  good: number;
  bad: number;
  all: number;
  steps: number;
}

const parseBisectVars = (output: string): BisectVars => {
  const get = (key: string): string => {
    const m = new RegExp(`^${key}=(.+)$`, 'm').exec(output);
    if (m === null) throw new Error(`parseBisectVars: key '${key}' not found in:\n${output}`);
    return m[1]!.replace(/^'|'$/g, '');
  };
  return {
    rev: get('bisect_rev'),
    good: Number.parseInt(get('bisect_good'), 10),
    bad: Number.parseInt(get('bisect_bad'), 10),
    all: Number.parseInt(get('bisect_all'), 10),
    steps: Number.parseInt(get('bisect_steps'), 10),
  };
};

describe.skipIf(!GIT_AVAILABLE)('bisectMidpoint interop', () => {
  /**
   * Linear history c0(ts=1000) → c1(ts=1001) → … → c9(ts=1009).
   * good = c0, bad = c9 → 9 candidates {c1..c9}.
   * fill-phase fires at c4 (weight=4, approxHalfway(4,9)=true → diff=-1 ∈ [-1,1]).
   * git rev-list --bisect-vars gives:
   *   bisect_rev = c4, bisect_good = 4, bisect_bad = 3, bisect_all = 9, bisect_steps = 2
   */
  describe('Given a linear 10-commit history (c0..c9)', () => {
    let dir = '';
    let ctx: Context;
    const commits: string[] = [];

    beforeAll(async () => {
      dir = await makeRepo('linear');
      ctx = createNodeContext({ workDir: dir });
      for (let i = 0; i < 10; i += 1) commits.push(addCommit(dir, `c${i}`, 1_700_000_000 + i));
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(dir, { recursive: true, force: true }));

    it('Then tsgit nextCommit matches git rev-list --bisect-vars bisect_rev', async () => {
      // Arrange
      const sut = bisectMidpoint;
      const good = commits[0]!;
      const bad = commits[9]!;
      const gitOut = git(dir, 'rev-list', '--bisect-vars', bad, `^${good}`);
      const expected = parseBisectVars(gitOut);

      // Act
      const result = await sut(ctx, [good as never], bad as never);

      // Assert
      expect(result).not.toBeUndefined();
      expect(result?.nextCommit).toBe(expected.rev);
    });

    it('Then tsgit structured counts match git rev-list --bisect-vars', async () => {
      // Arrange
      const sut = bisectMidpoint;
      const good = commits[0]!;
      const bad = commits[9]!;
      const gitOut = git(dir, 'rev-list', '--bisect-vars', bad, `^${good}`);
      const expected = parseBisectVars(gitOut);

      // Act
      const result = await sut(ctx, [good as never], bad as never);

      // Assert
      expect(result?.candidateCount).toBe(expected.all);
      expect(result?.remainingIfGood).toBe(expected.good);
      expect(result?.remainingIfBad).toBe(expected.bad);
      expect(result?.remainingSteps).toBe(expected.steps);
    });

    /**
     * all=1 edge case: good=c8, bad=c9 → 1 candidate {c9}.
     * bisect_good=-1 is the faithful git passthrough (not clamped to 0).
     */
    it('Then all=1 row returns remainingIfGood=-1 matching bisect_good=-1', async () => {
      // Arrange
      const sut = bisectMidpoint;
      const good = commits[8]!;
      const bad = commits[9]!;
      const gitOut = git(dir, 'rev-list', '--bisect-vars', bad, `^${good}`);
      const expected = parseBisectVars(gitOut);

      // Act
      const result = await sut(ctx, [good as never], bad as never);

      // Assert — bisect_good=-1 is the faithful passthrough for all=1
      expect(result?.nextCommit).toBe(expected.rev);
      expect(result?.candidateCount).toBe(1);
      expect(result?.remainingIfGood).toBe(-1);
      expect(result?.remainingIfGood).toBe(expected.good);
      expect(result?.remainingIfBad).toBe(0);
      expect(result?.remainingSteps).toBe(0);
    });

    /**
     * good=[] empty-good case: candidates = full history reachable from bad.
     * git rev-list --bisect <bad> accepts no ^good and returns the midpoint.
     */
    it('Then good=[] uses all bad-reachable commits as candidates', async () => {
      // Arrange — all 10 commits are candidates (c0..c9), bad=c9
      const sut = bisectMidpoint;
      const bad = commits[9]!;
      const gitWinner = git(dir, 'rev-list', '--bisect', bad).trim();

      // Act
      const result = await sut(ctx, [], bad as never);

      // Assert — nextCommit matches git rev-list --bisect with no exclusions
      expect(result).not.toBeUndefined();
      expect(result?.nextCommit).toBe(gitWinner);
      expect(result?.candidateCount).toBe(10);
    });
  });

  /**
   * Diamond (unequal dates) regression guard.
   * Topology: c_root ← c_a1 ← c_a2 ─┐
   *                                    c_bad (merge, on branch-b, merges branch-a)
   *           c_root ← c_b1 ← c_b2 ─┘
   *
   * Timestamps: c_a2(ts=+3) is older than c_b2(ts=+4) — distinct dates.
   * 5 candidates walk order (oldest-first): [a1, b1, a2, b2, bad]
   *
   * A2 must win the distance-2 tie over B2 because A2 is older (ts=+3 < ts=+4)
   * → appears first in the oldest-first list → fill-phase early-return fires at A2.
   * Matches git rev-list --bisect output exactly.
   */
  describe('Given a diamond with A2 older than B2 (unequal-date tie)', () => {
    let dir = '';
    let ctx: Context;
    let cRoot: string;
    let cBad: string;

    beforeAll(async () => {
      dir = await makeRepo('diamond-unequal');
      ctx = createNodeContext({ workDir: dir });

      cRoot = addCommit(dir, 'root', 1_700_000_000);

      // Branch A: a1(ts=+1) → a2(ts=+3) — A2 is older than B2
      git(dir, 'checkout', '-b', 'branch-a');
      addCommit(dir, 'a1', 1_700_000_001);
      addCommit(dir, 'a2', 1_700_000_003);

      // Branch B: b1(ts=+2) → b2(ts=+4) — B2 is newer than A2
      git(dir, 'checkout', '-b', 'branch-b', cRoot);
      addCommit(dir, 'b1', 1_700_000_002);
      addCommit(dir, 'b2', 1_700_000_004);

      // Merge A into B → bad commit (ts=+5); M's parents are [b2, a2]
      cBad = mergeCommit(dir, 'branch-a', 1_700_000_005, 'merge');
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(dir, { recursive: true, force: true }));

    it('Then tsgit nextCommit matches git rev-list --bisect winner (A2)', async () => {
      // Arrange
      const sut = bisectMidpoint;
      const gitWinner = git(dir, 'rev-list', '--bisect', cBad, `^${cRoot}`).trim();
      const gitOut = git(dir, 'rev-list', '--bisect-vars', cBad, `^${cRoot}`);
      const expected = parseBisectVars(gitOut);

      // Act
      const result = await sut(ctx, [cRoot as never], cBad as never);

      // Assert — A2 wins (older → first in oldest-first list → fill fires at A2)
      expect(result).not.toBeUndefined();
      expect(result?.nextCommit).toBe(gitWinner);
      expect(result?.nextCommit).toBe(expected.rev);
    });

    it('Then tsgit structured counts match git rev-list --bisect-vars', async () => {
      // Arrange
      const sut = bisectMidpoint;
      const gitOut = git(dir, 'rev-list', '--bisect-vars', cBad, `^${cRoot}`);
      const expected = parseBisectVars(gitOut);

      // Act
      const result = await sut(ctx, [cRoot as never], cBad as never);

      // Assert
      expect(result?.candidateCount).toBe(expected.all);
      expect(result?.remainingIfGood).toBe(expected.good);
      expect(result?.remainingIfBad).toBe(expected.bad);
      expect(result?.remainingSteps).toBe(expected.steps);
    });
  });

  /**
   * Equal-date diamond — b-first merge direction.
   *
   * Topology: root ← a1(ts=+1) ← a2(ts=+3) ─┐
   *                                             bad (merge on branch-b, merges branch-a)
   *           root ← b1(ts=+2) ← b2(ts=+3) ─┘
   *
   * a2 and b2 share the same committer-date (ts=+3).  M's first parent = b2,
   * second parent = a2.  git's FIFO-stable priority-queue pops b2 before a2
   * (b2 was enqueued first from M's parent[0]).  After limit_list reversal,
   * the oldest-first list is [a1, b1, a2, b2, bad].  Fill fires at a2
   * (weight=2, approxHalfway(2,5)=-1) — git picks a2.
   *
   * The naive oid-ascending tie-break would pick whichever of a2/b2 has the
   * smaller oid — a coin flip that diverges from git on half of all repo
   * contents.  This fixture verifies the FIFO-stable walk fixes that.
   */
  describe('Given an equal-date diamond where M merges branch-a into branch-b (b-first)', () => {
    let dir = '';
    let ctx: Context;
    let cRoot: string;
    let cBad: string;

    beforeAll(async () => {
      dir = await makeRepo('equal-date-bfirst');
      ctx = createNodeContext({ workDir: dir });

      cRoot = addCommit(dir, 'root', 1_700_000_000);

      git(dir, 'checkout', '-b', 'branch-a');
      addCommit(dir, 'a1', 1_700_000_001);
      addCommit(dir, 'a2', 1_700_000_003); // same ts as b2

      git(dir, 'checkout', '-b', 'branch-b', cRoot);
      addCommit(dir, 'b1', 1_700_000_002);
      addCommit(dir, 'b2', 1_700_000_003); // same ts as a2

      // Merge branch-a INTO branch-b → M's parents = [b2 (HEAD), a2]
      cBad = mergeCommit(dir, 'branch-a', 1_700_000_005, 'merge');
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(dir, { recursive: true, force: true }));

    it('Then tsgit nextCommit matches git rev-list --bisect (FIFO walk, not oid-asc)', async () => {
      // Arrange
      const sut = bisectMidpoint;
      const gitWinner = git(dir, 'rev-list', '--bisect', cBad, `^${cRoot}`).trim();

      // Act
      const result = await sut(ctx, [cRoot as never], cBad as never);

      // Assert — git picks a2 (FIFO: b2 inserted first → pops first → list [a1,b1,a2,b2,bad] → fill at a2)
      expect(result).not.toBeUndefined();
      expect(result?.nextCommit).toBe(gitWinner);
    });

    it('Then tsgit structured counts match git rev-list --bisect-vars', async () => {
      // Arrange
      const sut = bisectMidpoint;
      const gitOut = git(dir, 'rev-list', '--bisect-vars', cBad, `^${cRoot}`);
      const expected = parseBisectVars(gitOut);

      // Act
      const result = await sut(ctx, [cRoot as never], cBad as never);

      // Assert
      expect(result?.candidateCount).toBe(expected.all);
      expect(result?.remainingIfGood).toBe(expected.good);
      expect(result?.remainingIfBad).toBe(expected.bad);
      expect(result?.remainingSteps).toBe(expected.steps);
    });
  });

  /**
   * Equal-date diamond — a-first merge direction.
   *
   * Same topology but M's first parent = a2, second parent = b2.
   * FIFO: a2 is enqueued first → pops first → oldest-first list [a1, b1, b2, a2, bad]
   * → fill fires at b2 → git picks b2.
   *
   * Together with the b-first fixture this pins both directions, ensuring the
   * oid-ascending tie-break would fail at least one of the two.
   */
  describe('Given an equal-date diamond where M merges branch-b into branch-a (a-first)', () => {
    let dir = '';
    let ctx: Context;
    let cRoot: string;
    let cBad: string;

    beforeAll(async () => {
      dir = await makeRepo('equal-date-afirst');
      ctx = createNodeContext({ workDir: dir });

      cRoot = addCommit(dir, 'root', 1_700_000_000);

      git(dir, 'checkout', '-b', 'branch-a');
      addCommit(dir, 'a1', 1_700_000_001);
      addCommit(dir, 'a2', 1_700_000_003); // same ts as b2

      git(dir, 'checkout', '-b', 'branch-b', cRoot);
      addCommit(dir, 'b1', 1_700_000_002);
      addCommit(dir, 'b2', 1_700_000_003); // same ts as a2

      // Merge branch-b INTO branch-a → M's parents = [a2 (HEAD), b2]
      git(dir, 'checkout', 'branch-a');
      cBad = mergeCommit(dir, 'branch-b', 1_700_000_005, 'merge');
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(dir, { recursive: true, force: true }));

    it('Then tsgit nextCommit matches git rev-list --bisect (FIFO walk, not oid-asc)', async () => {
      // Arrange
      const sut = bisectMidpoint;
      const gitWinner = git(dir, 'rev-list', '--bisect', cBad, `^${cRoot}`).trim();

      // Act
      const result = await sut(ctx, [cRoot as never], cBad as never);

      // Assert — git picks b2 (FIFO: a2 inserted first → pops first → list [a1,b1,b2,a2,bad] → fill at b2)
      expect(result).not.toBeUndefined();
      expect(result?.nextCommit).toBe(gitWinner);
    });

    it('Then tsgit structured counts match git rev-list --bisect-vars', async () => {
      // Arrange
      const sut = bisectMidpoint;
      const gitOut = git(dir, 'rev-list', '--bisect-vars', cBad, `^${cRoot}`);
      const expected = parseBisectVars(gitOut);

      // Act
      const result = await sut(ctx, [cRoot as never], cBad as never);

      // Assert
      expect(result?.candidateCount).toBe(expected.all);
      expect(result?.remainingIfGood).toBe(expected.good);
      expect(result?.remainingIfBad).toBe(expected.bad);
      expect(result?.remainingSteps).toBe(expected.steps);
    });
  });

  /**
   * Empty candidate set guard: good is a descendant of bad → no candidates.
   */
  describe('Given good is a descendant of bad (inverted range)', () => {
    let dir = '';
    let ctx: Context;

    beforeAll(async () => {
      dir = await makeRepo('empty');
      ctx = createNodeContext({ workDir: dir });
      addCommit(dir, 'c0', 1_700_000_000);
      addCommit(dir, 'c1', 1_700_000_001);
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(dir, { recursive: true, force: true }));

    it('Then bisectMidpoint returns undefined', async () => {
      // Arrange — good=HEAD (c1), bad=c0 (ancestor of good)
      const sut = bisectMidpoint;
      const head = git(dir, 'rev-parse', 'HEAD').trim();
      const c0 = git(dir, 'rev-parse', 'HEAD~1').trim();

      // Act
      const result = await sut(ctx, [head as never], c0 as never);

      // Assert
      expect(result).toBeUndefined();
    });
  });
});
