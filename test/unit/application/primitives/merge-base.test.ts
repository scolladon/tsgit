import { describe, expect, it } from 'vitest';

import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { mergeBase } from '../../../../src/application/primitives/merge-base.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { AuthorIdentity, ObjectId, Tree } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from './fixtures.js';

const AUTHOR: AuthorIdentity = {
  name: 'Alice',
  email: 'a@a.com',
  timestamp: 1700000000,
  timezoneOffset: '+0000',
};

const emptyTree = async (ctx: Context): Promise<ObjectId> => {
  const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
  return writeObject(ctx, tree);
};

const commitWith = async (
  ctx: Context,
  treeId: ObjectId,
  ts: number,
  parents: ObjectId[],
): Promise<ObjectId> =>
  createCommit(ctx, {
    tree: treeId,
    parents,
    author: { ...AUTHOR, timestamp: ts },
    committer: { ...AUTHOR, timestamp: ts },
    message: `c${ts}`,
  });

const buildLinear = async (
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  n: number,
): Promise<ObjectId[]> => {
  const treeId = await emptyTree(ctx);
  const ids: ObjectId[] = [];
  let parent: ObjectId[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = await commitWith(ctx, treeId, 1700000000 + i, parent);
    ids.push(id);
    parent = [id];
  }
  return ids;
};

const buildDiamond = async (
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
): Promise<{ a: ObjectId; b: ObjectId; c: ObjectId; d: ObjectId }> => {
  const treeId = await emptyTree(ctx);
  const a = await commitWith(ctx, treeId, 1, []);
  const b = await commitWith(ctx, treeId, 2, [a]);
  const c = await commitWith(ctx, treeId, 3, [a]);
  const d = await commitWith(ctx, treeId, 4, [b, c]);
  return { a, b, c, d };
};

/**
 * Build a parent←child pair where the child oid sorts lexicographically AFTER
 * its parent. Used to prove the `a === b` self-base shortcut: without it the
 * BFS would surface the lex-smaller parent instead of the child itself.
 */
const buildChildAfterParent = async (
  ctx: Context,
): Promise<{ child: ObjectId; parent: ObjectId }> => {
  const treeId = await emptyTree(ctx);
  let ts = 2_000_000_000;
  // Hashes are effectively random; a handful of timestamps yields an ordered pair.
  for (let attempt = 0; attempt < 200; attempt += 1, ts += 1) {
    const parent = await commitWith(ctx, treeId, ts, []);
    const child = await commitWith(ctx, treeId, ts + 1_000_000, [parent]);
    if (child > parent) return { child, parent };
  }
  throw new Error('could not build child-after-parent pair');
};

describe('mergeBase', () => {
  it('Given a === b, When mergeBase, Then returns the same oid (self-base shortcut)', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const [c0] = await buildLinear(ctx, 1);

    // Act
    const sut = await mergeBase(ctx, c0!, c0!);

    // Assert
    expect(sut).toBe(c0);
  });

  it('Given a === b where the commit has a lex-smaller parent, When mergeBase, Then returns the commit itself not the parent', async () => {
    // Arrange — without the `a === b` shortcut the BFS would intersect on both
    // the commit and its parent and return the lex-smaller (the parent).
    const ctx = await buildSeededContext();
    const { child, parent } = await buildChildAfterParent(ctx);

    // Act
    const sut = await mergeBase(ctx, child, child);

    // Assert
    expect(sut).toBe(child);
    expect(sut).not.toBe(parent);
  });

  it('Given linear A←B←C←D, When mergeBase(D, B), Then returns B', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const [, b, , d] = await buildLinear(ctx, 4);

    // Act
    const sut = await mergeBase(ctx, d!, b!);

    // Assert
    expect(sut).toBe(b);
  });

  it('Given linear A←B←C, When mergeBase(C, A), Then returns A', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const [a, , c] = await buildLinear(ctx, 3);

    // Act
    const sut = await mergeBase(ctx, c!, a!);

    // Assert
    expect(sut).toBe(a);
  });

  it('Given a diamond A←{B,C}←D, When mergeBase(B, C), Then returns A', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const { a, b, c } = await buildDiamond(ctx);

    // Act
    const sut = await mergeBase(ctx, b, c);

    // Assert
    expect(sut).toBe(a);
  });

  it('Given a diamond top D vs an unrelated commit, When mergeBase, Then returns undefined despite D re-reaching A via both parents', async () => {
    // Arrange — D's two parents B and C both lead back to A. Advancing the
    // frontier [B,C] visits A from B then must SKIP A from C (already visited).
    const ctx = await buildSeededContext();
    const { d } = await buildDiamond(ctx);
    const treeId = await emptyTree(ctx);
    const unrelated = await commitWith(ctx, treeId, 9_000, []);

    // Act
    const sut = await mergeBase(ctx, d, unrelated);

    // Assert
    expect(sut).toBeUndefined();
  });

  it('Given two commits sharing two parents, When mergeBase, Then returns the lexicographically smallest common parent', async () => {
    // Arrange — both M and N have parents [bigger, smaller] in that order, so
    // the intersection is discovered in insertion order [bigger, smaller];
    // only sorting yields the documented lex-smallest tie-breaker.
    const ctx = await buildSeededContext();
    const treeId = await emptyTree(ctx);
    const p = await commitWith(ctx, treeId, 100, []);
    const q = await commitWith(ctx, treeId, 200, []);
    const [smaller, bigger] = [p, q].sort() as [ObjectId, ObjectId];
    const m = await commitWith(ctx, treeId, 300, [bigger, smaller]);
    const n = await commitWith(ctx, treeId, 400, [bigger, smaller]);

    // Act
    const sut = await mergeBase(ctx, m, n);

    // Assert
    expect(sut).toBe(smaller);
    expect(sut).not.toBe(bigger);
  });

  it('Given a short branch A and a longer unrelated branch, When mergeBase, Then walks the longer branch after the short one is exhausted and returns the shared base', async () => {
    // Arrange — A side: A0←A1 (2 commits). B side: A0←B1←B2←B3 (shares root A0
    // but only reached after A's frontier is empty). Proves the loop keeps
    // advancing the surviving frontier and does not break while B still has work.
    const ctx = await buildSeededContext();
    const treeId = await emptyTree(ctx);
    const a0 = await commitWith(ctx, treeId, 1, []);
    const a1 = await commitWith(ctx, treeId, 2, [a0]);
    const b1 = await commitWith(ctx, treeId, 3, [a0]);
    const b2 = await commitWith(ctx, treeId, 4, [b1]);
    const b3 = await commitWith(ctx, treeId, 5, [b2]);

    // Act
    const sut = await mergeBase(ctx, a1, b3);

    // Assert
    expect(sut).toBe(a0);
  });

  it('Given two unrelated histories, When mergeBase, Then terminates via the both-frontiers-exhausted break and returns undefined', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const treeId = await emptyTree(ctx);
    const x = await commitWith(ctx, treeId, 1, []);
    const y = await commitWith(ctx, treeId, 2, []);

    // Act
    const sut = await mergeBase(ctx, x, y);

    // Assert
    expect(sut).toBeUndefined();
  });

  it('Given two unrelated multi-commit branches, When mergeBase, Then advancing exhausted frontiers terminates and returns undefined', async () => {
    // Arrange — both frontiers become empty; the loop must stop once neither
    // advance produced new commits.
    const ctx = await buildSeededContext();
    const treeId = await emptyTree(ctx);
    const x0 = await commitWith(ctx, treeId, 1, []);
    const x1 = await commitWith(ctx, treeId, 2, [x0]);
    const y0 = await commitWith(ctx, treeId, 3, []);
    const y1 = await commitWith(ctx, treeId, 4, [y0]);

    // Act
    const sut = await mergeBase(ctx, x1, y1);

    // Assert
    expect(sut).toBeUndefined();
  });
});
