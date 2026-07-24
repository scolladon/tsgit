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

/** A read-only built repo plus the good/bad pair `bisectMidpoint` is run over. */
interface HistoryFixture {
  readonly dir: string;
  readonly ctx: Context;
  readonly good: string;
  readonly bad: string;
}

/**
 * Linear history c0(ts=1000) → c1(ts=1001) → … → c9(ts=1009).
 * good = c0, bad = c9 → 9 candidates {c1..c9}.
 * fill-phase fires at c4 (weight=4, approxHalfway(4,9)=true → diff=-1 ∈ [-1,1]).
 * git rev-list --bisect-vars gives:
 *   bisect_rev = c4, bisect_good = 4, bisect_bad = 3, bisect_all = 9, bisect_steps = 2
 */
const buildLinearHistory = async (): Promise<HistoryFixture> => {
  const dir = await makeRepo('linear');
  const ctx = createNodeContext({ workDir: dir });
  const commits: string[] = [];
  for (let i = 0; i < 10; i += 1) commits.push(addCommit(dir, `c${i}`, 1_700_000_000 + i));
  return { dir, ctx, good: commits[0]!, bad: commits[9]! };
};

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
const buildDiamondUnequalDate = async (): Promise<HistoryFixture> => {
  const dir = await makeRepo('diamond-unequal');
  const ctx = createNodeContext({ workDir: dir });
  const root = addCommit(dir, 'root', 1_700_000_000);

  // Branch A: a1(ts=+1) → a2(ts=+3) — A2 is older than B2
  git(dir, 'checkout', '-b', 'branch-a');
  addCommit(dir, 'a1', 1_700_000_001);
  addCommit(dir, 'a2', 1_700_000_003);

  // Branch B: b1(ts=+2) → b2(ts=+4) — B2 is newer than A2
  git(dir, 'checkout', '-b', 'branch-b', root);
  addCommit(dir, 'b1', 1_700_000_002);
  addCommit(dir, 'b2', 1_700_000_004);

  // Merge A into B → bad commit (ts=+5); M's parents are [b2, a2]
  const bad = mergeCommit(dir, 'branch-a', 1_700_000_005, 'merge');
  return { dir, ctx, good: root, bad };
};

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
const buildEqualDateBFirst = async (): Promise<HistoryFixture> => {
  const dir = await makeRepo('equal-date-bfirst');
  const ctx = createNodeContext({ workDir: dir });
  const root = addCommit(dir, 'root', 1_700_000_000);

  git(dir, 'checkout', '-b', 'branch-a');
  addCommit(dir, 'a1', 1_700_000_001);
  addCommit(dir, 'a2', 1_700_000_003); // same ts as b2

  git(dir, 'checkout', '-b', 'branch-b', root);
  addCommit(dir, 'b1', 1_700_000_002);
  addCommit(dir, 'b2', 1_700_000_003); // same ts as a2

  // Merge branch-a INTO branch-b → M's parents = [b2 (HEAD), a2]
  const bad = mergeCommit(dir, 'branch-a', 1_700_000_005, 'merge');
  return { dir, ctx, good: root, bad };
};

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
const buildEqualDateAFirst = async (): Promise<HistoryFixture> => {
  const dir = await makeRepo('equal-date-afirst');
  const ctx = createNodeContext({ workDir: dir });
  const root = addCommit(dir, 'root', 1_700_000_000);

  git(dir, 'checkout', '-b', 'branch-a');
  addCommit(dir, 'a1', 1_700_000_001);
  addCommit(dir, 'a2', 1_700_000_003); // same ts as b2

  git(dir, 'checkout', '-b', 'branch-b', root);
  addCommit(dir, 'b1', 1_700_000_002);
  addCommit(dir, 'b2', 1_700_000_003); // same ts as a2

  // Merge branch-b INTO branch-a → M's parents = [a2 (HEAD), b2]
  git(dir, 'checkout', 'branch-a');
  const bad = mergeCommit(dir, 'branch-b', 1_700_000_005, 'merge');
  return { dir, ctx, good: root, bad };
};

// Row order matches the fixture-build order below; `index` looks up the
// matching read-only HistoryFixture built once in the shared beforeAll.
const HISTORY_FIXTURE_ROWS: ReadonlyArray<{ label: string; index: number }> = [
  { label: 'linear 10-commit history c0..c9', index: 0 },
  { label: 'diamond, A2 older than B2 (unequal-date tie)', index: 1 },
  { label: 'equal-date diamond, merge b-first (FIFO not oid-asc)', index: 2 },
  { label: 'equal-date diamond, merge a-first (FIFO not oid-asc)', index: 3 },
];

describe.skipIf(!GIT_AVAILABLE)('bisectMidpoint interop', () => {
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

  describe('Given the linear/diamond/equal-date history-fixture matrix', () => {
    let fixtures: HistoryFixture[] = [];

    beforeAll(async () => {
      fixtures = await Promise.all([
        buildLinearHistory(),
        buildDiamondUnequalDate(),
        buildEqualDateBFirst(),
        buildEqualDateAFirst(),
      ]);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await Promise.all(fixtures.map((f) => rm(f.dir, { recursive: true, force: true })));
    });

    it.each(HISTORY_FIXTURE_ROWS)(
      'Then tsgit nextCommit matches git rev-list --bisect winner for "$label"',
      async ({ index }) => {
        // Arrange
        const sut = bisectMidpoint;
        const { dir, ctx, good, bad } = fixtures[index]!;
        const gitWinner = git(dir, 'rev-list', '--bisect', bad, `^${good}`).trim();

        // Act
        const result = await sut(ctx, [good as never], bad as never);

        // Assert
        expect(result).not.toBeUndefined();
        expect(result?.nextCommit).toBe(gitWinner);
      },
    );

    it.each(HISTORY_FIXTURE_ROWS)(
      'Then tsgit structured counts match git rev-list --bisect-vars for "$label"',
      async ({ index }) => {
        // Arrange
        const sut = bisectMidpoint;
        const { dir, ctx, good, bad } = fixtures[index]!;
        const gitOut = git(dir, 'rev-list', '--bisect-vars', bad, `^${good}`);
        const expected = parseBisectVars(gitOut);

        // Act
        const result = await sut(ctx, [good as never], bad as never);

        // Assert
        expect(result?.candidateCount).toBe(expected.all);
        expect(result?.remainingIfGood).toBe(expected.good);
        expect(result?.remainingIfBad).toBe(expected.bad);
        expect(result?.remainingSteps).toBe(expected.steps);
      },
    );
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
