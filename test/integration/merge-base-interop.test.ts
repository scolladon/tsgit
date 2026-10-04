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
 *   unique:         tsgit picks the base `git merge-base` prints — generation
 *                   order, date order and the discovery-order tie alike
 *   interopSurface: mergeBase
 */

import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { branchDelete } from '../../src/application/commands/branch.js';
import { bundleCreate } from '../../src/application/commands/bundle-create.js';
import { mergeRun } from '../../src/application/commands/merge.js';
import { rebaseRun } from '../../src/application/commands/rebase.js';
import { revList } from '../../src/application/commands/rev-list.js';
import { revParse } from '../../src/application/commands/rev-parse.js';
import { mergeBase } from '../../src/application/primitives/merge-base.js';
import type { ObjectId } from '../../src/domain/objects/object-id.js';
import { openRepository } from '../../src/index.node.js';
import type { Context } from '../../src/ports/context.js';
import {
  GIT_AVAILABLE,
  git,
  runGit,
  runGitAsync,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

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

/** A commit built with plumbing: parent ORDER and committer second are both
 *  exact, which `git merge` / `git commit` cannot express together. */
const plumbingCommit = (
  dir: string,
  tree: string,
  name: string,
  ts: number,
  parents: ReadonlyArray<string>,
): string => {
  const args = ['-C', dir, 'commit-tree', tree];
  for (const parent of parents) args.push('-p', parent);
  return runGit([...args, '-m', name], { env: datedEnv(ts) }).trim();
};

/** A repository whose whole history is built from plumbing commits, with each
 *  named commit reachable from a branch of the same name so a commit-graph
 *  write covers it. */
interface PlumbedHistory {
  readonly dir: string;
  readonly ctx: Context;
  readonly ids: ReadonlyMap<string, ObjectId>;
}

const plumbHistory = async (
  slug: string,
  build: (commit: (name: string, ts: number, parents: ReadonlyArray<string>) => string) => void,
): Promise<PlumbedHistory> => {
  const dir = await makeRepo(slug);
  const tree = git(dir, 'mktree').trim();
  const ids = new Map<string, ObjectId>();
  build((name, ts, parents) => {
    const id = plumbingCommit(dir, tree, name, ts, parents);
    ids.set(name, id as ObjectId);
    git(dir, 'update-ref', `refs/heads/${name}`, id);
    return id;
  });
  return { dir, ctx: createNodeContext({ workDir: dir }), ids };
};

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

        // Assert
        expect(result).toEqual(expected);
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
        expect(all).toEqual(expectedAll);
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
        expect(all).toEqual(expectedAll);
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
        expect(result).toEqual(expected);
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
        expect(all).toEqual(expectedAll);
      });
    });
  });

  describe('Given a split commit-graph chain whose newest layer stores no corrected commit dates', () => {
    let dir = '';
    let ctx: Context;
    let a = '' as ObjectId;
    let z = '' as ObjectId;

    /**
     * A default (`generationVersion=2`) base layer over `root ← merged`, then a
     * `commitGraph.generationVersion=1` layer over the rest. git clears
     * `read_generation_data` across the WHOLE chain, so the walk ranks every
     * commit by topological level; reading the base layer's corrected commit
     * dates alongside the newer layer's levels would rank the two oldest
     * commits billions of units above every tip.
     */
    beforeAll(async () => {
      dir = await makeRepo('mixed-generation-chain');
      const tree = git(dir, 'mktree').trim();
      const commitTree = (name: string, epoch: number, parents: ReadonlyArray<string>): string =>
        plumbingCommit(dir, tree, name, epoch, parents);
      const root = commitTree('root', 1_700_000_100, []);
      const merged = commitTree('merged', 1_700_000_900, [root]);
      git(dir, 'update-ref', 'refs/heads/seed', merged);
      await runGitAsync(['-C', dir, 'commit-graph', 'write', '--reachable', '--split=no-merge']);
      const side = commitTree('side', 1_700_000_300, []);
      const topic = commitTree('topic', 1_700_000_400, [side]);
      a = commitTree('a', 1_700_000_500, [topic, merged]) as ObjectId;
      z = commitTree('z', 1_700_000_500, [topic, merged]) as ObjectId;
      git(dir, 'update-ref', 'refs/heads/a', a);
      git(dir, 'update-ref', 'refs/heads/z', z);
      git(dir, 'update-ref', '-d', 'refs/heads/seed');
      await runGitAsync([
        '-C',
        dir,
        '-c',
        'commitGraph.generationVersion=1',
        'commit-graph',
        'write',
        '--reachable',
        '--split=no-merge',
      ]);
      ctx = createNodeContext({ workDir: dir });
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(dir, { recursive: true, force: true }));

    describe('When mergeBase runs over the two tips that share both bases', () => {
      it('Then the single result matches git merge-base under the demoted chain', async () => {
        // Arrange
        const expected = git(dir, 'merge-base', a, z).trim();

        // Act
        const result = await mergeBase(ctx, [a, z]);

        // Assert
        expect(result).toEqual([expected]);
      });

      it('Then the { all: true } set matches git merge-base --all under the demoted chain', async () => {
        // Arrange
        const expected = git(dir, 'merge-base', '--all', a, z).trim().split('\n');

        // Act
        const result = await mergeBase(ctx, [a, z], { all: true });

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given a criss-cross whose older base outranks the newer one by generation', () => {
    let history: PlumbedHistory;

    // r@100 ← p@1000 ← b1@100, and r ← b2@500, merged both ways. b1's corrected
    // commit date is inherited from p, so a commit-graph ranks b1 above b2 while
    // a bare date walk ranks b2 above b1 — the single result flips when the
    // graph appears, which is precisely what git does.
    beforeAll(async () => {
      history = await plumbHistory('generation-skewed-criss-cross', (commit) => {
        const r = commit('r', 1_700_000_100, []);
        const p = commit('p', 1_700_001_000, [r]);
        const b1 = commit('b1', 1_700_000_100, [p]);
        const b2 = commit('b2', 1_700_000_500, [r]);
        commit('d', 1_700_002_000, [b1, b2]);
        commit('e', 1_700_002_000, [b2, b1]);
      });
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(history.dir, { recursive: true, force: true }));

    describe('When run with no commit-graph', () => {
      it('Then the single result is the newer-dated base, as git reports it', async () => {
        // Arrange
        const { dir, ctx, ids } = history;
        const d = ids.get('d')!;
        const e = ids.get('e')!;

        // Act
        const result = await mergeBase(ctx, [d, e]);

        // Assert
        expect(result).toEqual([git(dir, 'merge-base', d, e).trim()]);
        expect(result).toEqual([ids.get('b2')]);
      });
    });

    describe('When run against a commit-graph git itself wrote', () => {
      it('Then the single result flips to the higher-generation base, as git reports it', async () => {
        // Arrange
        const { dir, ids } = history;
        const d = ids.get('d')!;
        const e = ids.get('e')!;
        await runGitAsync(['-C', dir, 'commit-graph', 'write', '--reachable']);
        const freshCtx = createNodeContext({ workDir: dir });

        // Act
        const single = await mergeBase(freshCtx, [d, e]);
        const every = await mergeBase(freshCtx, [d, e], { all: true });

        // Assert
        expect(single).toEqual([git(dir, 'merge-base', d, e).trim()]);
        expect(single).toEqual([ids.get('b1')]);
        expect(every).toEqual(git(dir, 'merge-base', '--all', d, e).trim().split('\n'));
      });
    });
  });

  describe('Given three same-second commits where only one is common to both tips', () => {
    let history: PlumbedHistory;

    // x, y and w share one committer second; a merges [x, y] and z merges
    // [w, y], so {x, y} are both bases and nothing but pop order separates
    // them. git answers y; the base DISCOVERED first is x.
    beforeAll(async () => {
      history = await plumbHistory('same-second-split', (commit) => {
        const x = commit('x', 1_700_000_000, []);
        const y = commit('y', 1_700_000_000, []);
        const w = commit('w', 1_700_000_000, [x]);
        commit('a', 1_700_000_001, [x, y]);
        commit('z', 1_700_000_001, [w, y]);
      });
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(history.dir, { recursive: true, force: true }));

    describe('When run with no commit-graph', () => {
      it('Then the single result matches git merge-base on the pop-order tie', async () => {
        // Arrange
        const { dir, ctx, ids } = history;
        const a = ids.get('a')!;
        const z = ids.get('z')!;

        // Act
        const result = await mergeBase(ctx, [a, z]);

        // Assert
        expect(result).toEqual([git(dir, 'merge-base', a, z).trim()]);
        expect(result).toEqual([ids.get('y')]);
      });
    });

    describe('When run against a commit-graph git itself wrote', () => {
      it('Then the same tie resolves the same way, from a fresh Context', async () => {
        // Arrange
        const { dir, ids } = history;
        const a = ids.get('a')!;
        const z = ids.get('z')!;
        await runGitAsync(['-C', dir, 'commit-graph', 'write', '--reachable']);
        const freshCtx = createNodeContext({ workDir: dir });

        // Act
        const single = await mergeBase(freshCtx, [a, z]);
        const every = await mergeBase(freshCtx, [a, z], { all: true });

        // Assert
        expect(single).toEqual([git(dir, 'merge-base', a, z).trim()]);
        expect(single).toEqual([ids.get('y')]);
        expect(every).toEqual(git(dir, 'merge-base', '--all', a, z).trim().split('\n'));
      });
    });
  });

  describe('Given a criss-cross whose two bases sit on DIFFERENT committer seconds', () => {
    let history: PlumbedHistory;

    // The companion to the same-second fixture above: with b@100 and c@200 the
    // tie-break never runs, so the date ordering alone has to pick c.
    beforeAll(async () => {
      history = await plumbHistory('distinct-second-criss-cross', (commit) => {
        const a = commit('a', 1_700_000_050, []);
        const b = commit('b', 1_700_000_100, [a]);
        const c = commit('c', 1_700_000_200, [a]);
        commit('d1', 1_700_000_300, [c, b]);
        commit('e1', 1_700_000_300, [b, c]);
      });
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(history.dir, { recursive: true, force: true }));

    describe('When run with no commit-graph', () => {
      it('Then the single result and the { all: true } set both match git', async () => {
        // Arrange
        const { dir, ctx, ids } = history;
        const d1 = ids.get('d1')!;
        const e1 = ids.get('e1')!;

        // Act
        const single = await mergeBase(ctx, [d1, e1]);
        const every = await mergeBase(ctx, [d1, e1], { all: true });

        // Assert
        expect(single).toEqual([git(dir, 'merge-base', d1, e1).trim()]);
        expect(single).toEqual([ids.get('c')]);
        expect(every).toEqual(git(dir, 'merge-base', '--all', d1, e1).trim().split('\n'));
      });
    });

    describe('When run against a commit-graph git itself wrote', () => {
      it('Then both still match git, from a fresh Context', async () => {
        // Arrange
        const { dir, ids } = history;
        const d1 = ids.get('d1')!;
        const e1 = ids.get('e1')!;
        await runGitAsync(['-C', dir, 'commit-graph', 'write', '--reachable']);
        const freshCtx = createNodeContext({ workDir: dir });

        // Act
        const single = await mergeBase(freshCtx, [d1, e1]);
        const every = await mergeBase(freshCtx, [d1, e1], { all: true });

        // Assert
        expect(single).toEqual([git(dir, 'merge-base', d1, e1).trim()]);
        expect(single).toEqual([ids.get('c')]);
        expect(every).toEqual(git(dir, 'merge-base', '--all', d1, e1).trim().split('\n'));
      });
    });
  });

  describe('Given two bases whose generation order and committer-date order disagree', () => {
    let history: PlumbedHistory;

    // kp@999 ← q@10 lifts q's corrected commit date above the independent root
    // p@900, so the generation walk pops q first while the date-sorted base list
    // still leads with p. git prints q for `merge-base` and p for
    // `merge-base --octopus` on the very same repository.
    beforeAll(async () => {
      history = await plumbHistory('generation-versus-date', (commit) => {
        const kp = commit('kp', 1_700_000_999, []);
        const q = commit('q', 1_700_000_010, [kp]);
        const p = commit('p', 1_700_000_900, []);
        commit('d', 1_700_002_000, [p, q]);
        commit('e', 1_700_002_000, [q, p]);
      });
      await runGitAsync(['-C', history.dir, 'commit-graph', 'write', '--reachable']);
      history = { ...history, ctx: createNodeContext({ workDir: history.dir }) };
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(history.dir, { recursive: true, force: true }));

    describe('When the plain and octopus surfaces run over the same graph', () => {
      it('Then plain matches git merge-base and octopus matches git merge-base --octopus', async () => {
        // Arrange
        const { dir, ctx, ids } = history;
        const d = ids.get('d')!;
        const e = ids.get('e')!;

        // Act
        const plain = await mergeBase(ctx, [d, e]);
        const octopus = await mergeBase(ctx, [d, e], { octopus: true });

        // Assert
        expect(plain).toEqual([git(dir, 'merge-base', d, e).trim()]);
        expect(plain).toEqual([ids.get('q')]);
        expect(octopus).toEqual([git(dir, 'merge-base', '--octopus', d, e).trim()]);
        expect(octopus).toEqual([ids.get('p')]);
      });
    });
  });

  describe('Given a commit-graph written with commitGraph.generationVersion=1', () => {
    let history: PlumbedHistory;

    // The graph stores CDAT topological levels and no GDA2 chunk at all, so its
    // generations are not comparable with committer seconds — git answers by
    // swapping in its date-only queue comparator. The fixture makes the two
    // orders fight: deep@…103 sits at topological level 4 while the independent
    // root shallow@…500 sits at level 1, so a level-ordered queue would pop the
    // OLDER base first. git pops the newer-dated one.
    beforeAll(async () => {
      history = await plumbHistory('generation-version-1', (commit) => {
        const p0 = commit('p0', 1_700_000_100, []);
        const p1 = commit('p1', 1_700_000_101, [p0]);
        const p2 = commit('p2', 1_700_000_102, [p1]);
        const deep = commit('deep', 1_700_000_103, [p2]);
        const shallow = commit('shallow', 1_700_000_500, []);
        commit('d', 1_700_002_000, [deep, shallow]);
        commit('e', 1_700_002_000, [shallow, deep]);
      });
      await runGitAsync([
        '-C',
        history.dir,
        '-c',
        'commitGraph.generationVersion=1',
        'commit-graph',
        'write',
        '--reachable',
      ]);
      history = { ...history, ctx: createNodeContext({ workDir: history.dir }) };
    }, SETUP_TIMEOUT);

    afterAll(async () => rm(history.dir, { recursive: true, force: true }));

    describe('When mergeBase runs over the two tips that share both bases', () => {
      it('Then the topological levels never order the queue — git merge-base still wins', async () => {
        // Arrange
        const { dir, ctx, ids } = history;
        const d = ids.get('d')!;
        const e = ids.get('e')!;

        // Act
        const single = await mergeBase(ctx, [d, e]);
        const every = await mergeBase(ctx, [d, e], { all: true });

        // Assert
        expect(single).toEqual([git(dir, 'merge-base', d, e).trim()]);
        expect(single).toEqual([ids.get('shallow')]);
        expect(every).toEqual(git(dir, 'merge-base', '--all', d, e).trim().split('\n'));
      });
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('mergeBase --all order on equal-date bases (interop)', () => {
  describe.each([
    { graph: 'without a commit-graph', withCommitGraph: false },
    { graph: 'with a commit-graph', withCommitGraph: true },
  ])(
    'Given merges listing the same three equal-date bases in different orders $graph',
    ({ withCommitGraph }) => {
      let dir: string;
      const ids = new Map<string, string>();

      beforeAll(async () => {
        dir = await makeRepo('equal-date-all');
        const tree = runGit(['-C', dir, 'mktree'], { input: '' }).trim();
        const commit = (name: string, parents: ReadonlyArray<string>): void => {
          const args = [
            '-C',
            dir,
            'commit-tree',
            tree,
            ...parents.flatMap((p) => ['-p', ids.get(p)!]),
          ];
          ids.set(name, runGit([...args, '-m', name], { env: datedEnv(1_700_000_000) }).trim());
        };
        commit('r', []);
        for (const base of ['a', 'b', 'c']) commit(base, ['r']);
        commit('x', ['a', 'b', 'c']);
        commit('y', ['c', 'b', 'a']);
        commit('z', ['b', 'a', 'c']);
        for (const tip of ['x', 'y', 'z'])
          git(dir, 'update-ref', `refs/heads/${tip}`, ids.get(tip)!);
        if (withCommitGraph) git(dir, 'commit-graph', 'write', '--reachable');
      }, SETUP_TIMEOUT);

      afterAll(async () => rm(dir, { recursive: true, force: true }));

      describe.each([
        ['x', 'y'],
        ['y', 'x'],
        ['z', 'y'],
        ['x', 'y', 'z'],
      ])('When mergeBase lists every base of %s and %s', (...tips) => {
        it('Then the bases come in the order git merge-base --all prints', async () => {
          // Arrange
          const oids = tips.map((tip) => ids.get(tip)! as ObjectId);
          const expected = git(dir, 'merge-base', '--all', ...oids)
            .trim()
            .split('\n');

          // Act
          const result = await mergeBase(createNodeContext({ workDir: dir }), oids, { all: true });

          // Assert
          expect(result).toEqual(expected);
        });
      });
    },
  );
});

const IDENTITY = 'A U Thor <author@example.com> 1700000000 +0000';
const ABSENT = `cd${'0'.repeat(38)}`;

const literally = (dir: string, type: 'tag' | 'commit', body: string): string =>
  runGit(['-C', dir, 'hash-object', '-t', type, '-w', '--stdin', '--literally'], {
    input: body,
  }).trim();

const tagBody = (target: string, type: string): string =>
  `object ${target}\ntype ${type}\ntag t\ntagger ${IDENTITY}\n\nm\n`;

const commitBody = (tree: string, parents: ReadonlyArray<string>, message: string): string =>
  `tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join('')}author ${IDENTITY}\ncommitter ${IDENTITY}\n\n${message}\n`;

/** What `git merge-base` prints on stderr, rebuilt from tsgit's logged lines and refusal. */
const rebuiltStderr = (logged: ReadonlyArray<string>, name: string): string =>
  `${logged.map((line) => `error: ${line}\n`).join('')}fatal: Not a valid commit name ${name}\n`;

describe.skipIf(!GIT_AVAILABLE)('mergeBase argument lookup over a commit-graph (interop)', () => {
  let dir: string;
  const ids = new Map<string, string>();

  beforeAll(async () => {
    dir = await makeRepo('lookup-graph');
    const parent = datedCommit(dir, 'p', 1_700_000_000);
    ids.set('P', parent).set('C', datedCommit(dir, 'c', 1_700_000_001));
    git(dir, 'commit-graph', 'write', '--reachable');
    ids.set('Y', literally(dir, 'commit', commitBody(parent, [], 'y')));
  }, SETUP_TIMEOUT);

  afterAll(async () => rm(dir, { recursive: true, force: true }));

  /** git's stderr rebuilt from tsgit's logged lines and the refusal it threw. */
  const rebuiltDeath = (logged: ReadonlyArray<string>, data: Readonly<Record<string, string>>) => {
    const fatal =
      data.code === 'COMMIT_LOOKUP_FAILED'
        ? `fatal: could not find commit ${data.id}\n`
        : `fatal: Not a valid commit name ${data.name}\n`;
    return `${logged.map((line) => `error: ${line}\n`).join('')}${fatal}`;
  };

  describe.each([
    { args: ['C', 'Y'], code: 'INVALID_COMMIT_NAME' },
    { args: ['Y', 'C'], code: 'COMMIT_LOOKUP_FAILED' },
  ])(
    'Given merge-base of $args, C served by the graph and Y naming its parent as a tree',
    ({ args, code }) => {
      describe('When both tools look the arguments up', () => {
        it('Then tsgit refuses where git dies, after the error lines git prints', async () => {
          // Arrange
          const oids = args.map((name) => ids.get(name)!);
          const peer = tryRunGitWithExit(['-C', dir, 'merge-base', ...oids]);
          const logged: string[] = [];
          const base = createNodeContext({ workDir: dir });
          const ctx: Context = { ...base, logger: { error: (line: string) => logged.push(line) } };
          const sut = mergeBase;

          // Act
          const caught = await sut(ctx, oids as ObjectId[]).then(
            () => undefined,
            (error: unknown) => error,
          );

          // Assert
          const data = (caught as { readonly data: Readonly<Record<string, string>> }).data;
          expect(data.code).toBe(code);
          expect(peer.exitCode).toBe(128);
          expect(rebuiltDeath(logged, data)).toBe(peer.stderr);
        });
      });
    },
  );
});

describe.skipIf(!GIT_AVAILABLE)('mergeBase argument lookup (interop)', () => {
  let dir: string;
  const ids = new Map<string, string>();

  beforeAll(async () => {
    dir = await makeRepo('lookup');
    const c = datedCommit(dir, 'a', 1_700_000_000);
    const tree = git(dir, 'rev-parse', `${c}^{tree}`).trim();
    const blob = git(dir, 'rev-parse', `${c}:a.txt`).trim();
    ids.set('C', c).set('T', tree).set('B', blob).set('M', ABSENT);
    ids.set('T2', runGit(['-C', dir, 'mktree'], { input: '' }).trim());
    ids.set('TC', literally(dir, 'tag', tagBody(c, 'commit')));
    ids.set('TT', literally(dir, 'tag', tagBody(tree, 'tree')));
    ids.set('TM', literally(dir, 'tag', tagBody(ABSENT, 'commit')));
    ids.set('TL', literally(dir, 'tag', tagBody(tree, 'commit')));
    ids.set('CB', literally(dir, 'commit', commitBody(blob, [], 'x')));
    ids.set('CP', literally(dir, 'commit', commitBody(tree, [tree], 'y')));
  }, SETUP_TIMEOUT);

  afterAll(async () => rm(dir, { recursive: true, force: true }));

  describe.each([
    { args: ['C', 'T'] },
    { args: ['T', 'C'] },
    { args: ['C', 'B'] },
    { args: ['C', 'M'] },
    { args: ['C', 'TT'] },
    { args: ['C', 'TM'] },
    { args: ['C', 'TL'] },
    { args: ['TL', 'C'] },
    { args: ['CB', 'B'] },
    { args: ['C', 'CP'] },
    { args: ['C', 'T', 'T2'], octopus: true },
    { args: ['C', 'M', 'T'], octopus: true },
  ])('Given merge-base of $args (octopus: $octopus)', ({ args, octopus }) => {
    describe('When both tools look the arguments up', () => {
      it('Then tsgit refuses the name git dies on, after the error lines git prints', async () => {
        // Arrange
        const oids = args.map((name) => ids.get(name)!);
        const mode = octopus === true ? ['--octopus'] : [];
        const peer = tryRunGitWithExit(['-C', dir, 'merge-base', ...mode, ...oids]);
        const logged: string[] = [];
        const base = createNodeContext({ workDir: dir });
        const ctx: Context = { ...base, logger: { error: (line: string) => logged.push(line) } };
        const sut = mergeBase;

        // Act
        const caught = await sut(ctx, oids as ObjectId[], { octopus: octopus === true }).then(
          () => undefined,
          (error: unknown) => error,
        );

        // Assert
        const data = (
          caught as { readonly data?: { readonly code: string; readonly name: string } }
        ).data;
        expect(data?.code).toBe('INVALID_COMMIT_NAME');
        expect(peer.exitCode).toBe(128);
        expect(rebuiltStderr(logged, data?.name ?? '')).toBe(peer.stderr);
      });
    });
  });

  describe('Given an annotated tag of a commit', () => {
    describe('When both tools compute the base of the commit and the tag', () => {
      it('Then tsgit peels the tag and prints the base git prints', async () => {
        // Arrange
        const oids = [ids.get('C')!, ids.get('TC')!] as ObjectId[];
        const expected = git(dir, 'merge-base', ...oids).trim();
        const sut = mergeBase;

        // Act
        const result = await sut(createNodeContext({ workDir: dir }), oids);

        // Assert
        expect(result).toEqual([expected]);
      });
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('mergeBase walk parse (interop)', () => {
  let dir: string;
  const ids = new Map<string, string>();

  beforeAll(async () => {
    dir = await makeRepo('walk-parse');
    const c = datedCommit(dir, 'a', 1_700_000_000);
    const tree = git(dir, 'rev-parse', `${c}^{tree}`).trim();
    const blob = git(dir, 'rev-parse', `${c}:a.txt`).trim();
    ids.set('C', c);
    ids.set('CPM', literally(dir, 'commit', commitBody(tree, [ABSENT], 'z')));
    ids.set('CPB', literally(dir, 'commit', commitBody(tree, [blob], 'w')));
  }, SETUP_TIMEOUT);

  afterAll(async () => rm(dir, { recursive: true, force: true }));

  describe.each([
    { child: 'CPM', mode: [], options: {}, exitCode: 255 },
    { child: 'CPB', mode: [], options: {}, exitCode: 255 },
    { child: 'CPM', mode: ['--all'], options: { all: true }, exitCode: 255 },
    { child: 'CPB', mode: ['--octopus'], options: { octopus: true }, exitCode: 128 },
  ])('Given merge-base $mode of a commit and $child', ({ child, mode, options, exitCode }) => {
    describe('When both tools walk to the parent that fails to parse', () => {
      it('Then tsgit logs the lines git prints and refuses the commit git could not parse', async () => {
        // Arrange
        const oids = [ids.get('C')!, ids.get(child)!];
        const peer = tryRunGitWithExit(['-C', dir, 'merge-base', ...mode, ...oids]);
        const logged: string[] = [];
        const base = createNodeContext({ workDir: dir });
        const ctx: Context = { ...base, logger: { error: (line: string) => logged.push(line) } };
        const sut = mergeBase;

        // Act
        const caught = await sut(ctx, oids as ObjectId[], options).then(
          () => undefined,
          (error: unknown) => error,
        );

        // Assert
        const data = (caught as { readonly data: { readonly code: string; readonly id: string } })
          .data;
        expect(data.code).toBe('COMMIT_PARSE_FAILED');
        expect({ exitCode: peer.exitCode, stderr: peer.stderr }).toEqual({
          exitCode,
          stderr: `${[...logged, `could not parse commit ${data.id}`].map((line) => `error: ${line}\n`).join('')}`,
        });
      });
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('merge-base callers walk parse (interop)', () => {
  let dir: string;
  let head: string;

  beforeAll(async () => {
    dir = await makeRepo('callers-walk-parse');
    head = datedCommit(dir, 'a', 1_700_000_000);
    const tree = git(dir, 'rev-parse', `${head}^{tree}`).trim();
    const broken = literally(dir, 'commit', commitBody(tree, [ABSENT], 'z'));
    git(dir, 'update-ref', 'refs/heads/broken', broken);
  }, SETUP_TIMEOUT);

  afterAll(async () => rm(dir, { recursive: true, force: true }));

  const loggingContext = (): { readonly ctx: Context; readonly logged: string[] } => {
    const logged: string[] = [];
    const base = createNodeContext({ workDir: dir });
    return { ctx: { ...base, logger: { error: (line: string) => logged.push(line) } }, logged };
  };

  const errorLines = (logged: ReadonlyArray<string>): string =>
    logged.map((line) => `error: ${line}\n`).join('');

  const refusal = (
    run: Promise<unknown>,
  ): Promise<{ readonly code: string; readonly id: string }> =>
    run.then(
      () => ({ code: 'none', id: '' }),
      (error: unknown) => (error as { readonly data: { code: string; id: string } }).data,
    );

  describe.each([
    { command: 'rev-parse', args: ['rev-parse', 'main...broken'], run: revParse },
    {
      command: 'rebase',
      args: ['rebase', 'broken'],
      run: (ctx: Context) => rebaseRun(ctx, { upstream: 'broken' }),
    },
    {
      command: 'rebase --onto',
      args: ['rebase', '--onto', 'broken', 'main'],
      run: (ctx: Context) => rebaseRun(ctx, { upstream: 'main', onto: 'broken' }),
    },
  ])('Given $command over a walk reaching a parent the store lacks', ({ args, run }) => {
    describe('When both tools run it', () => {
      it("Then tsgit refuses the commit git could not parse after git's error line", async () => {
        // Arrange
        const peer = tryRunGitWithExit(['-C', dir, ...args]);
        const { ctx, logged } = loggingContext();
        const sut = run;

        // Act
        const data = await refusal(sut(ctx, 'main...broken'));

        // Assert
        expect({ code: data.code, exitCode: peer.exitCode, stderr: peer.stderr }).toEqual({
          code: 'COMMIT_PARSE_FAILED',
          exitCode: 128,
          stderr: errorLines([...logged, `could not parse commit ${data.id}`]),
        });
      });
    });
  });

  describe.each([
    { command: 'rev-list', run: (ctx: Context) => revList(ctx, { wants: ['main...broken'] }) },
    {
      command: 'bundle create',
      run: (ctx: Context) => bundleCreate(ctx, { revs: [{ symmetricRange: ['main', 'broken'] }] }),
    },
  ])('Given $command main...broken', ({ command, run }) => {
    describe('When both tools walk the range to the parent the store lacks', () => {
      it("Then tsgit logs git's lines and refuses the whole argument as one name", async () => {
        // Arrange
        const extra = command === 'bundle create' ? ['../walk-parse.bundle'] : [];
        const peer = tryRunGitWithExit([
          '-C',
          dir,
          ...command.split(' '),
          ...extra,
          'main...broken',
        ]);
        const { ctx, logged } = loggingContext();
        const sut = run;

        // Act
        const data = await refusal(sut(ctx));

        // Assert
        expect({ data, exitCode: peer.exitCode, stderr: peer.stderr }).toEqual({
          data: { code: 'OBJECT_NOT_FOUND', id: 'main...broken' },
          exitCode: 128,
          stderr: `${errorLines(logged)}fatal: ambiguous argument 'main...broken': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'\n`,
        });
      });
    });
  });

  describe('Given merge of a branch whose walk reaches a parent the store lacks', () => {
    describe('When both tools merge it', () => {
      it("Then tsgit logs git's lines and is up to date, as git is", async () => {
        // Arrange
        const peer = tryRunGitWithExit(['-C', dir, 'merge', 'broken']);
        const { ctx, logged } = loggingContext();
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'broken' });

        // Assert
        expect({ result, peer }).toEqual({
          result: { kind: 'up-to-date', id: head },
          peer: { exitCode: 0, stdout: 'Already up to date.\n', stderr: errorLines(logged) },
        });
      });
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('branch -d reachability walk parse (interop)', () => {
  const ABSENT_GAP_SETUP = async (slug: string, graph: boolean): Promise<string[]> => {
    const dir = await makeRepo(slug);
    const ids = [datedCommit(dir, 'c0', 1_700_000_000), datedCommit(dir, 'c1', 1_700_000_001)];
    if (graph) git(dir, 'commit-graph', 'write', '--reachable');
    for (const n of [2, 3, 4]) ids.push(datedCommit(dir, `c${n}`, 1_700_000_000 + n));
    git(dir, 'branch', 'b0', ids[0]!);
    git(dir, 'branch', 'b3', ids[3]!);
    await rm(path.join(dir, '.git', 'objects', ids[2]!.slice(0, 2), ids[2]!.slice(2)));
    return [dir, ...ids];
  };

  const twinRepos = async (slug: string, graph: boolean) => {
    const [gitDir, ...ids] = await ABSENT_GAP_SETUP(`${slug}-git`, graph);
    const [tsDir] = await ABSENT_GAP_SETUP(`${slug}-ts`, graph);
    return { gitDir: gitDir!, tsDir: tsDir!, gap: ids[2]! };
  };

  const deleteBoth = async (slug: string, graph: boolean, branch: string) => {
    const { gitDir, tsDir, gap } = await twinRepos(slug, graph);
    const peer = tryRunGitWithExit(['-C', gitDir, 'branch', '-d', branch]);
    const logged: string[] = [];
    const base = createNodeContext({ workDir: tsDir });
    const ctx: Context = { ...base, logger: { error: (line: string) => logged.push(line) } };
    const outcome = await branchDelete(ctx, { name: branch }).then(
      () => ({ code: 'deleted' }),
      (error: unknown) => (error as { readonly data: { readonly code: string } }).data,
    );
    await rm(gitDir, { recursive: true, force: true });
    await rm(tsDir, { recursive: true, force: true });
    return { peer, logged, outcome, gap };
  };

  describe('Given no commit-graph and a history whose middle commit is absent', () => {
    describe.each(['b0', 'b3'])('When both tools delete %s', (branch) => {
      it("Then tsgit refuses the commit git could not parse after git's error line", async () => {
        // Arrange
        const sut = deleteBoth;

        // Act
        const { peer, logged, outcome, gap } = await sut(`gap-${branch}`, false, branch);

        // Assert
        expect({ outcome, exitCode: peer.exitCode, stderr: peer.stderr }).toEqual({
          outcome: { code: 'COMMIT_PARSE_FAILED', id: gap },
          exitCode: 128,
          stderr: [...logged, `could not parse commit ${gap}`]
            .map((line) => `error: ${line}\n`)
            .join(''),
        });
      });
    });
  });

  describe('Given a commit-graph below a history whose first commit past the graph is absent', () => {
    describe.each([
      { branch: 'b0', code: 'BRANCH_NOT_FULLY_MERGED', exitCode: 1 },
      { branch: 'b3', code: 'deleted', exitCode: 0 },
    ])('When both tools delete $branch', ({ branch, code, exitCode }) => {
      it("Then tsgit logs git's lines for the skipped parent and answers as git does", async () => {
        // Arrange
        const sut = deleteBoth;

        // Act
        const { peer, logged, outcome } = await sut(`graph-gap-${branch}`, true, branch);

        // Assert
        expect({ code: outcome.code, exitCode: peer.exitCode }).toEqual({ code, exitCode });
        expect(peer.stderr.startsWith(logged.map((line) => `error: ${line}\n`).join(''))).toBe(
          true,
        );
        expect(peer.stderr.match(/^error: Could not read/gm)?.length ?? 0).toBe(logged.length);
      });
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('mergeBase walk typing (interop)', () => {
  let dir: string;
  const ids = new Map<string, string>();

  beforeAll(async () => {
    dir = await makeRepo('walk-typing');
    const c0 = datedCommit(dir, 'a', 1_700_000_000);
    const c1 = datedCommit(dir, 'b', 1_700_000_001);
    git(dir, 'commit-graph', 'write', '--reachable');
    const tree = git(dir, 'rev-parse', `${c1}^{tree}`).trim();
    const y = literally(dir, 'commit', commitBody(c1, [c1], 'y'));
    const p = literally(dir, 'commit', commitBody(tree, [tree], 'p'));
    ids.set('C1', c1);
    ids.set('Z', literally(dir, 'commit', commitBody(tree, [y], 'z')));
    ids.set('Q', literally(dir, 'commit', commitBody(tree, [p], 'q')));
    ids.set('Y0', literally(dir, 'commit', commitBody(c0, [], 'y0')));
    ids.set('Z1', literally(dir, 'commit', commitBody(tree, [c1], 'z1')));
  }, SETUP_TIMEOUT);

  afterAll(async () => rm(dir, { recursive: true, force: true }));

  describe.each([
    { label: 'a tree pointer naming an argument', args: ['C1', 'Z'], exitCode: 255 },
    { label: 'a parent pointer naming a typed tree', args: ['C1', 'Q'], exitCode: 255 },
    { label: 'a graph parent typed a tree', args: ['Y0', 'Z1'], exitCode: 128 },
  ])('Given a walk reaching $label', ({ args, exitCode }) => {
    describe('When both tools run merge-base --all', () => {
      it("Then tsgit logs git's lines and refuses as git does", async () => {
        // Arrange
        const oids = args.map((name) => ids.get(name)!);
        const peer = tryRunGitWithExit(['-C', dir, 'merge-base', '--all', ...oids]);
        const logged: string[] = [];
        const base = createNodeContext({ workDir: dir });
        const ctx: Context = { ...base, logger: { error: (line: string) => logged.push(line) } };
        const sut = mergeBase;

        // Act
        const caught = await sut(ctx, oids as ObjectId[], { all: true }).then(
          () => undefined,
          (error: unknown) =>
            error as { readonly message: string; readonly data: { readonly code: string } },
        );

        // Assert
        const prefix = caught?.data.code === 'COMMIT_LOOKUP_FAILED' ? 'fatal' : 'error';
        expect({ exitCode: peer.exitCode, stderr: peer.stderr }).toEqual({
          exitCode,
          stderr: `${logged.map((line) => `error: ${line}\n`).join('')}${prefix}: ${caught?.message.replace(/^[A-Z_]+: /, '')}\n`,
        });
      });
    });
  });
});
