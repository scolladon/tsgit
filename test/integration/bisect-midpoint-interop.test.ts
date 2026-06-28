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
      const good = commits[0]!;
      const bad = commits[9]!;
      const gitOut = git(dir, 'rev-list', '--bisect-vars', bad, `^${good}`);
      const expected = parseBisectVars(gitOut);

      // Act
      const sut = await bisectMidpoint(ctx, [good as never], bad as never);

      // Assert
      expect(sut).not.toBeUndefined();
      expect(sut?.nextCommit).toBe(expected.rev);
    });

    it('Then tsgit structured counts match git rev-list --bisect-vars', async () => {
      // Arrange
      const good = commits[0]!;
      const bad = commits[9]!;
      const gitOut = git(dir, 'rev-list', '--bisect-vars', bad, `^${good}`);
      const expected = parseBisectVars(gitOut);

      // Act
      const sut = await bisectMidpoint(ctx, [good as never], bad as never);

      // Assert
      expect(sut?.candidateCount).toBe(expected.all);
      expect(sut?.remainingIfGood).toBe(expected.good);
      expect(sut?.remainingIfBad).toBe(expected.bad);
      expect(sut?.remainingSteps).toBe(expected.steps);
    });
  });

  /**
   * Diamond (octopus-union weight) regression guard.
   * Topology: c_root ← c_a1 ← c_a2 ─┐
   *                                    c_bad (merge)
   *           c_root ← c_b1 ← c_b2 ─┘
   *
   * Timestamps: c_a2(ts=+3) is older than c_b2(ts=+4).
   * 5 candidates sorted date-asc: [c_a1, c_b1, c_a2, c_b2, c_bad]
   *
   * Named regression: A2 must win the distance-2 tie over B2 because A2 is
   * older (ts=+3 < ts=+4) → appears first in the date-asc list → fill-phase
   * early-return fires at A2 (weight=2, approxHalfway(2,5)=-1 ∈ [-1,1]).
   * Matches git rev-list --bisect output exactly.
   */
  describe('Given a diamond with A2 older than B2 (distance-2 tie)', () => {
    let dir = '';
    let ctx: Context;
    let cRoot: string;
    let cBad: string;

    beforeAll(async () => {
      dir = await makeRepo('diamond');
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

      // Merge A into B → bad commit (ts=+5)
      cBad = mergeCommit(dir, 'branch-a', 1_700_000_005, 'merge');
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(dir, { recursive: true, force: true }));

    it('Then tsgit nextCommit matches git rev-list --bisect bisect winner (A2)', async () => {
      // Arrange
      const gitWinner = git(dir, 'rev-list', '--bisect', cBad, `^${cRoot}`).trim();
      const gitOut = git(dir, 'rev-list', '--bisect-vars', cBad, `^${cRoot}`);
      const expected = parseBisectVars(gitOut);

      // Act
      const sut = await bisectMidpoint(ctx, [cRoot as never], cBad as never);

      // Assert — winner from both git and tsgit should be A2 (older, first in date-asc list)
      expect(sut).not.toBeUndefined();
      expect(sut?.nextCommit).toBe(gitWinner);
      expect(sut?.nextCommit).toBe(expected.rev);
    });

    it('Then tsgit structured counts match git rev-list --bisect-vars', async () => {
      // Arrange
      const gitOut = git(dir, 'rev-list', '--bisect-vars', cBad, `^${cRoot}`);
      const expected = parseBisectVars(gitOut);

      // Act
      const sut = await bisectMidpoint(ctx, [cRoot as never], cBad as never);

      // Assert
      expect(sut?.candidateCount).toBe(expected.all);
      expect(sut?.remainingIfGood).toBe(expected.good);
      expect(sut?.remainingIfBad).toBe(expected.bad);
      expect(sut?.remainingSteps).toBe(expected.steps);
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
      const head = git(dir, 'rev-parse', 'HEAD').trim();
      const c0 = git(dir, 'rev-parse', 'HEAD~1').trim();

      // Act
      const sut = await bisectMidpoint(ctx, [head as never], c0 as never);

      // Assert
      expect(sut).toBeUndefined();
    });
  });
});
