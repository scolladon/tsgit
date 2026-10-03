import { describe, expect, it } from 'vitest';

import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import {
  commitGraphChainPath,
  commitGraphLayerPath,
  commitGraphLayersDir,
  commitGraphPath,
  commonGitDir,
  reflogPath,
  shallowFilePath,
} from '../../../../src/application/primitives/path-layout.js';
import { writeCommitGraph } from '../../../../src/application/primitives/write-commit-graph.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeSplitCommitGraph } from '../../../../src/application/primitives/write-split-commit-graph.js';
import { parseCommitGraphLayer, positionOf } from '../../../../src/domain/commit/commit-graph.js';
import { notADirectory, permissionDenied, TsgitError } from '../../../../src/domain/error.js';
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

const LAYER_HASH = 'b'.repeat(40);

async function seedChain(
  ctx: Context,
): Promise<{ readonly layer: string; readonly other: string }> {
  const gitDir = commonGitDir(ctx);
  const layer = commitGraphLayerPath(gitDir, LAYER_HASH);
  const other = `${commitGraphLayersDir(gitDir)}/notes.txt`;
  await ctx.fs.writeUtf8(commitGraphChainPath(gitDir), `${LAYER_HASH}\n`);
  await ctx.fs.writeUtf8(layer, 'layer');
  await ctx.fs.writeUtf8(other, 'kept');
  return { layer, other };
}

const denyingRm = (ctx: Context, denied: string): Context => ({
  ...ctx,
  fs: {
    ...ctx.fs,
    rm: (path: string) =>
      path === denied ? Promise.reject(permissionDenied(path)) : ctx.fs.rm(path),
  },
});

const failingReaddir = (ctx: Context, failing: string, fault: TsgitError): Context => ({
  ...ctx,
  fs: {
    ...ctx.fs,
    readdir: (path: string) => (path === failing ? Promise.reject(fault) : ctx.fs.readdir(path)),
  },
});

describe('writeCommitGraph', () => {
  describe('Given an existing split chain beside a reachable commit', () => {
    describe('When writeCommitGraph runs', () => {
      it('Then the chain manifest and every .graph layer are removed, other files kept', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await pointRef(ctx, 'refs/heads/main', await rootCommit(ctx, 1_700_000_000, 'c'));
        const { layer, other } = await seedChain(ctx);
        const sut = writeCommitGraph;

        // Act
        await sut(ctx);

        // Assert
        expect(await ctx.fs.exists(commitGraphChainPath(commonGitDir(ctx)))).toBe(false);
        expect(await ctx.fs.exists(layer)).toBe(false);
        expect(await ctx.fs.exists(other)).toBe(true);
      });
    });
  });

  describe('Given a chain layer whose removal is refused', () => {
    describe('When writeCommitGraph runs', () => {
      it('Then the refusal propagates', async () => {
        // Arrange
        const base = await buildSeededContext();
        await pointRef(base, 'refs/heads/main', await rootCommit(base, 1_700_000_000, 'c'));
        const { layer } = await seedChain(base);
        const ctx = denyingRm(base, layer);
        const sut = writeCommitGraph;

        // Act
        let caught: unknown;
        try {
          await sut(ctx);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual(permissionDenied(layer).data);
      });
    });
  });

  describe('Given a layers directory whose listing is refused', () => {
    describe('When writeCommitGraph runs', () => {
      it('Then the refusal propagates', async () => {
        // Arrange
        const base = await buildSeededContext();
        await pointRef(base, 'refs/heads/main', await rootCommit(base, 1_700_000_000, 'c'));
        await seedChain(base);
        const layersDir = commitGraphLayersDir(commonGitDir(base));
        const ctx = failingReaddir(base, layersDir, permissionDenied(layersDir));
        const sut = writeCommitGraph;

        // Act
        let caught: unknown;
        try {
          await sut(ctx);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual(permissionDenied(layersDir).data);
      });
    });
  });

  describe('Given a layers directory that lists as not a directory', () => {
    describe('When writeCommitGraph runs', () => {
      it('Then the graph is still written', async () => {
        // Arrange
        const base = await buildSeededContext();
        await pointRef(base, 'refs/heads/main', await rootCommit(base, 1_700_000_000, 'c'));
        const layersDir = commitGraphLayersDir(commonGitDir(base));
        const ctx = failingReaddir(base, layersDir, notADirectory(layersDir));
        const sut = writeCommitGraph;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.commitCount).toBe(1);
        expect(await ctx.fs.exists(commitGraphPath(commonGitDir(ctx)))).toBe(true);
      });
    });
  });

  describe('Given a repository with no commits', () => {
    describe('When writeCommitGraph runs', () => {
      it('Then no file is written — pinned against git 2.55.0', async () => {
        // Arrange — `git commit-graph write --reachable` on an empty
        // repository exits 0 and writes NO `objects/info/commit-graph`.
        const ctx = await buildSeededContext();
        const gitDir = commonGitDir(ctx);

        // Act
        const result = await writeCommitGraph(ctx);

        // Assert
        expect(result.commitCount).toBe(0);
        expect(await ctx.fs.exists(commitGraphPath(gitDir))).toBe(false);
      });
    });
  });

  describe('Given a shallow repository with a reachable commit', () => {
    describe('When writeCommitGraph runs', () => {
      it('Then no file is written — pinned against git 2.55.0', async () => {
        // Arrange — `git commit-graph write --reachable` on a shallow
        // clone exits 0 and writes NO `objects/info/commit-graph`: a
        // shallow boundary makes the generation-number invariant unsound.
        const ctx = await buildSeededContext();
        const gitDir = commonGitDir(ctx);
        const commitId = await rootCommit(ctx, AUTHOR.timestamp, 'root');
        await pointRef(ctx, 'refs/heads/main', commitId);
        await ctx.fs.writeUtf8(shallowFilePath(gitDir), `${commitId}\n`);

        // Act
        const result = await writeCommitGraph(ctx);

        // Assert
        expect(result.commitCount).toBe(0);
        expect(await ctx.fs.exists(commitGraphPath(gitDir))).toBe(false);
      });
    });
  });

  describe('Given an existing commit-graph.lock', () => {
    describe('When writeCommitGraph is called', () => {
      it('Then the write refuses and the existing graph is untouched', async () => {
        // Arrange — a reachable commit, so the write actually reaches the
        // lock acquisition rather than short-circuiting on an empty commit
        // set (see "Given a repository with no commits" above).
        const ctx = await buildSeededContext();
        const commitId = await rootCommit(ctx, AUTHOR.timestamp, 'root');
        await pointRef(ctx, 'refs/heads/main', commitId);
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

      it('Then the trailing hash is a real digest of everything before it, not the all-zero placeholder', async () => {
        // Arrange — `serializeCommitGraph` leaves the trailer zero-filled;
        // filling in the real digest is this module's own job.
        const ctx = await buildSeededContext();
        const commitId = await rootCommit(ctx, AUTHOR.timestamp, 'root');
        await pointRef(ctx, 'refs/heads/main', commitId);
        const gitDir = commonGitDir(ctx);

        // Act
        await writeCommitGraph(ctx);

        // Assert
        const bytes = await ctx.fs.read(commitGraphPath(gitDir));
        const trailerStart = bytes.length - ctx.hashConfig.digestLength;
        const trailer = bytes.subarray(trailerStart);
        const expectedDigest = await ctx.hash.hash(bytes.subarray(0, trailerStart));
        expect(trailer).toEqual(expectedDigest);
        expect(trailer).not.toEqual(new Uint8Array(ctx.hashConfig.digestLength));
      });
    });
  });

  describe('Given a ref pointing at an annotated tag over a reachable commit', () => {
    describe('When writeCommitGraph runs', () => {
      it('Then the peeled commit is in the graph — matching --reachable, which follows tags through', async () => {
        // Arrange — `resolveRef` is called with `{ peel: true }`: the root
        // set is the TAG's target commit, never the (non-commit) tag object
        // itself.
        const ctx = await buildSeededContext();
        const gitDir = commonGitDir(ctx);
        const commitId = await rootCommit(ctx, AUTHOR.timestamp, 'tagged');
        const tagId = await writeObject(ctx, {
          type: 'tag',
          id: '' as ObjectId,
          data: {
            object: commitId,
            objectType: 'commit',
            tagName: 'v1',
            message: 'release',
            extraHeaders: [],
          },
        });
        await pointRef(ctx, 'refs/tags/v1', tagId);

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

  describe('Given a chain whose top layer carries changed-path filters', () => {
    describe('When the single-file graph is written', () => {
      it("Then it carries filters at the top layer's settings", async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await createCommit(ctx, {
          tree: await writeObject(ctx, { type: 'tree', entries: [], id: '' as ObjectId }),
          parents: [],
          author: AUTHOR,
          committer: AUTHOR,
          message: 'root',
        });
        await ctx.fs.writeUtf8(`${commonGitDir(ctx)}/refs/heads/main`, `${id}\n`);
        const config = `${commonGitDir(ctx)}/config`;
        await ctx.fs.appendUtf8(
          config,
          '[commitGraph]\n\tchangedPaths\n\tchangedPathsVersion = 2\n',
        );
        await writeSplitCommitGraph(ctx);
        await ctx.fs.appendUtf8(config, '\tchangedPathsVersion = -1\n');
        const sut = writeCommitGraph;

        // Act
        await sut(ctx);

        // Assert
        const layer = parseCommitGraphLayer(await ctx.fs.read(commitGraphPath(commonGitDir(ctx))));
        expect(layer.bloomSettings).toEqual({ hashVersion: 2, numHashes: 7, bitsPerEntry: 10 });
      });
    });
  });
});
