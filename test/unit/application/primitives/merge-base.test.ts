import { describe, expect, it, type MockInstance, vi } from 'vitest';

import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import * as readCommitGraphModule from '../../../../src/application/primitives/internal/read-commit-graph.js';
import * as readCommitMetaModule from '../../../../src/application/primitives/internal/read-commit-meta.js';
import { mergeBase } from '../../../../src/application/primitives/merge-base.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type {
  AuthorIdentity,
  Commit,
  ObjectId,
  Tree,
} from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext, instrumentedContext, writeCommitGraph } from './fixtures.js';

const OBJECT_STORE_READ = /\/objects\/(pack\/|[0-9a-f]{2}\/)/;

const objectStoreReadPaths = (
  calls: ReadonlyArray<{ readonly method: string; readonly path: string }>,
): ReadonlyArray<string> =>
  calls
    .filter((call) => call.method === 'read' && OBJECT_STORE_READ.test(call.path))
    .map((c) => c.path);

/** Every oid the walk asked `readCommitMeta` about — the per-call memo means
 *  each consulted commit appears exactly once, so the set pins the walk's
 *  reach without depending on where the bytes came from. */
const consultedIds = (
  spy: MockInstance<typeof readCommitMetaModule.readCommitMeta>,
): ReadonlySet<ObjectId> => new Set(spy.mock.calls.map(([, id]) => id));

const asCommits = async (ctx: Context, ids: ReadonlyArray<ObjectId>): Promise<Commit[]> => {
  const commits: Commit[] = [];
  for (const id of ids) {
    const object = await readObject(ctx, id);
    if (object.type !== 'commit') throw new Error('expected a commit');
    commits.push(object);
  }
  return commits;
};

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

const commitNamed = async (
  ctx: Context,
  treeId: ObjectId,
  ts: number,
  parents: ObjectId[],
  message: string,
): Promise<ObjectId> =>
  createCommit(ctx, {
    tree: treeId,
    parents,
    author: { ...AUTHOR, timestamp: ts },
    committer: { ...AUTHOR, timestamp: ts },
    message,
  });

const commitWith = async (
  ctx: Context,
  treeId: ObjectId,
  ts: number,
  parents: ObjectId[],
): Promise<ObjectId> => commitNamed(ctx, treeId, ts, parents, `c${ts}`);

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
 * Retry `buildCrissCross`'s shape with a varying salt until C's oid is NOT the
 * lexicographically smallest of {B, C} — the newest-base (single-result) and
 * oid-sorted ({ all: true }) rules then genuinely disagree, rather than
 * coincidentally aligning for one particular hash.
 */
const buildCrissCrossWithDisagreeingOrders = async (
  ctx: Context,
): Promise<{ b: ObjectId; c: ObjectId; d: ObjectId; e: ObjectId }> => {
  const treeId = await emptyTree(ctx);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const salt = attempt * 10;
    const a = await commitWith(ctx, treeId, 1000 + salt, []);
    const b = await commitWith(ctx, treeId, 2000 + salt, [a]);
    const c = await commitWith(ctx, treeId, 3000 + salt, [a]);
    const d = await commitWith(ctx, treeId, 4000 + salt, [b, c]);
    const e = await commitWith(ctx, treeId, 5000 + salt, [c, b]);
    const [lexSmallest] = [b, c].sort() as [ObjectId, ObjectId];
    if (c !== lexSmallest) return { b, c, d, e };
  }
  throw new Error('could not build a disagreeing criss-cross after 200 attempts');
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
        const result = await mergeBase(ctx, [c0!]);

        // Assert
        expect(result).toEqual([c0]);
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
        const result = await mergeBase(ctx, [c0!, c0!]);

        // Assert
        expect(result).toEqual([c0]);
      });
    });
  });

  describe('Given [child, child] where the commit has a lex-smaller parent', () => {
    describe('When mergeBase', () => {
      it('Then returns [child] without walking a single commit', async () => {
        // Arrange — git answers a commit compared against itself from the
        // arguments alone, deliberately leaving it unflagged so there is
        // nothing to clean up; nothing below it is ever consulted, and the
        // lex-smaller parent can therefore never surface.
        const ctx = await buildSeededContext();
        const { child, parent } = await buildChildAfterParent(ctx);
        const consult = vi.spyOn(readCommitMetaModule, 'readCommitMeta');

        // Act
        const result = await mergeBase(ctx, [child, child]);

        // Assert
        expect(result).toEqual([child]);
        expect(result).not.toContain(parent);
        expect(consultedIds(consult)).toEqual(new Set());
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
        const result = await mergeBase(ctx, [d!, b!]);

        // Assert
        expect(result).toEqual([b]);
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
        const result = await mergeBase(ctx, [c!, a!]);

        // Assert
        expect(result).toEqual([a]);
      });
    });

    describe('When mergeBase([C, A], { all: true })', () => {
      it('Then returns [A] (single LCA as a one-element array)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const [a, , c] = await buildLinear(ctx, 3);

        // Act
        const result = await mergeBase(ctx, [c!, a!], { all: true });

        // Assert
        expect(result).toEqual([a]);
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
        const result = await mergeBase(ctx, [b, c]);

        // Assert
        expect(result).toEqual([a]);
      });
    });
  });

  describe('Given a criss-cross with two best common ancestors B (older) and C (newer)', () => {
    describe('When mergeBase([D, E]) (default truncates)', () => {
      it('Then returns the newest base, not the lexicographically smallest', async () => {
        // Arrange — B (date 2) and C (date 3) are both valid bases; the
        // newest-date base wins the single-result rule regardless of oid order.
        const ctx = await buildSeededContext();
        const { a, c, d, e } = await buildCrissCross(ctx);

        // Act
        const result = await mergeBase(ctx, [d, e]);

        // Assert
        expect(result).toEqual([c]);
        expect(result).not.toContain(a);
      });
    });

    describe('When mergeBase([D, E], { all: true })', () => {
      it('Then returns both B and C oid-sorted, without the redundant A', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { a, b, c, d, e } = await buildCrissCross(ctx);
        const expected = [b, c].sort();

        // Act
        const result = await mergeBase(ctx, [d, e], { all: true });

        // Assert
        expect(result).toEqual(expected);
        expect(result).not.toContain(a);
      });
    });
  });

  describe('Given a criss-cross whose newest base is not the lexicographically smallest', () => {
    describe('When mergeBase runs both without and with { all: true }', () => {
      it('Then the single-result and { all: true } orders deliberately disagree', async () => {
        // Arrange — retry with a varying salt until the newest base's oid is
        // NOT the lexicographically smallest of {B, C}, proving the two rules
        // genuinely diverge rather than coincidentally aligning for one hash.
        const ctx = await buildSeededContext();
        const { b, c, d, e } = await buildCrissCrossWithDisagreeingOrders(ctx);

        // Act
        const single = await mergeBase(ctx, [d, e]);
        const all = await mergeBase(ctx, [d, e], { all: true });

        // Assert
        expect(single).toEqual([c]);
        expect(all).toEqual([b, c].sort());
        expect(all[0]).not.toEqual(single[0]);
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
        const result = await mergeBase(ctx, [x, y]);

        // Assert
        expect(result).toEqual([]);
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
        const result = await mergeBase(ctx, [x, y], { all: true });

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given an empty commit list', () => {
    describe('When mergeBase([])', () => {
      it('Then throws INVALID_WALK_INPUT with a reason', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = mergeBase;

        // Act
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
        const result = await mergeBase(ctx, [treeId, c0!]);

        // Assert
        expect(result).toEqual([]);
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
        const result = await mergeBase(ctx, [x, y], { all: true });

        // Assert
        expect(result).toEqual([c]);
        expect(result).not.toContain(b);
        expect(result).not.toContain(a);
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
        const result = await mergeBase(ctx, [b, c]);

        // Assert
        expect(result).toEqual([a]);
      });
    });
  });

  describe('Given two sibling commits sharing the same committer timestamp', () => {
    describe('When mergeBase([B, C])', () => {
      it('Then the queue tie-breaks by discovery order and still returns [A]', async () => {
        // Arrange — B and C share committer timestamp 200 (forcing the queue's
        // insertion-order tie-break) but carry distinct messages so they stay
        // distinct oids.
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const a = await commitWith(ctx, treeId, 100, []);
        const sameTs = { ...AUTHOR, timestamp: 200 };
        const b = await createCommit(ctx, {
          tree: treeId,
          parents: [a],
          author: sameTs,
          committer: sameTs,
          message: 'branch-b',
        });
        const c = await createCommit(ctx, {
          tree: treeId,
          parents: [a],
          author: sameTs,
          committer: sameTs,
          message: 'branch-c',
        });

        // Act
        const result = await mergeBase(ctx, [b, c]);

        // Assert
        expect(result).toEqual([a]);
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
        const result = await mergeBase(ctx, [b, c, d], { octopus: true });

        // Assert
        expect(result).toEqual([root]);
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
        const result = await mergeBase(ctx, [c0!], { octopus: true });

        // Assert
        expect(result).toEqual([c0]);
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
        const result = await mergeBase(ctx, [d, e], { octopus: true, all: true });

        // Assert
        expect(result).toEqual(expected);
      });
    });

    describe('When mergeBase([D, E], { octopus: true }) (default truncates)', () => {
      it('Then returns the newest single base', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { c, d, e } = await buildCrissCross(ctx);

        // Act
        const result = await mergeBase(ctx, [d, e], { octopus: true });

        // Assert
        expect(result).toEqual([c]);
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
        const result = await mergeBase(ctx, [x, y], { octopus: true });

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given an octopus fold that accumulates a redundant ancestor', () => {
    describe('When mergeBase([X, E, Q], { octopus: true, all: true })', () => {
      it('Then drops the root ancestor and keeps only the lower base Q', async () => {
        // Arrange — X and E criss-cross over {B, C}; folding against C makes the
        // accumulator hold {root, C}, where root is an ancestor of C. The final
        // reduce must drop root and keep C.
        const ctx = await buildSeededContext();
        const { a, c, d, e } = await buildCrissCross(ctx);

        // Act
        const result = await mergeBase(ctx, [d, e, c], { octopus: true, all: true });

        // Assert
        expect(result).toEqual([c]);
        expect(result).not.toContain(a);
      });
    });
  });

  describe('Given a shallow boundary compared directly against the tip', () => {
    describe('When mergeBase runs', () => {
      it('Then the boundary itself is the base — proving it is an ancestor of the tip', async () => {
        // Arrange — linear chain root ← boundary ← tip.
        const ctx = await buildSeededContext();
        const chain = await buildLinear(ctx, 3);
        const root = chain[0]!;
        const boundary = chain[1]!;
        const tip = chain[2]!;
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${boundary}\n`);

        // Act
        const result = await mergeBase(ctx, [tip, boundary]);

        // Assert
        expect(result).toEqual([boundary]);
        expect(result).not.toContain(root);
      });
    });
  });

  describe('Given a shallow boundary whose true parent was never fetched into the store', () => {
    describe('When mergeBase compares the tip against the boundary', () => {
      it('Then resolves without ever reading the absent grandparent', async () => {
        // Arrange — the boundary's raw parent oid names an object that is never
        // written, simulating a shallow clone's cut history; a walk that failed
        // to mask the boundary would try to read it and throw.
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const missingParent = 'a'.repeat(40) as ObjectId;
        const boundary = await commitWith(ctx, treeId, 1, [missingParent]);
        const tip = await commitWith(ctx, treeId, 2, [boundary]);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${boundary}\n`);

        // Act
        const result = await mergeBase(ctx, [tip, boundary]);

        // Assert
        expect(result).toEqual([boundary]);
      });
    });
  });

  describe('Given a commit-graph covering every commit in a criss-cross reduction', () => {
    describe('When mergeBase({ all: true }) runs', () => {
      it('Then it reads no object from the store', async () => {
        // Arrange
        const base = await buildSeededContext();
        const { a, b, c, d, e } = await buildCrissCross(base);
        await writeCommitGraph(base, [await asCommits(base, [a, b, c, d, e])]);
        // The fixture's own asCommits reads (to build the graph model) warm
        // the object cache; clear it so the assertion below reflects the
        // graph path, not leftover fixture-setup reads.
        base.deltaCache.clear();
        const { ctx, calls } = instrumentedContext(base);

        // Act
        const result = await mergeBase(ctx, [d, e], { all: true });

        // Assert
        expect(result).toEqual([b, c].sort());
        expect(objectStoreReadPaths(calls())).toEqual([]);
      });
    });
  });

  describe('Given no commit-graph exists', () => {
    describe('When mergeBase({ all: true }) reduces a criss-cross', () => {
      it('Then the reduced set is unchanged and every read still hits the object store', async () => {
        // Arrange — regression guard for the migration to readCommitMeta: the
        // no-graph fallback path must still resolve every commit.
        const base = await buildSeededContext();
        const { a, b, c, d, e } = await buildCrissCross(base);
        const { ctx, calls } = instrumentedContext(base);

        // Act
        const result = await mergeBase(ctx, [d, e], { all: true });

        // Assert
        expect(result).toEqual([b, c].sort());
        expect(result).not.toContain(a);
        expect(objectStoreReadPaths(calls()).length).toBeGreaterThan(0);
      });
    });
  });

  describe('Given a diamond whose shared root carries a much lower generation than its children', () => {
    describe('When mergeBase([b, c]) runs', () => {
      it('Then the main discovery paint still finds the low-generation root (it never breaks)', async () => {
        // Arrange — mergeBasesMany's own paint always passes minGeneration 0,
        // so a root whose generation is far below its children must still be
        // discovered rather than pruned by an early break.
        const base = await buildSeededContext();
        const treeId = await emptyTree(base);
        const root = await commitWith(base, treeId, 1, []);
        const b = await commitWith(base, treeId, 1_000, [root]);
        const c = await commitWith(base, treeId, 1_001, [root]);
        await writeCommitGraph(base, [await asCommits(base, [root, b, c])]);

        // Act
        const result = await mergeBase(base, [b, c]);

        // Assert
        expect(result).toEqual([root]);
      });
    });
  });

  describe('Given two disjoint candidate chains whose reduction boundary is graph-covered', () => {
    describe('When mergeBase({ all: true }) reduces the two non-redundant candidates', () => {
      it('Then removeRedundant breaks at the minimum generation and never consults past it', async () => {
        // Arrange — P and Q are fully disjoint linear chains; D and E both
        // merge their tips directly, so p2 and q2 are both non-redundant
        // merge bases with no common ancestor between them. The graph covers
        // EVERY commit, so the oracle is which commits the walk consults, not
        // where the bytes come from: the reduction floor is the candidate-set
        // minimum generation (300), so q1 (250) trips the break and the two
        // roots are never reached.
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const p0 = await commitWith(ctx, treeId, 100, []);
        const p1 = await commitWith(ctx, treeId, 200, [p0]);
        const p2 = await commitWith(ctx, treeId, 300, [p1]);
        const q0 = await commitWith(ctx, treeId, 150, []);
        const q1 = await commitWith(ctx, treeId, 250, [q0]);
        const q2 = await commitWith(ctx, treeId, 350, [q1]);
        const d = await commitWith(ctx, treeId, 1000, [p2, q2]);
        const e = await commitWith(ctx, treeId, 1001, [q2, p2]);
        await writeCommitGraph(ctx, [await asCommits(ctx, [p0, p1, p2, q0, q1, q2, d, e])]);
        const consult = vi.spyOn(readCommitMetaModule, 'readCommitMeta');

        // Act
        const result = await mergeBase(ctx, [d, e], { all: true });

        // Assert
        expect(result).toEqual([p2, q2].sort());
        expect(consultedIds(consult)).toEqual(new Set([d, e, p1, p2, q1, q2]));
      });
    });
  });

  describe('Given an octopus accumulator holding an ancestor far below the other candidate', () => {
    describe('When mergeBase({ octopus: true, all: true }) reduces it under a full graph', () => {
      it('Then the reduction floor is the LOWEST candidate generation, so the ancestor is dropped', async () => {
        // Arrange — a←m←c and a←b, so folding [d, e, c] leaves the
        // accumulator {a, c} with a (generation 100) an ancestor of c
        // (generation 300). Only a floor taken as the MINIMUM of the two lets
        // the reduction walk descend from c to a and mark it redundant; a
        // floor of 300 would break at m and keep the ancestor.
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const a = await commitWith(ctx, treeId, 100, []);
        const m = await commitWith(ctx, treeId, 200, [a]);
        const c = await commitWith(ctx, treeId, 300, [m]);
        const b = await commitWith(ctx, treeId, 400, [a]);
        const d = await commitWith(ctx, treeId, 500, [b, c]);
        const e = await commitWith(ctx, treeId, 600, [c, b]);
        await writeCommitGraph(ctx, [await asCommits(ctx, [a, m, c, b, d, e])]);

        // Act
        const result = await mergeBase(ctx, [d, e, c], { octopus: true, all: true });

        // Assert
        expect(result).toEqual([c]);
      });
    });
  });

  describe('Given a criss-cross whose older base outranks the newer one by generation', () => {
    // R@100 ← P@1000 ← B1@100 and R ← B2@500, merged both ways. B1's corrected
    // commit date is 1001 (it inherits P's), so a graph pops B1 first while a
    // bare date walk pops B2 first — measured against git 2.55.0, which answers
    // B2 with no commit-graph and B1 once `git commit-graph write --reachable`
    // has run.
    const buildGenerationSkewedCrissCross = async (
      ctx: Context,
    ): Promise<{ b1: ObjectId; b2: ObjectId; d: ObjectId; e: ObjectId; all: ObjectId[] }> => {
      const treeId = await emptyTree(ctx);
      const r = await commitWith(ctx, treeId, 100, []);
      const p = await commitWith(ctx, treeId, 1000, [r]);
      const b1 = await commitNamed(ctx, treeId, 100, [p], 'b1');
      const b2 = await commitNamed(ctx, treeId, 500, [r], 'b2');
      const d = await commitNamed(ctx, treeId, 2000, [b1, b2], 'd');
      const e = await commitNamed(ctx, treeId, 2000, [b2, b1], 'e');
      return { b1, b2, d, e, all: [r, p, b1, b2, d, e] };
    };

    describe('When mergeBase([D, E]) runs with no commit-graph', () => {
      it('Then the date-ordered walk pops the newer-dated base B2 first', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { b2, d, e } = await buildGenerationSkewedCrissCross(ctx);

        // Act
        const result = await mergeBase(ctx, [d, e]);

        // Assert
        expect(result).toEqual([b2]);
      });
    });

    describe('When mergeBase([D, E]) runs with a commit-graph covering every commit', () => {
      it('Then the generation-ordered walk stops at the FIRST base it pops, B1', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { b1, b2, d, e, all } = await buildGenerationSkewedCrissCross(ctx);
        await writeCommitGraph(ctx, [await asCommits(ctx, all)]);

        // Act
        const single = await mergeBase(ctx, [d, e]);
        const every = await mergeBase(ctx, [d, e], { all: true });

        // Assert
        expect(single).toEqual([b1]);
        expect(every).toEqual([b1, b2].sort());
      });
    });
  });

  describe('Given three same-second commits where only one is common to both tips', () => {
    // X, Y and W all share one committer second; A merges [X, Y] and Z merges
    // [W, Y], so {X, Y} are both bases. git orders the RESULT list by the order
    // the walk POPS bases, and Y pops before X — measured against git 2.55.0,
    // which answers Y with and without a commit-graph.
    const buildSameSecondSplit = async (
      ctx: Context,
    ): Promise<{ x: ObjectId; y: ObjectId; a: ObjectId; z: ObjectId; all: ObjectId[] }> => {
      const treeId = await emptyTree(ctx);
      const x = await commitNamed(ctx, treeId, 1000, [], 'x');
      const y = await commitNamed(ctx, treeId, 1000, [], 'y');
      const w = await commitNamed(ctx, treeId, 1000, [x], 'w');
      const a = await commitNamed(ctx, treeId, 1001, [x, y], 'a');
      const z = await commitNamed(ctx, treeId, 1001, [w, y], 'z');
      return { x, y, a, z, all: [x, y, w, a, z] };
    };

    describe('When mergeBase([A, Z]) runs with no commit-graph', () => {
      it('Then the base popped first wins, not the one discovered first', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { x, y, a, z } = await buildSameSecondSplit(ctx);

        // Act
        const result = await mergeBase(ctx, [a, z]);

        // Assert
        expect(result).toEqual([y]);
        expect(result).not.toContain(x);
      });
    });

    describe('When mergeBase([A, Z]) runs with a commit-graph covering every commit', () => {
      it('Then the same base wins, and { all: true } still reports both', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { x, y, a, z, all } = await buildSameSecondSplit(ctx);
        await writeCommitGraph(ctx, [await asCommits(ctx, all)]);

        // Act
        const single = await mergeBase(ctx, [a, z]);
        const every = await mergeBase(ctx, [a, z], { all: true });

        // Assert
        expect(single).toEqual([y]);
        expect(every).toEqual([x, y].sort());
      });
    });
  });

  describe('Given a criss-cross whose two bases share both generation and committer second', () => {
    // The only thing left to separate B and C is the order the walk queued
    // them, which follows the merge's own parent order — measured against git
    // 2.55.0: `merge-base d e` is c and `merge-base e d` is b, with and
    // without a commit-graph.
    const buildParentOrderTie = async (
      ctx: Context,
    ): Promise<{ b: ObjectId; c: ObjectId; d: ObjectId; e: ObjectId; all: ObjectId[] }> => {
      const treeId = await emptyTree(ctx);
      const a = await commitWith(ctx, treeId, 500, []);
      const b = await commitNamed(ctx, treeId, 1000, [a], 'b');
      const c = await commitNamed(ctx, treeId, 1000, [a], 'c');
      const d = await commitNamed(ctx, treeId, 2000, [c, b], 'd');
      const e = await commitNamed(ctx, treeId, 2000, [b, c], 'e');
      return { b, c, d, e, all: [a, b, c, d, e] };
    };

    describe('When mergeBase runs in both argument orders with no commit-graph', () => {
      it('Then each order answers with its own first-queued parent', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { b, c, d, e } = await buildParentOrderTie(ctx);

        // Act
        const forward = await mergeBase(ctx, [d, e]);
        const reversed = await mergeBase(ctx, [e, d]);

        // Assert
        expect(forward).toEqual([c]);
        expect(reversed).toEqual([b]);
      });
    });

    describe('When mergeBase runs in both argument orders with a full commit-graph', () => {
      it('Then the generation tie falls through to the same discovery order', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { b, c, d, e, all } = await buildParentOrderTie(ctx);
        await writeCommitGraph(ctx, [await asCommits(ctx, all)]);

        // Act
        const forward = await mergeBase(ctx, [d, e]);
        const reversed = await mergeBase(ctx, [e, d]);

        // Assert
        expect(forward).toEqual([c]);
        expect(reversed).toEqual([b]);
      });
    });
  });

  describe('Given a linear no-graph history where the tip and one ancestor are compared', () => {
    describe('When mergeBase([X, Y]) runs', () => {
      it('Then the newest-first walk stops at the base and never consults below it', async () => {
        // Arrange — W←Z←Y←M←X, dated 600..1000. Y is an ancestor of X, so Y is
        // the base; the walk pops newest-first, reaches Y, marks Z stale and
        // stops, so W is never consulted. Popping oldest-first instead would
        // descend straight past Z into W.
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const w = await commitWith(ctx, treeId, 600, []);
        const z = await commitWith(ctx, treeId, 700, [w]);
        const y = await commitWith(ctx, treeId, 800, [z]);
        const m = await commitWith(ctx, treeId, 900, [y]);
        const x = await commitWith(ctx, treeId, 1000, [m]);
        const consult = vi.spyOn(readCommitMetaModule, 'readCommitMeta');

        // Act
        const result = await mergeBase(ctx, [x, y]);

        // Assert
        expect(result).toEqual([y]);
        expect(consultedIds(consult)).toEqual(new Set([x, m, y, z]));
      });
    });
  });

  describe('Given a redundant base with a newer committer date than the base that dominates it', () => {
    // C0@50 <- C@300 <- X@150 <- R@200, plus an independent root K@250; d and e
    // both merge [R, C] (opposite parent order). C is an ancestor of R, so the
    // reduced base is R alone — but C's committer date (300) is newer than R's
    // (200), so a date-ordered discovery walk records C first and only the
    // reduction drops it. Measured against git 2.55.0: no graph -> `merge-base`
    // R, `--all` R; a `generationVersion=1` graph -> C, R; a full (GDA2) graph
    // -> R, R.
    const buildSkewedRedundantBase = async (
      ctx: Context,
    ): Promise<{ c: ObjectId; r: ObjectId; d: ObjectId; e: ObjectId; all: ObjectId[] }> => {
      const treeId = await emptyTree(ctx);
      const c0 = await commitNamed(ctx, treeId, 50, [], 'c0');
      const c = await commitNamed(ctx, treeId, 300, [c0], 'c');
      const x = await commitNamed(ctx, treeId, 150, [c], 'x');
      const r = await commitNamed(ctx, treeId, 200, [x], 'r');
      const k = await commitNamed(ctx, treeId, 250, [], 'k');
      const d = await commitNamed(ctx, treeId, 2000, [r, c], 'd');
      const e = await commitNamed(ctx, treeId, 2000, [c, r], 'e');
      return { c, r, d, e, all: [c0, c, x, r, k, d, e] };
    };

    describe('When the history carries no commit-graph', () => {
      it('Then the reduction still drops the redundant base — plain and all answer R', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { r, d, e } = await buildSkewedRedundantBase(ctx);

        // Act
        const plain = await mergeBase(ctx, [d, e]);
        const every = await mergeBase(ctx, [d, e], { all: true });

        // Assert
        expect(plain).toEqual([r]);
        expect(every).toEqual([r]);
      });
    });

    describe('When a generationVersion=1 graph forces the date-only discovery walk', () => {
      it('Then plain answers the redundant newest base C git prints, and all still reduces to R', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { c, r, d, e, all } = await buildSkewedRedundantBase(ctx);
        await writeCommitGraph(ctx, [await asCommits(ctx, all)]);
        const topoLevels = vi
          .spyOn(readCommitGraphModule, 'correctedCommitDatesEnabled')
          .mockResolvedValue(false);

        // Act
        const plain = await mergeBase(ctx, [d, e]);
        const every = await mergeBase(ctx, [d, e], { all: true });

        // Assert
        expect(plain).toEqual([c]);
        expect(every).toEqual([r]);
        topoLevels.mockRestore();
      });
    });

    describe('When a full commit-graph serves corrected commit dates', () => {
      it('Then the generation walk reaches R first — plain and all answer R', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { r, d, e, all } = await buildSkewedRedundantBase(ctx);
        await writeCommitGraph(ctx, [await asCommits(ctx, all)]);

        // Act
        const plain = await mergeBase(ctx, [d, e]);
        const every = await mergeBase(ctx, [d, e], { all: true });

        // Assert
        expect(plain).toEqual([r]);
        expect(every).toEqual([r]);
      });
    });
  });

  describe('Given two bases whose generation order and committer-date order disagree', () => {
    // KP@999 ← Q@10 gives Q a corrected commit date of 1000, above the
    // independent root P@900 — so the generation walk pops Q first while the
    // date-sorted base list still leads with P. Measured against git 2.55.0
    // under `git commit-graph write --reachable`: `merge-base d e` is Q but
    // `merge-base --octopus d e` is P.
    const buildGenerationVersusDate = async (
      ctx: Context,
    ): Promise<{ p: ObjectId; q: ObjectId; d: ObjectId; e: ObjectId; all: ObjectId[] }> => {
      const treeId = await emptyTree(ctx);
      const kp = await commitWith(ctx, treeId, 999, []);
      const q = await commitNamed(ctx, treeId, 10, [kp], 'q');
      const p = await commitNamed(ctx, treeId, 900, [], 'p');
      const d = await commitNamed(ctx, treeId, 2000, [p, q], 'd');
      const e = await commitNamed(ctx, treeId, 2000, [q, p], 'e');
      return { p, q, d, e, all: [kp, q, p, d, e] };
    };

    describe('When mergeBase runs plain and under octopus with a full commit-graph', () => {
      it('Then plain answers the first base POPPED and octopus the first base by DATE', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { p, q, d, e, all } = await buildGenerationVersusDate(ctx);
        await writeCommitGraph(ctx, [await asCommits(ctx, all)]);

        // Act
        const plain = await mergeBase(ctx, [d, e]);
        const octopus = await mergeBase(ctx, [d, e], { octopus: true });
        const every = await mergeBase(ctx, [d, e], { all: true });

        // Assert
        expect(plain).toEqual([q]);
        expect(octopus).toEqual([p]);
        expect(every).toEqual([p, q].sort());
      });
    });

    describe('When the graph covers every commit but serves topological levels', () => {
      it('Then the discovery walk swaps in the date-only comparator and pops P first', async () => {
        // Arrange — one `commitGraph.generationVersion=1` layer anywhere in a
        // chain demotes the whole chain to topological levels, and git then
        // orders the discovery walk by committer date alone. The graph still
        // serves Q the generation (1000) that outranks P's (900), so a walk
        // that kept its generation comparator would answer Q instead.
        const ctx = await buildSeededContext();
        const { p, q, d, e, all } = await buildGenerationVersusDate(ctx);
        await writeCommitGraph(ctx, [await asCommits(ctx, all)]);
        const topoLevels = vi
          .spyOn(readCommitGraphModule, 'correctedCommitDatesEnabled')
          .mockResolvedValue(false);

        // Act
        const plain = await mergeBase(ctx, [d, e]);
        const every = await mergeBase(ctx, [d, e], { all: true });

        // Assert
        expect(plain).toEqual([p]);
        expect(every).toEqual([p, q].sort());
        topoLevels.mockRestore();
      });
    });

    describe('When the same history carries no commit-graph', () => {
      it('Then both plain and octopus answer the newest-dated base P', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { p, d, e } = await buildGenerationVersusDate(ctx);

        // Act
        const plain = await mergeBase(ctx, [d, e]);
        const octopus = await mergeBase(ctx, [d, e], { octopus: true });

        // Assert
        expect(plain).toEqual([p]);
        expect(octopus).toEqual([p]);
      });
    });
  });
});

describe('mergeBase cancellation on the graph path', () => {
  describe('Given a commit-graph covering the history and a signal aborted after the first commit is read', () => {
    it('Then the paint stops at its next per-commit checkpoint instead of completing from the graph', async () => {
      // Arrange — with a graph the paint reads no object bytes, so makeReadCommit's
      // own signal check is the only cancellation point; the abort lands as the
      // first commit's metadata resolves, and the second read must refuse.
      const ctx = await buildSeededContext();
      const { a, b, c, d, e } = await buildCrissCross(ctx);
      await writeCommitGraph(ctx, [await asCommits(ctx, [a, b, c, d, e])]);
      const controller = new AbortController();
      const original = readCommitMetaModule.readCommitMeta;
      const metaSpy = vi
        .spyOn(readCommitMetaModule, 'readCommitMeta')
        .mockImplementation(async (innerCtx, id) => {
          const meta = await original(innerCtx, id);
          controller.abort();
          return meta;
        });
      const sut = mergeBase;

      // Act
      let caught: unknown;
      try {
        await sut({ ...ctx, signal: controller.signal }, [d, e]);
        expect.unreachable();
      } catch (error) {
        caught = error;
      }

      // Assert
      expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
      expect(metaSpy).toHaveBeenCalledTimes(1);
      metaSpy.mockRestore();
    });
  });
});
