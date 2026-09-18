import { afterEach, describe, expect, it, vi } from 'vitest';

import { isAncestor } from '../../../../../src/application/commands/internal/is-ancestor.js';
import { createCommit } from '../../../../../src/application/primitives/create-commit.js';
import * as readCommitMetaModule from '../../../../../src/application/primitives/internal/read-commit-meta.js';
import { readObject } from '../../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type {
  AuthorIdentity,
  Commit,
  ObjectId,
  Tree,
} from '../../../../../src/domain/objects/index.js';
import { computeLooseObjectPath } from '../../../../../src/domain/storage/loose-path.js';
import type { Context } from '../../../../../src/ports/context.js';
import {
  buildSeededContext,
  instrumentedContext,
  writeCommitGraph,
} from '../../primitives/fixtures.js';

const OBJECT_STORE_READ = /\/objects\/(pack\/|[0-9a-f]{2}\/)/;

const BASE_TIMESTAMP = 1_700_000_000;

const AUTHOR: AuthorIdentity = {
  name: 'Alice',
  email: 'a@a.com',
  timestamp: BASE_TIMESTAMP,
  timezoneOffset: '+0000',
};

const objectStoreReads = (
  calls: ReadonlyArray<{ readonly method: string; readonly path: string }>,
): ReadonlyArray<string> =>
  calls
    .filter((call) => call.method === 'read' && OBJECT_STORE_READ.test(call.path))
    .map((call) => call.path);

const emptyTree = (ctx: Context): Promise<ObjectId> =>
  writeObject(ctx, { type: 'tree', entries: [], id: '' as ObjectId } satisfies Tree);

const commitWith = (
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

const buildLinear = async (ctx: Context, n: number): Promise<ObjectId[]> => {
  const treeId = await emptyTree(ctx);
  const ids: ObjectId[] = [];
  let parents: ObjectId[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = await commitWith(ctx, treeId, BASE_TIMESTAMP + i, parents);
    ids.push(id);
    parents = [id];
  }
  return ids;
};

/** A commit hanging off `chain[chain.length - 2]`, so it is a sibling of the
 *  tip and never reachable from it. `ts` chooses whether its generation lands
 *  above the tip's (git's no-walk answer) or level with it (the bounded paint). */
const buildSibling = async (ctx: Context, chain: ReadonlyArray<ObjectId>, ts: number) => {
  const treeId = await emptyTree(ctx);
  return commitWith(ctx, treeId, ts, [chain[chain.length - 2] as ObjectId]);
};

const commitObjects = async (ctx: Context, ids: ReadonlyArray<ObjectId>): Promise<Commit[]> => {
  const commits: Commit[] = [];
  for (const id of ids) {
    const object = await readObject(ctx, id);
    if (object.type !== 'commit') throw new Error('expected a commit');
    commits.push(object);
  }
  return commits;
};

const spyOnConsultedIds = () => {
  const spy = vi.spyOn(readCommitMetaModule, 'readCommitMeta');
  return () => new Set(spy.mock.calls.map(([, id]) => id));
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isAncestor', () => {
  describe('Given a linear history the commit-graph covers, When the candidate is a sibling of the tip', () => {
    it('Then answers false without reading one object byte', async () => {
      // Arrange
      const seeded = await buildSeededContext();
      const chain = await buildLinear(seeded, 10);
      const sibling = await buildSibling(seeded, chain, BASE_TIMESTAMP);
      await writeCommitGraph(seeded, [await commitObjects(seeded, [...chain, sibling])]);
      // The fixture's own commit reads warm the object cache; clear it so the
      // assertion below reflects the graph path, not leftover setup reads.
      seeded.deltaCache.clear();
      const { ctx, calls } = instrumentedContext(seeded);

      // Act
      const result = await isAncestor(ctx, sibling, chain[9] as ObjectId);

      // Assert
      expect(result).toBe(false);
      expect(objectStoreReads(calls())).toEqual([]);
    });

    it('Then consults only the commits at or above the candidate generation', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const chain = await buildLinear(ctx, 10);
      const sibling = await buildSibling(ctx, chain, BASE_TIMESTAMP);
      await writeCommitGraph(ctx, [await commitObjects(ctx, [...chain, sibling])]);
      const consultedIds = spyOnConsultedIds();

      // Act
      await isAncestor(ctx, sibling, chain[9] as ObjectId);

      // Assert
      expect(consultedIds()).toEqual(new Set([sibling, chain[9], chain[8]]));
    });
  });

  describe('Given a linear history the commit-graph covers, When the candidate outranks the tip generation', () => {
    it('Then answers false from the generations alone, consulting neither end’s ancestors', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const chain = await buildLinear(ctx, 10);
      const sibling = await buildSibling(ctx, chain, BASE_TIMESTAMP + 1000);
      await writeCommitGraph(ctx, [await commitObjects(ctx, [...chain, sibling])]);
      const consultedIds = spyOnConsultedIds();

      // Act
      const result = await isAncestor(ctx, sibling, chain[9] as ObjectId);

      // Assert
      expect(result).toBe(false);
      expect(consultedIds()).toEqual(new Set([sibling, chain[9]]));
    });
  });

  describe('Given a linear history the commit-graph covers, When the candidate is the tip’s parent', () => {
    it('Then answers true and stops one generation below the candidate', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const chain = await buildLinear(ctx, 10);
      await writeCommitGraph(ctx, [await commitObjects(ctx, chain)]);
      const consultedIds = spyOnConsultedIds();

      // Act
      const result = await isAncestor(ctx, chain[8] as ObjectId, chain[9] as ObjectId);

      // Assert
      expect(result).toBe(true);
      expect(consultedIds()).toEqual(new Set([chain[9], chain[8], chain[7]]));
    });
  });

  describe('Given a linear history the commit-graph covers, When the candidate is the tip itself', () => {
    it('Then answers true', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const chain = await buildLinear(ctx, 4);
      await writeCommitGraph(ctx, [await commitObjects(ctx, chain)]);

      // Act
      const result = await isAncestor(ctx, chain[3] as ObjectId, chain[3] as ObjectId);

      // Assert
      expect(result).toBe(true);
    });
  });

  describe('Given two histories with no commit in common', () => {
    it('Then answers false', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const chain = await buildLinear(ctx, 4);
      const treeId = await emptyTree(ctx);
      const orphan = await commitWith(ctx, treeId, BASE_TIMESTAMP - 100, []);
      await writeCommitGraph(ctx, [await commitObjects(ctx, [...chain, orphan])]);

      // Act
      const result = await isAncestor(ctx, orphan, chain[3] as ObjectId);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('Given a repository with no commit-graph', () => {
    it('Then answers true for an ancestor and false for a sibling', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const chain = await buildLinear(ctx, 6);
      const sibling = await buildSibling(ctx, chain, BASE_TIMESTAMP + 1000);

      // Act
      const reachable = await isAncestor(ctx, chain[0] as ObjectId, chain[5] as ObjectId);
      const unreachable = await isAncestor(ctx, sibling, chain[5] as ObjectId);

      // Assert
      expect(reachable).toBe(true);
      expect(unreachable).toBe(false);
    });
  });

  describe('Given a commit-graph left stale by commits written after it', () => {
    it('Then answers true downwards, false upwards and true for the uncovered commit itself', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const chain = await buildLinear(ctx, 4);
      await writeCommitGraph(ctx, [await commitObjects(ctx, chain.slice(0, 3))]);

      // Act
      const downwards = await isAncestor(ctx, chain[0] as ObjectId, chain[3] as ObjectId);
      const upwards = await isAncestor(ctx, chain[3] as ObjectId, chain[0] as ObjectId);
      const itself = await isAncestor(ctx, chain[3] as ObjectId, chain[3] as ObjectId);

      // Assert
      expect(downwards).toBe(true);
      expect(upwards).toBe(false);
      expect(itself).toBe(true);
    });
  });

  describe('Given a history cut off at a shallow boundary', () => {
    it('Then answers false below the boundary and true at it', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const chain = await buildLinear(ctx, 3);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${chain[1]}\n`);

      // Act
      const belowBoundary = await isAncestor(ctx, chain[0] as ObjectId, chain[2] as ObjectId);
      const atBoundary = await isAncestor(ctx, chain[1] as ObjectId, chain[2] as ObjectId);

      // Assert
      expect(belowBoundary).toBe(false);
      expect(atBoundary).toBe(true);
    });
  });

  describe('Given a candidate whose object is absent', () => {
    it('Then answers false instead of refusing', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const chain = await buildLinear(ctx, 3);
      const absent = '0000000000000000000000000000000000000001' as ObjectId;

      // Act
      const asCandidate = await isAncestor(ctx, absent, chain[2] as ObjectId);
      const asTip = await isAncestor(ctx, chain[0] as ObjectId, absent);

      // Assert
      expect(asCandidate).toBe(false);
      expect(asTip).toBe(false);
    });
  });

  describe('Given a history truncated by an absent commit part-way down', () => {
    it('Then answers false for anything below the gap and true for anything above it', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const chain = await buildLinear(ctx, 5);
      await ctx.fs.rmRecursive(
        `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(chain[2] as ObjectId)}`,
      );

      // Act
      const belowGap = await isAncestor(ctx, chain[0] as ObjectId, chain[4] as ObjectId);
      const aboveGap = await isAncestor(ctx, chain[3] as ObjectId, chain[4] as ObjectId);

      // Assert
      expect(belowGap).toBe(false);
      expect(aboveGap).toBe(true);
    });
  });
});
