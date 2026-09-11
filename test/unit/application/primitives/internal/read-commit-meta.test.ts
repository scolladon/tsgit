import { describe, expect, it } from 'vitest';
import { createCommit } from '../../../../../src/application/primitives/create-commit.js';
import {
  commitMetaOf,
  GENERATION_INFINITY,
  readCommitMeta,
} from '../../../../../src/application/primitives/internal/read-commit-meta.js';
import { readObject } from '../../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import type {
  AuthorIdentity,
  Commit,
  ObjectId,
  Tree,
} from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildSeededContext, instrumentedContext, writeCommitGraph } from '../fixtures.js';

const AUTHOR: AuthorIdentity = {
  name: 'Alice',
  email: 'a@a.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const OBJECT_STORE_READ = /\/objects\/(pack\/|[0-9a-f]{2}\/)/;

const objectStoreReadPaths = (
  calls: ReadonlyArray<{ readonly method: string; readonly path: string }>,
): ReadonlyArray<string> =>
  calls
    .filter((call) => call.method === 'read' && OBJECT_STORE_READ.test(call.path))
    .map((c) => c.path);

const emptyTree = async (ctx: Context): Promise<ObjectId> => {
  const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
  return writeObject(ctx, tree);
};

const commitAt = async (
  ctx: Context,
  treeId: ObjectId,
  timestamp: number,
  parents: ObjectId[],
): Promise<ObjectId> =>
  createCommit(ctx, {
    tree: treeId,
    parents,
    author: { ...AUTHOR, timestamp },
    committer: { ...AUTHOR, timestamp },
    message: `c@${timestamp}`,
  });

const asCommits = async (ctx: Context, ids: ReadonlyArray<ObjectId>): Promise<Commit[]> => {
  const commits: Commit[] = [];
  for (const id of ids) {
    const object = await readObject(ctx, id);
    if (object.type !== 'commit') throw new Error('expected a commit');
    commits.push(object);
  }
  return commits;
};

describe('readCommitMeta', () => {
  describe('Given a commit-graph covering the commit', () => {
    describe('When readCommitMeta runs', () => {
      it('Then serves parents and committer date with no object-store read', async () => {
        // Arrange
        const base = await buildSeededContext();
        const treeId = await emptyTree(base);
        const root = await commitAt(base, treeId, 1_700_000_000, []);
        const tip = await commitAt(base, treeId, 1_700_000_100, [root]);
        await writeCommitGraph(base, [await asCommits(base, [root, tip])]);
        const { ctx, calls } = instrumentedContext(base);

        // Act
        const result = await readCommitMeta(ctx, tip);

        // Assert
        expect(result?.parents).toEqual([root]);
        expect(result?.committerDate).toBe(1_700_000_100);
        expect(objectStoreReadPaths(calls())).toEqual([]);
      });
    });
  });

  describe('Given a commit-graph entry whose stored generation is 0', () => {
    describe('When readCommitMeta runs', () => {
      it('Then generation maps to GENERATION_INFINITY', async () => {
        // Arrange — a committer date of 0 encodes to a stored graph generation of 0
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const root = await commitAt(ctx, treeId, 0, []);
        await writeCommitGraph(ctx, [await asCommits(ctx, [root])]);

        // Act
        const result = await readCommitMeta(ctx, root);

        // Assert
        expect(result?.generation).toBe(GENERATION_INFINITY);
      });
    });
  });

  describe('Given a commit-graph entry with a normal (non-zero) stored generation', () => {
    describe('When readCommitMeta runs', () => {
      it('Then generation is the finite graph value', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const root = await commitAt(ctx, treeId, 1_700_000_000, []);
        await writeCommitGraph(ctx, [await asCommits(ctx, [root])]);

        // Act
        const result = await readCommitMeta(ctx, root);

        // Assert
        expect(result?.generation).toBe(1_700_000_000);
      });
    });
  });

  describe('Given a shallow boundary commit (the graph is disabled)', () => {
    describe('When readCommitMeta runs on the boundary', () => {
      it('Then falls back to the object read and grafts its parents to empty', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const root = await commitAt(ctx, treeId, 100, []);
        const boundary = await commitAt(ctx, treeId, 101, [root]);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${boundary}\n`);

        // Act
        const result = await readCommitMeta(ctx, boundary);

        // Assert
        expect(result?.parents).toEqual([]);
        expect(result?.generation).toBe(GENERATION_INFINITY);
      });
    });
  });

  describe('Given a non-commit object id', () => {
    describe('When readCommitMeta runs', () => {
      it('Then returns undefined', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: new Uint8Array([0x68, 0x69]),
        });

        // Act
        const result = await readCommitMeta(ctx, blobId);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a missing object id', () => {
    describe('When readCommitMeta runs', () => {
      it('Then propagates OBJECT_NOT_FOUND', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const missing = 'f'.repeat(40) as ObjectId;

        // Act
        let caught: unknown;
        try {
          await readCommitMeta(ctx, missing);
          expect.fail('should have thrown');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const tErr = caught as TsgitError;
        expect(tErr.data.code).toBe('OBJECT_NOT_FOUND');
        expect(tErr.data.code === 'OBJECT_NOT_FOUND' && tErr.data.id).toBe(missing);
      });
    });
  });
});

describe('commitMetaOf', () => {
  describe('Given a commit already in hand and a commit-graph covering it', () => {
    describe('When commitMetaOf runs', () => {
      it('Then reads no objects and returns the finite graph generation', async () => {
        // Arrange
        const base = await buildSeededContext();
        const treeId = await emptyTree(base);
        const root = await commitAt(base, treeId, 1_700_000_000, []);
        await writeCommitGraph(base, [await asCommits(base, [root])]);
        const [commit] = await asCommits(base, [root]);
        const { ctx, calls } = instrumentedContext(base);

        // Act
        const result = await commitMetaOf(ctx, commit!);

        // Assert
        expect(result.generation).toBe(1_700_000_000);
        expect(objectStoreReadPaths(calls())).toEqual([]);
      });
    });
  });

  describe('Given a commit already in hand with no commit-graph covering it', () => {
    describe('When commitMetaOf runs', () => {
      it('Then reads no objects and returns GENERATION_INFINITY', async () => {
        // Arrange
        const base = await buildSeededContext();
        const treeId = await emptyTree(base);
        const root = await commitAt(base, treeId, 1_700_000_000, []);
        const [commit] = await asCommits(base, [root]);
        const { ctx, calls } = instrumentedContext(base);

        // Act
        const result = await commitMetaOf(ctx, commit!);

        // Assert
        expect(result.generation).toBe(GENERATION_INFINITY);
        expect(objectStoreReadPaths(calls())).toEqual([]);
      });
    });
  });
});
