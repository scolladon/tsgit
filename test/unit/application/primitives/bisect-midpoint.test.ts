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
      it('Then returns structured midpoint at c[5] with correct counts', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const commits = await buildLinear(ctx, 10);
        const good = commits[0]!;
        const bad = commits[9]!;

        // Act
        const sut = await bisectMidpoint(ctx, [good], bad);

        // Assert — 9 candidates {c[1]..c[9]}; fill-phase fires at c[4] (weight=4,
        // approxHalfway(4,9): 2*4−9=−1 ∈ [−1,1] → early return before tie-break)
        expect(sut).not.toBeUndefined();
        expect(sut?.nextCommit).toBe(commits[4]);
        expect(sut?.candidateCount).toBe(9);
        expect(sut?.remainingIfGood).toBe(4); // 9 - 4 - 1
        expect(sut?.remainingIfBad).toBe(3); // 4 - 1
        expect(sut?.remainingSteps).toBe(2); // estimateSteps(9)
      });
    });
  });

  describe('Given a linear 2-commit chain, good=c[0], bad=c[1]', () => {
    describe('When bisectMidpoint runs', () => {
      it('Then returns a single-candidate result with remainingIfGood=-1', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const commits = await buildLinear(ctx, 2);
        const good = commits[0]!;
        const bad = commits[1]!;

        // Act
        const sut = await bisectMidpoint(ctx, [good], bad);

        // Assert — 1 candidate {c[1]}; reaches=1 → remainingIfGood=-1
        expect(sut).not.toBeUndefined();
        expect(sut?.nextCommit).toBe(bad);
        expect(sut?.candidateCount).toBe(1);
        expect(sut?.remainingIfGood).toBe(-1);
        expect(sut?.remainingIfBad).toBe(0);
        expect(sut?.remainingSteps).toBe(0);
      });
    });
  });

  describe('Given good commit covers all of bad-reachable set', () => {
    describe('When bisectMidpoint runs', () => {
      it('Then returns undefined (empty candidate set)', async () => {
        // Arrange — good=c[1] (descendant of bad=c[0]) → c[0] reachable from good
        const ctx = await buildSeededContext();
        const commits = await buildLinear(ctx, 2);
        const good = commits[1]!;
        const bad = commits[0]!;

        // Act
        const sut = await bisectMidpoint(ctx, [good], bad);

        // Assert
        expect(sut).toBeUndefined();
      });
    });
  });

  describe('Given a diamond with branches B(ts=102) and C(ts=103), merge D(ts=104)', () => {
    describe('When bisectMidpoint runs with good=A, bad=D', () => {
      it('Then returns B as midpoint (older sibling wins tie, candidateCount=3)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const a = await commitAt(ctx, treeId, 100, []);
        const b = await commitAt(ctx, treeId, 102, [a]);
        const c = await commitAt(ctx, treeId, 103, [a]);
        const d = await commitAt(ctx, treeId, 104, [b, c]);

        // Act — candidates: {B, C, D} = 3; B weight=1, C weight=1, D weight=3
        const sut = await bisectMidpoint(ctx, [a], d);

        // Assert — B wins (older → first in date-asc list, ties with C at dist=1)
        expect(sut).not.toBeUndefined();
        expect(sut?.nextCommit).toBe(b);
        expect(sut?.candidateCount).toBe(3);
        expect(sut?.remainingIfGood).toBe(1); // 3 - 1 - 1
        expect(sut?.remainingIfBad).toBe(0); // 1 - 1
        expect(sut?.remainingSteps).toBe(1); // estimateSteps(3)
      });
    });
  });

  describe('Given multiple good commits (two branches)', () => {
    describe('When bisectMidpoint runs', () => {
      it('Then excludes all good-reachable commits from candidates', async () => {
        // Arrange: root → A(ts=101) and root → B(ts=102) are both good; bad=C(ts=103)→[A,B]
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const root = await commitAt(ctx, treeId, 100, []);
        const a = await commitAt(ctx, treeId, 101, [root]);
        const b = await commitAt(ctx, treeId, 102, [root]);
        const c = await commitAt(ctx, treeId, 103, [a, b]);

        // Act — candidates = bad-reachable minus good-reachable = {C} only
        const sut = await bisectMidpoint(ctx, [a, b], c);

        // Assert
        expect(sut).not.toBeUndefined();
        expect(sut?.nextCommit).toBe(c);
        expect(sut?.candidateCount).toBe(1);
        expect(sut?.remainingIfGood).toBe(-1);
        expect(sut?.remainingIfBad).toBe(0);
      });
    });
  });

  describe('Given a non-commit object id passed as bad', () => {
    describe('When bisectMidpoint runs', () => {
      it('Then throws INVALID_WALK_INPUT', async () => {
        // Arrange
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
          await bisectMidpoint(ctx, [good], blobId as ObjectId);
          expect.fail('should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(TsgitError);
          expect((err as TsgitError).data.code).toBe('INVALID_WALK_INPUT');
        }
      });
    });
  });
});
