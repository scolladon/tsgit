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
import type { Context } from '../../../../../src/ports/context.js';
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

async function collectCommits(iter: AsyncIterable<DateWalkStep>): Promise<Commit[]> {
  const out: Commit[] = [];
  for await (const step of iter) out.push(step.commit);
  return out;
}

async function linearChain(
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  n: number,
): Promise<ObjectId[]> {
  const treeId = await emptyTree(ctx);
  const ids: ObjectId[] = [];
  let parent: ObjectId[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = await createCommit(ctx, {
      tree: treeId,
      parents: parent,
      author: { ...AUTHOR, timestamp: 1700000000 + i },
      committer: { ...AUTHOR, timestamp: 1700000000 + i },
      message: `c${i}`,
    });
    ids.push(id);
    parent = [id];
  }
  return ids;
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

    describe('Given a hand-written .git/shallow file and no shallow option', () => {
      describe('When walking from the tip', () => {
        it('Then the walk auto-loads the file and stops at the boundary', async () => {
          // Arrange — linear chain of 3; .git/shallow names the middle commit.
          const ctx = await buildSeededContext();
          const ids = await linearChain(ctx, 3);
          const tip = ids[2] as ObjectId;
          const boundary = ids[1] as ObjectId;
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${boundary}\n`);

          // Act — no `shallow` option at all.
          const result = await collectIds(commitDateWalk(ctx, { from: [tip] }));

          // Assert
          expect(result).toEqual([tip, boundary]);
        });
      });
    });

    describe('Given a .git/shallow file and an explicit empty override', () => {
      describe('When walking from the tip', () => {
        it('Then the caller-supplied empty set wins and the walk is not stopped', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const ids = await linearChain(ctx, 3);
          const tip = ids[2] as ObjectId;
          const boundary = ids[1] as ObjectId;
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${boundary}\n`);

          // Act
          const result = await collectIds(
            commitDateWalk(ctx, { from: [tip], shallow: new Set<ObjectId>() }),
          );

          // Assert — the escape hatch: repository state is not consulted.
          expect(result.length).toBe(3);
        });
      });
    });

    describe('Given an auto-loaded shallow boundary', () => {
      describe('When the boundary commit is yielded', () => {
        it('Then its reported parents are empty, not just skipped from the frontier', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const ids = await linearChain(ctx, 3);
          const tip = ids[2] as ObjectId;
          const boundary = ids[1] as ObjectId;
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${boundary}\n`);

          // Act
          const commits = await collectCommits(commitDateWalk(ctx, { from: [tip] }));

          // Assert — the yielded object is grafted, not merely frontier-skipped.
          const boundaryCommit = commits.find((c) => c.id === boundary);
          expect(boundaryCommit?.data.parents).toEqual([]);
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
      const readOpts = {
        verifyHash: false,
        ignoreMissing: false,
        missing: new Set<string>(),
        shallow: new Set<ObjectId>(),
      };
      const commits = await Promise.all(
        [stale, fresh].map(async (id) => (await readCommit(ctx, id, readOpts))!),
      );
      await writeCommitGraph(ctx, [commits]);
      const { computeLooseObjectPath } = await import(
        '../../../../../src/domain/storage/loose-path.js'
      );
      // F2.3 also populates the delta cache on the arrange-phase pre-read
      // above; drop that entry so removing the loose file below produces a
      // genuine miss instead of a cache-served hit.
      ctx.deltaCache.delete(stale);
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
      const readOpts = {
        verifyHash: false,
        ignoreMissing: false,
        missing: new Set<string>(),
        shallow: new Set<ObjectId>(),
      };
      const commits = await Promise.all(
        [pruned, kept, merge, tip].map(async (id) => (await readCommit(ctx, id, readOpts))!),
      );
      await writeCommitGraph(ctx, [commits]);
      const { computeLooseObjectPath } = await import(
        '../../../../../src/domain/storage/loose-path.js'
      );
      // F2.3 also populates the delta cache on the arrange-phase pre-read
      // above; drop that entry so removing the loose file below produces a
      // genuine miss instead of a cache-served hit.
      ctx.deltaCache.delete(pruned);
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

describe('commitDateWalk — parallel parent body reads (F12)', () => {
  describe('Given a commit with three parents', () => {
    describe('When the walk enqueues them', () => {
      it('Then all three body reads are started before any is awaited', async () => {
        // Arrange — an octopus merge whose three parents are loose objects;
        // reads are gated so overlap is observable via a read spy.
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
        const p1 = await commit('p1', 1, []);
        const p2 = await commit('p2', 2, []);
        const p3 = await commit('p3', 3, []);
        const merge = await commit('merge', 4, [p1, p2, p3]);
        const { computeLooseObjectPath } = await import(
          '../../../../../src/domain/storage/loose-path.js'
        );
        const parentPaths = new Set(
          [p1, p2, p3].map((id) => `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`),
        );
        let active = 0;
        let maxActive = 0;
        const starts: string[] = [];
        const stubCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async (path: string) => {
              if (!parentPaths.has(path)) return ctx.fs.read(path);
              starts.push(path);
              active += 1;
              maxActive = Math.max(maxActive, active);
              await new Promise<void>((resolve) => setTimeout(resolve, 5));
              const bytes = await ctx.fs.read(path);
              active -= 1;
              return bytes;
            },
          },
        };

        // Act
        await collectIds(commitDateWalk(stubCtx, { from: [merge] }));

        // Assert — every parent read started, and at least two overlapped.
        expect(starts.length).toBe(3);
        expect(maxActive).toBeGreaterThanOrEqual(2);
      });
    });
  });
});

describe('commitDateWalk — parent rejection order is array order, not first-in-time (F12, R5)', () => {
  describe('Given two missing parents where the second one fails first in time', () => {
    describe('When the walk enqueues them', () => {
      it("Then the propagated rejection is the first parent's", async () => {
        // Arrange — `first`'s loose-membership probe is artificially slowed
        // so `second` (no matching fanout dir, fast) rejects first in real
        // time; a `Promise.all`-based implementation would surface
        // `second`'s rejection instead of `first`'s.
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const first = 'a'.repeat(40) as ObjectId;
        const second = 'b'.repeat(40) as ObjectId;
        const merge = await createCommit(ctx, {
          tree: treeId,
          parents: [first, second],
          author: AUTHOR,
          committer: AUTHOR,
          message: 'merge',
        });
        const firstPrefixDir = `${ctx.layout.gitDir}/objects/${first.slice(0, 2)}`;
        const stubCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            readdir: async (path: string) => {
              if (path === firstPrefixDir) {
                await new Promise<void>((resolve) => setTimeout(resolve, 20));
              }
              return ctx.fs.readdir(path);
            },
          },
        };

        // Act
        let caught: unknown;
        try {
          await collectIds(commitDateWalk(stubCtx, { from: [merge] }));
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('OBJECT_NOT_FOUND');
        if (data.code !== 'OBJECT_NOT_FOUND') {
          expect.fail(`expected OBJECT_NOT_FOUND, got ${data.code}`);
        }
        expect(data.id).toBe(first);
      });
    });
  });
});

describe('commitDateWalk — sibling push order matches parent-array order, not completion order (F12, trap 1)', () => {
  describe('Given siblings whose reads complete out of array order', () => {
    describe('When the walk enqueues them', () => {
      it('Then the heap receives them in parent-array order', async () => {
        // Arrange — q0 is the newest of the four (pops first); the merge
        // lists them [q0,q1,q2,q3] but their reads are timed to COMPLETE in
        // a different order ([q1,q0,q3,q2]). `entries()` returns the heap's
        // backing array by reference, so a push-in-completion-order bug
        // would leave it in a different shape than push-in-array-order.
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
        const q0 = await commit('q0', 40, []);
        const q1 = await commit('q1', 10, []);
        const q2 = await commit('q2', 30, []);
        const q3 = await commit('q3', 20, []);
        const merge = await commit('merge', 100, [q0, q1, q2, q3]);
        const { computeLooseObjectPath } = await import(
          '../../../../../src/domain/storage/loose-path.js'
        );
        const pathOf = (id: ObjectId): string =>
          `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`;
        const delayFor = new Map<string, number>([
          [pathOf(q1), 0],
          [pathOf(q0), 15],
          [pathOf(q3), 30],
          [pathOf(q2), 45],
        ]);
        const stubCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async (path: string) => {
              const delay = delayFor.get(path);
              if (delay !== undefined) {
                await new Promise<void>((resolve) => setTimeout(resolve, delay));
              }
              return ctx.fs.read(path);
            },
          },
        };
        const sut = commitDateWalk(stubCtx, { from: [merge] });
        const iterator = sut[Symbol.asyncIterator]();

        // Act
        const mergeStep = await iterator.next(); // merge — parents not enqueued yet
        if (mergeStep.done) throw new Error('expected the merge step');
        const bestStep = await iterator.next(); // q0 — the best of the four, popped next
        if (bestStep.done) throw new Error('expected the q0 step');

        // Assert — array order [q0,q1,q2,q3] survives the pop's re-sift as
        // [q2,q3,q1]; a completion-order push would instead settle as
        // [q2,q1,q3].
        expect(bestStep.value.commit.id).toBe(q0);
        expect(bestStep.value.frontier()).toEqual([q2, q3, q1]);
      });
    });
  });
});

describe('commitDateWalk — graph-present parent push stays body-await-free (F12, trap 3)', () => {
  describe('Given a graph-covered merge whose parents are a fresh one and a stale one missing its body', () => {
    describe('When walking by date', () => {
      it('Then the fresher parent is yielded before the stale one aborts the walk', async () => {
        // Arrange — pins that resolving a parent for push never awaits its
        // body when the commit-graph already knows the date: if it did, a
        // sequential resolve would reject on `stale` before `fresh` is ever
        // pushed/yielded.
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
        const stale = await commit('stale', 1, []);
        const fresh = await commit('fresh', 2, []);
        const merge = await commit('merge', 3, [stale, fresh]);
        const readOpts = {
          verifyHash: false,
          ignoreMissing: false,
          missing: new Set<string>(),
          shallow: new Set<ObjectId>(),
        };
        const commits = await Promise.all(
          [stale, fresh, merge].map(async (id) => (await readCommit(ctx, id, readOpts))!),
        );
        await writeCommitGraph(ctx, [commits]);
        const { computeLooseObjectPath } = await import(
          '../../../../../src/domain/storage/loose-path.js'
        );
        // F2.3 also populates the delta cache on the arrange-phase pre-read
        // above; drop that entry so removing the loose file below produces a
        // genuine miss instead of a cache-served hit.
        ctx.deltaCache.delete(stale);
        await ctx.fs.rm(`${ctx.layout.gitDir}/objects/${computeLooseObjectPath(stale)}`);
        const sut = commitDateWalk(ctx, { from: [merge] });

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

        // Assert — merge and fresh are yielded before the walk aborts on
        // stale's missing body.
        expect(yielded).toEqual([merge, fresh]);
        expect((caught as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
      });
    });
  });
});
