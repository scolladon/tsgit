import { describe, expect, it } from 'vitest';
import { createCommit } from '../../../../../src/application/primitives/create-commit.js';
import {
  commitDateWalk,
  type DateWalkStep,
  selectParents,
} from '../../../../../src/application/primitives/internal/commit-date-walk.js';
import { readCommit } from '../../../../../src/application/primitives/internal/read-commit.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type {
  AuthorIdentity,
  Commit,
  CommitData,
  ObjectId,
  Tree,
} from '../../../../../src/domain/objects/index.js';
import { buildSeededContext, writeCommitGraph } from '../fixtures.js';

const AUTHOR: AuthorIdentity = {
  name: 'Alice',
  email: 'a@a.com',
  timestamp: 1700000000,
  timezoneOffset: '+0000',
};

const commitWithParents = (parents: ReadonlyArray<ObjectId>): Commit => {
  const data: CommitData = {
    tree: '0'.repeat(40) as ObjectId,
    parents,
    author: AUTHOR,
    committer: AUTHOR,
    message: 'm',
    extraHeaders: [],
  };
  return { type: 'commit', id: '1'.repeat(40) as ObjectId, data };
};

async function emptyTree(ctx: Awaited<ReturnType<typeof buildSeededContext>>): Promise<ObjectId> {
  const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
  return writeObject(ctx, tree);
}

// d ──> b ──┐
// │         ├──> a       (d.parents = [b, c]; first-parent chain = d, b, a)
// └──> c ───┘
async function buildDiamond(
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
): Promise<{ a: ObjectId; b: ObjectId; c: ObjectId; d: ObjectId }> {
  const treeId = await emptyTree(ctx);
  const commit = async (msg: string, ts: number, parents: ObjectId[]): Promise<ObjectId> =>
    createCommit(ctx, {
      tree: treeId,
      parents,
      author: { ...AUTHOR, timestamp: ts },
      committer: { ...AUTHOR, timestamp: ts },
      message: msg,
    });
  const a = await commit('a', 1, []);
  const b = await commit('b', 2, [a]);
  const c = await commit('c', 3, [a]);
  const d = await commit('d', 4, [b, c]);
  return { a, b, c, d };
}

async function collectIds(iter: AsyncIterable<DateWalkStep>): Promise<ObjectId[]> {
  const out: ObjectId[] = [];
  for await (const step of iter) out.push(step.commit.id);
  return out;
}

describe('commit-date-walk core', () => {
  describe('selectParents', () => {
    describe('Given a two-parent merge commit', () => {
      describe('When firstParent is true', () => {
        it('Then only the first parent is returned', () => {
          // Arrange
          const first = 'a'.repeat(40) as ObjectId;
          const second = 'b'.repeat(40) as ObjectId;
          const commit = commitWithParents([first, second]);

          // Act
          const result = selectParents(commit, true);

          // Assert
          expect(result).toEqual([first]);
        });
      });

      describe('When firstParent is false', () => {
        it('Then every parent is returned', () => {
          // Arrange
          const first = 'a'.repeat(40) as ObjectId;
          const second = 'b'.repeat(40) as ObjectId;
          const commit = commitWithParents([first, second]);

          // Act
          const result = selectParents(commit, false);

          // Assert
          expect(result).toEqual([first, second]);
        });
      });
    });

    describe('Given a parentless root commit', () => {
      describe('When firstParent is true', () => {
        it('Then an empty parent list is returned', () => {
          // Arrange
          const commit = commitWithParents([]);

          // Act
          const result = selectParents(commit, true);

          // Assert
          expect(result).toEqual([]);
        });
      });
    });
  });

  describe('commitDateWalk', () => {
    describe('Given a diamond DAG', () => {
      describe('When firstParent is true', () => {
        it('Then only the first-parent chain is yielded, newest-date first', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { a, b, d } = await buildDiamond(ctx);

          // Act
          const result = await collectIds(commitDateWalk(ctx, { from: [d], firstParent: true }));

          // Assert — c (the second parent) is excluded.
          expect(result).toEqual([d, b, a]);
        });
      });

      describe('When firstParent is false', () => {
        it('Then every reachable commit is yielded, newest-date first', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { a, b, c, d } = await buildDiamond(ctx);

          // Act
          const result = await collectIds(commitDateWalk(ctx, { from: [d], firstParent: false }));

          // Assert
          expect(result).toEqual([d, c, b, a]);
        });
      });

      describe('When firstParent is omitted', () => {
        it('Then it defaults to all-parents', async () => {
          // Arrange — pins the `firstParent ?? false` default.
          const ctx = await buildSeededContext();
          const { a, b, c, d } = await buildDiamond(ctx);

          // Act
          const result = await collectIds(commitDateWalk(ctx, { from: [d] }));

          // Assert
          expect(result).toEqual([d, c, b, a]);
        });
      });
    });
  });
});

describe('Given a diamond history and frontier-aware steps', () => {
  describe('When iterating commitDateWalk from the merge', () => {
    it('Then each step reports frontier emptiness at its pop point', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const { a, b, c, d } = await buildDiamond(ctx);
      const sut = commitDateWalk(ctx, { from: [d] });

      // Act
      const observed: Array<{ id: ObjectId; empty: boolean }> = [];
      for await (const step of sut) {
        observed.push({ id: step.commit.id, empty: step.frontierEmpty });
      }

      // Assert
      expect(observed.map((o) => o.id)).toEqual([d, c, b, a]);
      expect(observed.map((o) => o.empty)).toEqual([true, false, false, true]);
    });

    it('Then a mid-walk step snapshots the queued oids in its frontier', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const { a, b, d } = await buildDiamond(ctx);
      const sut = commitDateWalk(ctx, { from: [d] });

      // Act
      const frontiers: Array<ReadonlyArray<ObjectId>> = [];
      for await (const step of sut) {
        frontiers.push(step.frontier());
      }

      // Assert
      expect(frontiers).toEqual([[], [b], [a], []]);
    });
  });
});

describe('commitDateWalk — early graph-confirmed push under ignoreMissing=false', () => {
  describe('Given two graph-covered seeds, the older of which has a missing body, When walking by date', () => {
    it('Then the newer seed is yielded before the missing one aborts the walk', async () => {
      // Arrange — pins the early-return push: it must enqueue from the header
      // WITHOUT awaiting the body, so a later-popped stale seed's rejection
      // surfaces only once its own (lower-priority) turn comes up. If the
      // early-return block were dropped, `enqueueSeeds` would await each
      // seed's body in insertion order and reject on `stale` before `fresh`
      // is ever enqueued/yielded.
      const ctx = await buildSeededContext();
      const treeId = await emptyTree(ctx);
      const commit = async (msg: string, ts: number): Promise<ObjectId> =>
        createCommit(ctx, {
          tree: treeId,
          parents: [],
          author: { ...AUTHOR, timestamp: ts },
          committer: { ...AUTHOR, timestamp: ts },
          message: msg,
        });
      const stale = await commit('stale', 1);
      const fresh = await commit('fresh', 2);
      const readOpts = { verifyHash: false, ignoreMissing: false, missing: new Set<string>() };
      const commits = await Promise.all(
        [stale, fresh].map(async (id) => (await readCommit(ctx, id, readOpts))!),
      );
      await writeCommitGraph(ctx, [commits]);
      const { computeLooseObjectPath } = await import(
        '../../../../../src/domain/storage/loose-path.js'
      );
      await ctx.fs.rm(`${ctx.layout.gitDir}/objects/${computeLooseObjectPath(stale)}`);
      const sut = commitDateWalk(ctx, { from: [stale, fresh] });

      // Act
      const yielded: ObjectId[] = [];
      let caught: unknown;
      try {
        for await (const step of sut) {
          yielded.push(step.commit.id);
        }
        expect.unreachable();
      } catch (error) {
        caught = error;
      }

      // Assert — fresh (newer date, popped first) is yielded before the walk
      // aborts on stale's missing body
      expect(yielded).toEqual([fresh]);
      expect((caught as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
    });
  });
});

describe('commitDateWalk — stale commit-graph under ignoreMissing', () => {
  describe('Given a graph-covered merge whose one parent object was pruned, When walking by date under ignoreMissing', () => {
    it('Then the pruned commit never enters the heap or any frontier snapshot', async () => {
      // Arrange — pruned (ts1) sorts OLDER than kept (ts2): a header-dated
      // push of the pruned commit would still sit in the heap when `kept`
      // yields, so its frontier snapshot is the observable
      const ctx = await buildSeededContext();
      const treeId = await emptyTree(ctx);
      const commit = async (msg: string, ts: number, parents: ObjectId[]): Promise<ObjectId> =>
        createCommit(ctx, {
          tree: treeId,
          parents,
          author: { ...AUTHOR, timestamp: ts },
          committer: { ...AUTHOR, timestamp: ts },
          message: msg,
        });
      const pruned = await commit('pruned', 1, []);
      const kept = await commit('kept', 2, []);
      const merge = await commit('merge', 3, [pruned, kept]);
      const tip = await commit('tip', 4, [merge]);
      const readOpts = { verifyHash: false, ignoreMissing: false, missing: new Set<string>() };
      const commits = await Promise.all(
        [pruned, kept, merge, tip].map(async (id) => (await readCommit(ctx, id, readOpts))!),
      );
      await writeCommitGraph(ctx, [commits]);
      const { computeLooseObjectPath } = await import(
        '../../../../../src/domain/storage/loose-path.js'
      );
      await ctx.fs.rm(`${ctx.layout.gitDir}/objects/${computeLooseObjectPath(pruned)}`);
      const sut = commitDateWalk(ctx, { from: [tip], ignoreMissing: true });

      // Act
      const yielded: ObjectId[] = [];
      const frontiers: ObjectId[] = [];
      const empties: boolean[] = [];
      for await (const step of sut) {
        yielded.push(step.commit.id);
        frontiers.push(...step.frontier());
        empties.push(step.frontierEmpty);
      }

      // Assert — the pruned commit is neither yielded nor ever visible in a
      // frontier; the final yield sees an empty heap
      expect(yielded).toEqual([tip, merge, kept]);
      expect(frontiers).not.toContain(pruned);
      expect(empties.at(-1)).toBe(true);
    });
  });
});
