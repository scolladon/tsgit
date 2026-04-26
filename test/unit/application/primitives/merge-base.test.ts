import { describe, expect, it } from 'vitest';

import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { mergeBase } from '../../../../src/application/primitives/merge-base.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { AuthorIdentity, ObjectId, Tree } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

const AUTHOR: AuthorIdentity = {
  name: 'Alice',
  email: 'a@a.com',
  timestamp: 1700000000,
  timezoneOffset: '+0000',
};

const buildLinear = async (
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  n: number,
): Promise<ObjectId[]> => {
  const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
  const treeId = await writeObject(ctx, tree);
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
};

const buildDiamond = async (
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
): Promise<{ a: ObjectId; b: ObjectId; c: ObjectId; d: ObjectId }> => {
  const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
  const treeId = await writeObject(ctx, tree);
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

  it('Given two unrelated histories, When mergeBase, Then returns undefined', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
    const treeId = await writeObject(ctx, tree);
    const x = await createCommit(ctx, {
      tree: treeId,
      parents: [],
      author: { ...AUTHOR, timestamp: 1 },
      committer: { ...AUTHOR, timestamp: 1 },
      message: 'x',
    });
    const y = await createCommit(ctx, {
      tree: treeId,
      parents: [],
      author: { ...AUTHOR, timestamp: 2 },
      committer: { ...AUTHOR, timestamp: 2 },
      message: 'y',
    });

    // Act
    const sut = await mergeBase(ctx, x, y);

    // Assert
    expect(sut).toBeUndefined();
  });
});
