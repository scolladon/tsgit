import { describe, expect, it } from 'vitest';
import { bisectMidpoint } from '../../../../src/application/primitives/bisect-midpoint.js';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

const AUTHOR = {
  name: 'A',
  email: 'a@test.com',
  timestamp: 0,
  timezoneOffset: '+0000',
} as const;

const emptyTree = async (ctx: Awaited<ReturnType<typeof buildSeededContext>>): Promise<ObjectId> =>
  writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });

const commitAt = async (
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  treeId: ObjectId,
  ts: number,
  parents: ObjectId[],
): Promise<ObjectId> =>
  createCommit(ctx, {
    tree: treeId,
    parents,
    author: { ...AUTHOR, timestamp: ts },
    committer: { ...AUTHOR, timestamp: ts },
    message: `c@${ts}`,
  });

/**
 * Build a linear chain: c[0] (root, ts=100) → c[1] (ts=101) → … → c[n-1]
 * Returns the commit ids oldest-first.
 */
const buildLinear = async (
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  n: number,
): Promise<ObjectId[]> => {
  const treeId = await emptyTree(ctx);
  const ids: ObjectId[] = [];
  let parents: ObjectId[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = await commitAt(ctx, treeId, 100 + i, parents);
    ids.push(id);
    parents = [id];
  }
  return ids;
};

describe('bisectMidpoint', () => {
  describe('Given a linear 10-commit chain, good=c[0], bad=c[9]', () => {
    describe('When bisectMidpoint runs', () => {
      it('Then returns structured midpoint at c[4] with correct counts', async () => {
        // Arrange
        const sut = bisectMidpoint;
        const ctx = await buildSeededContext();
        const commits = await buildLinear(ctx, 10);
        const good = commits[0]!;
        const bad = commits[9]!;

        // Act
        const result = await sut(ctx, [good], bad);

        // Assert — 9 candidates {c[1]..c[9]}; fill-phase fires at c[4] (weight=4,
        // approxHalfway(4,9): 2*4−9=−1 ∈ [−1,1] → early return before tie-break)
        expect(result).not.toBeUndefined();
        expect(result?.nextCommit).toBe(commits[4]);
        expect(result?.candidateCount).toBe(9);
        expect(result?.remainingIfGood).toBe(4); // 9 - 4 - 1
        expect(result?.remainingIfBad).toBe(3); // 4 - 1
        expect(result?.remainingSteps).toBe(2); // estimateSteps(9)
      });
    });
  });

  describe('Given a linear 2-commit chain, good=c[0], bad=c[1]', () => {
    describe('When bisectMidpoint runs', () => {
      it('Then returns a single-candidate result with remainingIfGood=-1', async () => {
        // Arrange
        const sut = bisectMidpoint;
        const ctx = await buildSeededContext();
        const commits = await buildLinear(ctx, 2);
        const good = commits[0]!;
        const bad = commits[1]!;

        // Act
        const result = await sut(ctx, [good], bad);

        // Assert — 1 candidate {c[1]}; reaches=1 → remainingIfGood=-1 faithful passthrough
        expect(result).not.toBeUndefined();
        expect(result?.nextCommit).toBe(bad);
        expect(result?.candidateCount).toBe(1);
        expect(result?.remainingIfGood).toBe(-1);
        expect(result?.remainingIfBad).toBe(0);
        expect(result?.remainingSteps).toBe(0);
      });
    });
  });

  describe('Given good commit covers all of bad-reachable set', () => {
    describe('When bisectMidpoint runs', () => {
      it('Then returns undefined (empty candidate set)', async () => {
        // Arrange — good=c[1] (descendant of bad=c[0]) → c[0] reachable from good
        const sut = bisectMidpoint;
        const ctx = await buildSeededContext();
        const commits = await buildLinear(ctx, 2);
        const good = commits[1]!;
        const bad = commits[0]!;

        // Act
        const result = await sut(ctx, [good], bad);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given good=[] (no good tips)', () => {
    describe('When bisectMidpoint runs', () => {
      it('Then candidate set is everything reachable from bad', async () => {
        // Arrange — 3-commit linear chain: root→mid→bad; no good → all 3 are candidates
        const sut = bisectMidpoint;
        const ctx = await buildSeededContext();
        const commits = await buildLinear(ctx, 3);
        const bad = commits[2]!;

        // Act — empty good array: candidates = {root, mid, bad}
        const result = await sut(ctx, [], bad);

        // Assert — all=3, fill fires at mid (weight=2, approxHalfway(2,3)=1 ∈ {-1,0,1})
        expect(result).not.toBeUndefined();
        expect(result?.nextCommit).toBe(commits[1]);
        expect(result?.candidateCount).toBe(3);
        expect(result?.remainingIfGood).toBe(0); // 3 - 2 - 1
        expect(result?.remainingIfBad).toBe(1); // 2 - 1
        expect(result?.remainingSteps).toBe(1); // estimateSteps(3)
      });
    });
  });

  describe('Given a diamond with branches B(ts=102) and C(ts=103), merge D(ts=104)', () => {
    describe('When bisectMidpoint runs with good=A, bad=D', () => {
      it('Then returns B as midpoint (older sibling wins tie, candidateCount=3)', async () => {
        // Arrange
        const sut = bisectMidpoint;
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const a = await commitAt(ctx, treeId, 100, []);
        const b = await commitAt(ctx, treeId, 102, [a]);
        const c = await commitAt(ctx, treeId, 103, [a]);
        const d = await commitAt(ctx, treeId, 104, [b, c]);

        // Act — candidates: {B, C, D} = 3; B weight=1, C weight=1, D weight=3
        const result = await sut(ctx, [a], d);

        // Assert — B wins (older → date-asc puts B before C → B first in list → wins tie)
        expect(result).not.toBeUndefined();
        expect(result?.nextCommit).toBe(b);
        expect(result?.candidateCount).toBe(3);
        expect(result?.remainingIfGood).toBe(1); // 3 - 1 - 1
        expect(result?.remainingIfBad).toBe(0); // 1 - 1
        expect(result?.remainingSteps).toBe(1); // estimateSteps(3)
      });
    });
  });

  describe('Given a 3-way octopus whose heap walk order decides a 3-way weight tie', () => {
    describe('When bisectMidpoint runs', () => {
      it('Then the FIFO/date tie-break resolves the tie to n1 (candidateCount=6)', async () => {
        // Arrange: root (good) -> n0(ts=101); n1(ts=100,[n0]) and n2(ts=101,[n0]) each
        // propagate n0's weight by fill (+1 = 2); n3(ts=102) seeds weight 1; n4(ts=100,
        // [n2,n3]) is an inner merge whose countDistance={n4,n2,n0,n3}=4 misses the
        // halfway band (2*4-6=2). bad(ts=103,[n0,n4,n1]) is the outer 3-way octopus.
        // n1, n2 and n4 all end up dist=min(weight,6-weight)=2 — a genuine 3-way tie
        // resolved only by which one is FIRST in the oldest-first candidate list, which
        // in turn depends on the heap's pop order (FIFO on equal dates, date order
        // otherwise) — exactly the `less` tie-break under test.
        const sut = bisectMidpoint;
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const root = await commitAt(ctx, treeId, 100, []);
        const n0 = await commitAt(ctx, treeId, 101, [root]);
        const n1 = await commitAt(ctx, treeId, 100, [n0]);
        const n2 = await commitAt(ctx, treeId, 101, [n0]);
        const n3 = await commitAt(ctx, treeId, 102, [root]);
        const n4 = await commitAt(ctx, treeId, 100, [n2, n3]);
        const bad = await commitAt(ctx, treeId, 103, [n0, n4, n1]);

        // Act — candidates = {n1,n2,n3,n4,n0,bad} = 6; no merge/fill early-return fires
        // (n4's weight=4 misses the band, n1/n2's weight=2 misses it too) so the winner
        // comes from bestBisection's list-order tie-break among the weight=2 trio.
        const result = await sut(ctx, [root], bad);

        // Assert
        expect(result).not.toBeUndefined();
        expect(result?.nextCommit).toBe(n1);
        expect(result?.candidateCount).toBe(6);
        expect(result?.remainingIfGood).toBe(3); // 6 - 2 - 1
        expect(result?.remainingIfBad).toBe(1); // 2 - 1
        expect(result?.remainingSteps).toBe(2); // estimateSteps(6)
      });
    });
  });

  describe('Given two equal-date leaves whose FIFO pop order breaks a weight tie', () => {
    describe('When bisectMidpoint runs with good=root, bad=merge([p1,p2])', () => {
      it('Then the second-enqueued equal-date parent wins (git-faithful FIFO tie-break)', async () => {
        // Arrange: root (good, ts=100); p1 and p2 both ts=200 with distinct messages so
        // they are separate objects sharing a committer date; bad (ts=300) merges [p1,p2].
        // Candidates = {p1,p2,bad}=3; p1,p2 both weight 1 (dist=1), bad weight 3 (dist=0),
        // so the winner is decided purely by which weight-1 leaf lands first in the
        // oldest-first candidate list — which the heap's equal-date FIFO tie-break fixes.
        // Real git (rev-list --bisect) selects the SECOND parent here, so p2 must win.
        const sut = bisectMidpoint;
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const root = await commitAt(ctx, treeId, 100, []);
        const p1 = await createCommit(ctx, {
          tree: treeId,
          parents: [root],
          author: { ...AUTHOR, timestamp: 200 },
          committer: { ...AUTHOR, timestamp: 200 },
          message: 'first-parent',
        });
        const p2 = await createCommit(ctx, {
          tree: treeId,
          parents: [root],
          author: { ...AUTHOR, timestamp: 200 },
          committer: { ...AUTHOR, timestamp: 200 },
          message: 'second-parent',
        });
        const bad = await commitAt(ctx, treeId, 300, [p1, p2]);

        // Act — candidates = {p1,p2,bad}; tie between p1 and p2 resolved by list order
        const result = await sut(ctx, [root], bad);

        // Assert — p2 (second enqueued, popped last among the equal-date pair, first in
        // the reversed oldest-first list) wins; under FIFO→LIFO flip p1 would win instead
        expect(result).not.toBeUndefined();
        expect(result?.nextCommit).toBe(p2);
        expect(result?.candidateCount).toBe(3);
        expect(result?.remainingIfGood).toBe(1); // 3 - 1 - 1
        expect(result?.remainingIfBad).toBe(0); // 1 - 1
        expect(result?.remainingSteps).toBe(1); // estimateSteps(3)
      });
    });
  });

  describe('Given multiple good commits (two branches)', () => {
    describe('When bisectMidpoint runs', () => {
      it('Then excludes all good-reachable commits from candidates', async () => {
        // Arrange: root → A(ts=101) and root → B(ts=102) are both good; bad=C(ts=103)→[A,B]
        const sut = bisectMidpoint;
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const root = await commitAt(ctx, treeId, 100, []);
        const a = await commitAt(ctx, treeId, 101, [root]);
        const b = await commitAt(ctx, treeId, 102, [root]);
        const c = await commitAt(ctx, treeId, 103, [a, b]);

        // Act — candidates = bad-reachable minus good-reachable = {C} only
        const result = await sut(ctx, [a, b], c);

        // Assert
        expect(result).not.toBeUndefined();
        expect(result?.nextCommit).toBe(c);
        expect(result?.candidateCount).toBe(1);
        expect(result?.remainingIfGood).toBe(-1);
        expect(result?.remainingIfBad).toBe(0);
      });
    });
  });

  describe('Given a non-commit object id passed as bad', () => {
    describe('When bisectMidpoint runs', () => {
      it('Then throws INVALID_WALK_INPUT', async () => {
        // Arrange
        const sut = bisectMidpoint;
        const ctx = await buildSeededContext();
        const blobId = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: new Uint8Array([0x68, 0x69]),
        });
        const treeId = await emptyTree(ctx);
        const good = await commitAt(ctx, treeId, 100, []);

        // Act + Assert
        try {
          await sut(ctx, [good], blobId as ObjectId);
          expect.fail('should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(TsgitError);
          const tErr = err as TsgitError;
          expect(tErr.data.code).toBe('INVALID_WALK_INPUT');
          expect(tErr.data.code === 'INVALID_WALK_INPUT' && tErr.data.reason).toBe(
            `bisectMidpoint: ${blobId} is not a commit`,
          );
        }
      });
    });
  });

  describe('Given a diamond with a shared in-set ancestor reachable from two candidate branches', () => {
    describe('When bisectMidpoint runs', () => {
      it('Then shared ancestor is counted once — candidateCount=4 (not 5)', async () => {
        // Arrange: root (good) → shared(ts=101) → pa(ts=102), pb(ts=103) → bad(ts=104)
        // shared is reachable from both pa and pb; without walk-dedup it would appear twice.
        const sut = bisectMidpoint;
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const root = await commitAt(ctx, treeId, 100, []);
        const shared = await commitAt(ctx, treeId, 101, [root]);
        const pa = await commitAt(ctx, treeId, 102, [shared]);
        const pb = await commitAt(ctx, treeId, 103, [shared]);
        const bad = await commitAt(ctx, treeId, 104, [pa, pb]);

        // Act — candidates = {shared, pa, pb, bad}; root is good-reachable
        const result = await sut(ctx, [root], bad);

        // Assert — shared must appear exactly once in the walk
        expect(result).not.toBeUndefined();
        expect(result?.candidateCount).toBe(4);
      });
    });
  });
});
