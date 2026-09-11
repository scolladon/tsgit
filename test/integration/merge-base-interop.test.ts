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
        expect(asSortedSet(result)).toEqual(asSortedSet(expected));
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
        expect(asSortedSet(every)).toEqual(
          asSortedSet(git(dir, 'merge-base', '--all', d, e).trim().split('\n')),
        );
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
        expect(asSortedSet(every)).toEqual(
          asSortedSet(git(dir, 'merge-base', '--all', a, z).trim().split('\n')),
        );
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
        expect(asSortedSet(every)).toEqual(
          asSortedSet(git(dir, 'merge-base', '--all', d1, e1).trim().split('\n')),
        );
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
        expect(asSortedSet(every)).toEqual(
          asSortedSet(git(dir, 'merge-base', '--all', d1, e1).trim().split('\n')),
        );
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
        expect(asSortedSet(every)).toEqual(
          asSortedSet(git(dir, 'merge-base', '--all', d, e).trim().split('\n')),
        );
      });
    });
  });
});
