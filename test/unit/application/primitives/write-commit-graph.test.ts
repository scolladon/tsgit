import { describe, expect, it } from 'vitest';

import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import {
  commitGraphPath,
  commonGitDir,
  reflogPath,
} from '../../../../src/application/primitives/path-layout.js';
import { writeCommitGraph } from '../../../../src/application/primitives/write-commit-graph.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { parseCommitGraphLayer, positionOf } from '../../../../src/domain/commit/commit-graph.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type {
  AuthorIdentity,
  ObjectId,
  RefName,
  Tree,
} from '../../../../src/domain/objects/index.js';
import { zeroOid } from '../../../../src/domain/objects/index.js';
import { serializeReflogLine } from '../../../../src/domain/reflog/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from './fixtures.js';

const AUTHOR: AuthorIdentity = {
  name: 'Alice',
  email: 'a@a.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

async function emptyTree(ctx: Context): Promise<ObjectId> {
  const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
  return writeObject(ctx, tree);
}

async function rootCommit(ctx: Context, ts: number, message: string): Promise<ObjectId> {
  const tree = await emptyTree(ctx);
  return createCommit(ctx, {
    tree,
    parents: [],
    author: { ...AUTHOR, timestamp: ts },
    committer: { ...AUTHOR, timestamp: ts },
    message,
  });
}

async function pointRef(ctx: Context, name: string, id: ObjectId): Promise<void> {
  await ctx.fs.writeUtf8(`${commonGitDir(ctx)}/${name}`, `${id}\n`);
}

describe('writeCommitGraph', () => {
  describe('Given an existing commit-graph.lock', () => {
    describe('When writeCommitGraph is called', () => {
      it('Then the write refuses and the existing graph is untouched', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const gitDir = commonGitDir(ctx);
        const existing = new TextEncoder().encode('not a real graph');
        await ctx.fs.write(commitGraphPath(gitDir), existing);
        await ctx.fs.write(`${commitGraphPath(gitDir)}.lock`, new Uint8Array([0]));

        // Act
        let caught: unknown;
        try {
          await writeCommitGraph(ctx);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('RESOURCE_LOCKED');
        expect(await ctx.fs.read(commitGraphPath(gitDir))).toEqual(existing);
      });
    });
  });

  describe('Given a repository with a commit reachable from a branch ref', () => {
    describe('When writeCommitGraph succeeds', () => {
      it('Then the lock is released and the file is at objects/info/commit-graph', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const commitId = await rootCommit(ctx, AUTHOR.timestamp, 'root');
        await pointRef(ctx, 'refs/heads/main', commitId);
        const gitDir = commonGitDir(ctx);

        // Act
        const result = await writeCommitGraph(ctx);

        // Assert
        expect(result.commitCount).toBe(1);
        expect(await ctx.fs.exists(commitGraphPath(gitDir))).toBe(true);
        expect(await ctx.fs.exists(`${commitGraphPath(gitDir)}.lock`)).toBe(false);
        const layer = parseCommitGraphLayer(await ctx.fs.read(commitGraphPath(gitDir)));
        expect(layer.commitCount).toBe(1);
        expect(positionOf(layer, commitId)).not.toBeUndefined();
      });
    });
  });

  describe('Given a repository with a commit reachable only from a reflog', () => {
    describe('When writeCommitGraph runs', () => {
      it('Then it is absent from the graph', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const gitDir = commonGitDir(ctx);
        const reachableId = await rootCommit(ctx, AUTHOR.timestamp, 'reachable');
        const reflogOnlyId = await rootCommit(ctx, AUTHOR.timestamp + 1, 'reflog-only');
        await pointRef(ctx, 'refs/heads/main', reachableId);
        const reflogLine = serializeReflogLine(
          {
            oldId: zeroOid(ctx.hashConfig),
            newId: reflogOnlyId,
            identity: AUTHOR,
            message: 'branch: Created from HEAD',
          },
          ctx.hashConfig.hexLength,
        );
        await ctx.fs.writeUtf8(reflogPath(gitDir, 'refs/heads/gone' as RefName), reflogLine);

        // Act
        await writeCommitGraph(ctx);

        // Assert
        const layer = parseCommitGraphLayer(await ctx.fs.read(commitGraphPath(gitDir)));
        expect(layer.commitCount).toBe(1);
        expect(positionOf(layer, reachableId)).not.toBeUndefined();
        expect(positionOf(layer, reflogOnlyId)).toBeUndefined();
      });
    });
  });

  describe('Given a corrupt existing commit-graph', () => {
    describe('When writeCommitGraph runs', () => {
      it('Then it reads commit objects, not the graph, and succeeds', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const gitDir = commonGitDir(ctx);
        const commitId = await rootCommit(ctx, AUTHOR.timestamp, 'root');
        await pointRef(ctx, 'refs/heads/main', commitId);
        await ctx.fs.write(commitGraphPath(gitDir), new TextEncoder().encode('garbage, not CGPH'));

        // Act
        const result = await writeCommitGraph(ctx);

        // Assert
        expect(result.commitCount).toBe(1);
        const layer = parseCommitGraphLayer(await ctx.fs.read(commitGraphPath(gitDir)));
        expect(layer.commitCount).toBe(1);
        expect(positionOf(layer, commitId)).not.toBeUndefined();
      });
    });
  });
});
