import { describe, expect, it } from 'vitest';

import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { mergeBase } from '../../../../src/application/primitives/merge-base.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
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
 * Criss-cross: D and E each merge both of A's children B and C, so the best
 * common ancestors of D and E are {B, C} (A is redundant — reachable from both).
 */
const buildCrissCross = async (
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
): Promise<{ a: ObjectId; b: ObjectId; c: ObjectId; d: ObjectId; e: ObjectId }> => {
  const treeId = await emptyTree(ctx);
  const a = await commitWith(ctx, treeId, 1, []);
  const b = await commitWith(ctx, treeId, 2, [a]);
  const c = await commitWith(ctx, treeId, 3, [a]);
  const d = await commitWith(ctx, treeId, 4, [b, c]);
  const e = await commitWith(ctx, treeId, 5, [c, b]);
  return { a, b, c, d, e };
};

/**
 * Build a parent←child pair where the child oid sorts lexicographically AFTER
 * its parent, so the self-base reduce must keep the child (the maximal element)
 * rather than surfacing the lex-smaller parent.
 */
const buildChildAfterParent = async (
  ctx: Context,
): Promise<{ child: ObjectId; parent: ObjectId }> => {
  const treeId = await emptyTree(ctx);
  let ts = 2_000_000_000;
  for (let attempt = 0; attempt < 200; attempt += 1, ts += 1) {
    const parent = await commitWith(ctx, treeId, ts, []);
    const child = await commitWith(ctx, treeId, ts + 1_000_000, [parent]);
    if (child > parent) return { child, parent };
  }
  throw new Error('could not build child-after-parent pair');
};

describe('mergeBase', () => {
  describe('Given a single commit [c]', () => {
    describe('When mergeBase', () => {
      it('Then returns [c] (self base)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const [c0] = await buildLinear(ctx, 1);

        // Act
        const sut = await mergeBase(ctx, [c0!]);

        // Assert
        expect(sut).toEqual([c0]);
      });
    });
  });

  describe('Given commits [a, a]', () => {
    describe('When mergeBase', () => {
      it('Then returns [a] (self base via reduce)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const [c0] = await buildLinear(ctx, 1);

        // Act
        const sut = await mergeBase(ctx, [c0!, c0!]);

        // Assert
        expect(sut).toEqual([c0]);
      });
    });
  });

  describe('Given [child, child] where the commit has a lex-smaller parent', () => {
    describe('When mergeBase', () => {
      it('Then returns [child] not [parent]', async () => {
        // Arrange — the reduce must keep the maximal element (child), dropping
        // the reachable parent even though it sorts lex-smaller.
        const ctx = await buildSeededContext();
        const { child, parent } = await buildChildAfterParent(ctx);

        // Act
        const sut = await mergeBase(ctx, [child, child]);

        // Assert
        expect(sut).toEqual([child]);
        expect(sut).not.toContain(parent);
      });
    });
  });

  describe('Given linear A←B←C←D', () => {
    describe('When mergeBase([D, B])', () => {
      it('Then returns [B]', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const [, b, , d] = await buildLinear(ctx, 4);

        // Act
        const sut = await mergeBase(ctx, [d!, b!]);

        // Assert
        expect(sut).toEqual([b]);
      });
    });
  });

  describe('Given linear A←B←C', () => {
    describe('When mergeBase([C, A])', () => {
      it('Then returns [A]', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const [a, , c] = await buildLinear(ctx, 3);

        // Act
        const sut = await mergeBase(ctx, [c!, a!]);

        // Assert
        expect(sut).toEqual([a]);
      });
    });

    describe('When mergeBase([C, A], { all: true })', () => {
      it('Then returns [A] (single LCA as a one-element array)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const [a, , c] = await buildLinear(ctx, 3);

        // Act
        const sut = await mergeBase(ctx, [c!, a!], { all: true });

        // Assert
        expect(sut).toEqual([a]);
      });
    });
  });

  describe('Given a diamond A←{B,C}←D', () => {
    describe('When mergeBase([B, C])', () => {
      it('Then returns [A]', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { a, b, c } = await buildDiamond(ctx);

        // Act
        const sut = await mergeBase(ctx, [b, c]);

        // Assert
        expect(sut).toEqual([a]);
      });
    });
  });

  describe('Given a criss-cross with two best common ancestors B and C', () => {
    describe('When mergeBase([D, E]) (default truncates)', () => {
      it('Then returns only the lexicographically smallest base', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { a, b, c, d, e } = await buildCrissCross(ctx);
        const [smaller] = [b, c].sort() as [ObjectId, ObjectId];

        // Act
        const sut = await mergeBase(ctx, [d, e]);

        // Assert
        expect(sut).toEqual([smaller]);
        expect(sut).not.toContain(a);
      });
    });

    describe('When mergeBase([D, E], { all: true })', () => {
      it('Then returns both B and C sorted, without the redundant A', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { a, b, c, d, e } = await buildCrissCross(ctx);
        const expected = [b, c].sort();

        // Act
        const sut = await mergeBase(ctx, [d, e], { all: true });

        // Assert
        expect(sut).toEqual(expected);
        expect(sut).not.toContain(a);
      });
    });
  });

  describe('Given two unrelated histories', () => {
    describe('When mergeBase([x, y])', () => {
      it('Then returns []', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const x = await commitWith(ctx, treeId, 1, []);
        const y = await commitWith(ctx, treeId, 2, []);

        // Act
        const sut = await mergeBase(ctx, [x, y]);

        // Assert
        expect(sut).toEqual([]);
      });
    });

    describe('When mergeBase([x, y], { all: true })', () => {
      it('Then returns [] (both-frontiers-stale exit)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const x = await commitWith(ctx, treeId, 1, []);
        const y = await commitWith(ctx, treeId, 2, []);

        // Act
        const sut = await mergeBase(ctx, [x, y], { all: true });

        // Assert
        expect(sut).toEqual([]);
      });
    });
  });

  describe('Given an empty commit list', () => {
    describe('When mergeBase([])', () => {
      it('Then throws INVALID_WALK_INPUT with a reason', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = mergeBase;

        // Act + Assert
        try {
          await sut(ctx, []);
          throw new Error('expected throw');
        } catch (err) {
          // Assert
          expect(err).toBeInstanceOf(TsgitError);
          if (!(err instanceof TsgitError)) throw err;
          expect(err.data.code).toBe('INVALID_WALK_INPUT');
          expect(err.data.code === 'INVALID_WALK_INPUT' && err.data.reason).toBe(
            'mergeBase requires at least one commit',
          );
        }
      });
    });
  });

  describe('Given an input oid that is not a commit', () => {
    describe('When mergeBase([tree, commit])', () => {
      it('Then returns [] (a non-commit contributes no parents)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const [c0] = await buildLinear(ctx, 1);

        // Act
        const sut = await mergeBase(ctx, [treeId, c0!]);

        // Assert
        expect(sut).toEqual([]);
      });
    });
  });

  describe('Given a base C and its parent B both common to two tips', () => {
    describe('When mergeBase([x, y], { all: true })', () => {
      it('Then prunes the deeper ancestor via STALE and returns only [C]', async () => {
        // Arrange — A←B←C, then X and Y both fork off C. Common ancestors are
        // {C, B, A}; only C is a best base, B and A are pruned by STALE.
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const a = await commitWith(ctx, treeId, 1, []);
        const b = await commitWith(ctx, treeId, 2, [a]);
        const c = await commitWith(ctx, treeId, 3, [b]);
        const x = await commitWith(ctx, treeId, 4, [c]);
        const y = await commitWith(ctx, treeId, 5, [c]);

        // Act
        const sut = await mergeBase(ctx, [x, y], { all: true });

        // Assert
        expect(sut).toEqual([c]);
        expect(sut).not.toContain(b);
        expect(sut).not.toContain(a);
      });
    });
  });

  describe('Given a diamond whose ancestor has a newer timestamp than its children', () => {
    describe('When mergeBase([B, C])', () => {
      it('Then the date-ordered queue still returns the correct base [A]', async () => {
        // Arrange — clock skew: A is timestamped far in the future relative to
        // B and C, so the priority queue pops A early; flags + STALE must still
        // yield the right base regardless of pop order.
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const a = await commitWith(ctx, treeId, 9_000_000_000, []);
        const b = await commitWith(ctx, treeId, 10, [a]);
        const c = await commitWith(ctx, treeId, 20, [a]);

        // Act
        const sut = await mergeBase(ctx, [b, c]);

        // Assert
        expect(sut).toEqual([a]);
      });
    });
  });

  describe('Given three branches off a shared root', () => {
    describe('When mergeBase([b, c, d], { octopus: true })', () => {
      it('Then returns the shared root', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const root = await commitWith(ctx, treeId, 1, []);
        const b = await commitWith(ctx, treeId, 2, [root]);
        const c = await commitWith(ctx, treeId, 3, [root]);
        const d = await commitWith(ctx, treeId, 4, [root]);

        // Act
        const sut = await mergeBase(ctx, [b, c, d], { octopus: true });

        // Assert
        expect(sut).toEqual([root]);
      });
    });
  });

  describe('Given a single commit under octopus', () => {
    describe('When mergeBase([c], { octopus: true })', () => {
      it('Then returns [c]', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const [c0] = await buildLinear(ctx, 1);

        // Act
        const sut = await mergeBase(ctx, [c0!], { octopus: true });

        // Assert
        expect(sut).toEqual([c0]);
      });
    });
  });

  describe('Given two commits of a criss-cross under octopus', () => {
    describe('When mergeBase([D, E], { octopus: true, all: true })', () => {
      it('Then equals the two-commit --all set [B, C]', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { b, c, d, e } = await buildCrissCross(ctx);
        const expected = [b, c].sort();

        // Act
        const sut = await mergeBase(ctx, [d, e], { octopus: true, all: true });

        // Assert
        expect(sut).toEqual(expected);
      });
    });

    describe('When mergeBase([D, E], { octopus: true }) (default truncates)', () => {
      it('Then returns the lexicographically smallest single base', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { b, c, d, e } = await buildCrissCross(ctx);
        const [smaller] = [b, c].sort() as [ObjectId, ObjectId];

        // Act
        const sut = await mergeBase(ctx, [d, e], { octopus: true });

        // Assert
        expect(sut).toEqual([smaller]);
      });
    });
  });

  describe('Given unrelated commits under octopus', () => {
    describe('When mergeBase([x, y], { octopus: true })', () => {
      it('Then returns []', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const x = await commitWith(ctx, treeId, 1, []);
        const y = await commitWith(ctx, treeId, 2, []);

        // Act
        const sut = await mergeBase(ctx, [x, y], { octopus: true });

        // Assert
        expect(sut).toEqual([]);
      });
    });
  });
});
