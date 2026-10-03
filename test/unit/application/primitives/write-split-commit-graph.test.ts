import { describe, expect, it } from 'vitest';

import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import {
  commitGraphChainPath,
  commitGraphLayerPath,
  commitGraphLayersDir,
  commitGraphPath,
  commonGitDir,
  looseObjectPath,
  shallowFilePath,
} from '../../../../src/application/primitives/path-layout.js';
import { writeCommitGraph } from '../../../../src/application/primitives/write-commit-graph.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeSplitCommitGraph } from '../../../../src/application/primitives/write-split-commit-graph.js';
import { parseCommitGraphLayer, positionOf } from '../../../../src/domain/commit/commit-graph.js';
import { fileNotFound, permissionDenied, TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, Tree } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from './fixtures.js';

const AUTHOR: AuthorIdentity = {
  name: 'Alice',
  email: 'a@a.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const enc = new TextEncoder();

async function commitOn(
  ctx: Context,
  parents: readonly ObjectId[],
  message: string,
): Promise<ObjectId> {
  const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
  return createCommit(ctx, {
    tree: await writeObject(ctx, tree),
    parents,
    author: AUTHOR,
    committer: AUTHOR,
    message,
  });
}

async function linearHistory(ctx: Context, length: number): Promise<readonly ObjectId[]> {
  const ids: ObjectId[] = [];
  for (let i = 0; i < length; i += 1) ids.push(await commitOn(ctx, ids.slice(-1), `c${i}`));
  return ids;
}

async function pointRef(ctx: Context, name: string, id: string): Promise<void> {
  await ctx.fs.writeUtf8(`${commonGitDir(ctx)}/${name}`, `${id}\n`);
}

async function chainHashes(ctx: Context): Promise<readonly string[]> {
  const text = await ctx.fs.readUtf8(commitGraphChainPath(commonGitDir(ctx)));
  return text.split('\n').filter((line) => line.length > 0);
}

async function readLayer(ctx: Context, hash: string) {
  return parseCommitGraphLayer(await ctx.fs.read(commitGraphLayerPath(commonGitDir(ctx), hash)));
}

const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const withFs = (ctx: Context, overrides: Partial<Context['fs']>): Context => ({
  ...ctx,
  fs: { ...ctx.fs, ...overrides },
});

async function caughtFrom(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('writeSplitCommitGraph', () => {
  describe('Given a reachable history and no commit-graph', () => {
    describe('When the split write runs', () => {
      it('Then one base-less layer holds every commit and the chain names it alone', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await linearHistory(ctx, 2);
        await pointRef(ctx, 'refs/heads/main', ids[1]!);
        const sut = writeSplitCommitGraph;

        // Act
        const result = await sut(ctx);

        // Assert
        const [hash] = await chainHashes(ctx);
        const layer = await readLayer(ctx, hash!);
        expect(result).toEqual({ written: true, commitCount: 2 });
        expect(await chainHashes(ctx)).toHaveLength(1);
        expect(layer.numBaseGraphs).toBe(0);
        expect(layer.commitCount).toBe(2);
        expect(hexOf(layer._bytes.subarray(-20))).toBe(hash);
        expect(await ctx.fs.exists(commitGraphPath(commonGitDir(ctx)))).toBe(false);
      });
    });
  });

  describe('Given a single-file graph too large to merge and one new commit', () => {
    describe('When the split write runs', () => {
      it('Then the single file becomes the base layer under its trailing hash and the new layer names it', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const gitDir = commonGitDir(ctx);
        const ids = await linearHistory(ctx, 3);
        await pointRef(ctx, 'refs/heads/main', ids[2]!);
        await writeCommitGraph(ctx);
        const single = await ctx.fs.read(commitGraphPath(gitDir));
        await pointRef(ctx, 'refs/heads/next', await commitOn(ctx, [ids[2]!], 'next'));
        const sut = writeSplitCommitGraph;

        // Act
        const result = await sut(ctx);

        // Assert
        const [baseHash, tipHash] = await chainHashes(ctx);
        const tip = await readLayer(ctx, tipHash!);
        expect(result).toEqual({ written: true, commitCount: 4 });
        expect(baseHash).toBe(hexOf(single.subarray(-20)));
        expect(await ctx.fs.read(commitGraphLayerPath(gitDir, baseHash!))).toEqual(single);
        expect(await ctx.fs.exists(commitGraphPath(gitDir))).toBe(false);
        expect(tip.baseGraphHashes).toEqual([baseHash]);
        expect(tip.commitCount).toBe(1);
      });
    });
  });

  describe('Given a split layer small enough to merge and one new commit', () => {
    describe('When the split write runs', () => {
      it('Then both fold into one layer and the old layer file is expired', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const gitDir = commonGitDir(ctx);
        const ids = await linearHistory(ctx, 2);
        await pointRef(ctx, 'refs/heads/main', ids[1]!);
        await writeSplitCommitGraph(ctx);
        const [oldHash] = await chainHashes(ctx);
        const next = await commitOn(ctx, [ids[1]!], 'next');
        await pointRef(ctx, 'refs/heads/next', next);
        const sut = writeSplitCommitGraph;

        // Act
        const result = await sut(ctx);

        // Assert
        const hashes = await chainHashes(ctx);
        const layer = await readLayer(ctx, hashes[0]!);
        expect(result).toEqual({ written: true, commitCount: 3 });
        expect(hashes).toHaveLength(1);
        expect(layer.commitCount).toBe(3);
        expect(positionOf(layer, next)).toBeDefined();
        expect(await ctx.fs.exists(commitGraphLayerPath(gitDir, oldHash!))).toBe(false);
      });
    });
  });

  describe('Given a two-layer chain neither layer of which merges', () => {
    describe('When the split write adds a commit over the upper layer', () => {
      it('Then both stay as its base and its parent is named by its chain-global position', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await linearHistory(ctx, 16);
        await pointRef(ctx, 'refs/heads/main', ids[11]!);
        await writeSplitCommitGraph(ctx);
        await pointRef(ctx, 'refs/heads/main', ids[15]!);
        await writeSplitCommitGraph(ctx);
        const before = await chainHashes(ctx);
        await pointRef(ctx, 'refs/heads/next', await commitOn(ctx, [ids[14]!], 'next'));
        const sut = writeSplitCommitGraph;

        // Act
        const result = await sut(ctx);

        // Assert
        const hashes = await chainHashes(ctx);
        const tip = await readLayer(ctx, hashes[2]!);
        const parentPosition = tip._view.getUint32(tip._commitDataOffset + 20);
        expect(result).toEqual({ written: true, commitCount: 17 });
        expect(hashes.slice(0, 2)).toEqual(before);
        expect(tip.baseGraphHashes).toEqual(before);
        expect(parentPosition).toBe(12 + positionOf(await readLayer(ctx, before[1]!), ids[14]!)!);
      });
    });
  });

  describe('Given a folded layer whose commit object read is refused', () => {
    describe('When the split write folds that layer', () => {
      it('Then the refusal propagates', async () => {
        // Arrange
        const origin = await buildSeededContext();
        const [root] = await linearHistory(origin, 1);
        await pointRef(origin, 'refs/heads/main', root!);
        await writeSplitCommitGraph(origin);
        const [hash] = await chainHashes(origin);
        const base = await buildSeededContext();
        const gitDir = commonGitDir(base);
        const object = looseObjectPath(gitDir, root!);
        await base.fs.write(
          object,
          await origin.fs.read(looseObjectPath(commonGitDir(origin), root!)),
        );
        await base.fs.mkdir(commitGraphLayersDir(gitDir));
        await base.fs.writeUtf8(commitGraphChainPath(gitDir), `${hash}\n`);
        await base.fs.write(
          commitGraphLayerPath(gitDir, hash!),
          await origin.fs.read(commitGraphLayerPath(commonGitDir(origin), hash!)),
        );
        const ctx = withFs(base, {
          read: (path) =>
            path === object ? Promise.reject(permissionDenied(path)) : base.fs.read(path),
        });
        await pointRef(ctx, 'refs/heads/next', await commitOn(ctx, [root!], 'next'));
        const sut = writeSplitCommitGraph;

        // Act
        const caught = await caughtFrom(() => sut(ctx));

        // Assert
        expect((caught as TsgitError).data).toEqual(permissionDenied(object).data);
      });
    });
  });

  describe('Given a folded commit whose parent object is gone', () => {
    describe('When the split write folds its layer', () => {
      it('Then it refuses, naming the missing parent', async () => {
        // Arrange
        const origin = await buildSeededContext();
        const [root, child] = await linearHistory(origin, 2);
        await pointRef(origin, 'refs/heads/main', child!);
        await writeSplitCommitGraph(origin);
        const [hash] = await chainHashes(origin);
        const ctx = await buildSeededContext();
        const gitDir = commonGitDir(ctx);
        const originDir = commonGitDir(origin);
        await ctx.fs.write(
          looseObjectPath(gitDir, child!),
          await origin.fs.read(looseObjectPath(originDir, child!)),
        );
        await ctx.fs.mkdir(commitGraphLayersDir(gitDir));
        await ctx.fs.writeUtf8(commitGraphChainPath(gitDir), `${hash}\n`);
        await ctx.fs.write(
          commitGraphLayerPath(gitDir, hash!),
          await origin.fs.read(commitGraphLayerPath(originDir, hash!)),
        );
        await pointRef(ctx, 'refs/heads/next', await commitOn(ctx, [child!], 'next'));
        const sut = writeSplitCommitGraph;

        // Act
        const caught = await caughtFrom(() => sut(ctx));

        // Assert
        expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id: root });
      });
    });
  });

  describe('Given a merged-away single-file graph whose removal is refused', () => {
    describe('When the split write settles the single file', () => {
      it('Then the refusal propagates', async () => {
        // Arrange
        const base = await buildSeededContext();
        const single = commitGraphPath(commonGitDir(base));
        const ids = await linearHistory(base, 2);
        await pointRef(base, 'refs/heads/main', ids[1]!);
        await writeSplitCommitGraph(base);
        await base.fs.writeUtf8(single, 'not a graph');
        await pointRef(base, 'refs/heads/next', await commitOn(base, [ids[1]!], 'next'));
        const ctx = withFs(base, {
          rm: (path) =>
            path === single ? Promise.reject(permissionDenied(path)) : base.fs.rm(path),
        });
        const sut = writeSplitCommitGraph;

        // Act
        const caught = await caughtFrom(() => sut(ctx));

        // Assert
        expect((caught as TsgitError).data).toEqual(permissionDenied(single).data);
      });
    });
  });

  describe('Given a single-file graph whose read is refused', () => {
    describe('When the split write loads the graph', () => {
      it('Then the refusal propagates', async () => {
        // Arrange
        const base = await buildSeededContext();
        const single = commitGraphPath(commonGitDir(base));
        const ids = await linearHistory(base, 1);
        await pointRef(base, 'refs/heads/main', ids[0]!);
        const ctx = withFs(base, {
          read: (path) =>
            path === single ? Promise.reject(permissionDenied(path)) : base.fs.read(path),
        });
        const sut = writeSplitCommitGraph;

        // Act
        const caught = await caughtFrom(() => sut(ctx));

        // Assert
        expect((caught as TsgitError).data).toEqual(permissionDenied(single).data);
      });
    });
  });

  describe('Given a chain already holding every reachable commit', () => {
    describe('When the split write runs', () => {
      it('Then nothing is written and the chain is reported as it stands', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await linearHistory(ctx, 2);
        await pointRef(ctx, 'refs/heads/main', ids[1]!);
        await writeSplitCommitGraph(ctx);
        const before = await chainHashes(ctx);
        const sut = writeSplitCommitGraph;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({ written: false, commitCount: 2 });
        expect(await chainHashes(ctx)).toEqual(before);
      });
    });
  });

  describe('Given a merged layer naming a commit whose object is gone', () => {
    describe('When the split write folds that layer', () => {
      it('Then the vanished commit is dropped', async () => {
        // Arrange
        const origin = await buildSeededContext();
        const [root] = await linearHistory(origin, 1);
        const lost = await commitOn(origin, [], 'lost');
        await pointRef(origin, 'refs/heads/main', root!);
        await pointRef(origin, 'refs/heads/lost', lost);
        await writeSplitCommitGraph(origin);
        const [oldHash] = await chainHashes(origin);
        const ctx = await buildSeededContext();
        await linearHistory(ctx, 1);
        const gitDir = commonGitDir(ctx);
        await ctx.fs.mkdir(commitGraphLayersDir(gitDir));
        await ctx.fs.writeUtf8(commitGraphChainPath(gitDir), `${oldHash}\n`);
        await ctx.fs.write(
          commitGraphLayerPath(gitDir, oldHash!),
          await origin.fs.read(commitGraphLayerPath(commonGitDir(origin), oldHash!)),
        );
        await pointRef(ctx, 'refs/heads/next', await commitOn(ctx, [root!], 'next'));
        const sut = writeSplitCommitGraph;

        // Act
        const result = await sut(ctx);

        // Assert
        const [hash] = await chainHashes(ctx);
        expect(result).toEqual({ written: true, commitCount: 2 });
        expect(positionOf(await readLayer(ctx, hash!), lost)).toBeUndefined();
      });
    });
  });

  describe('Given a ref naming a blob beside a reachable commit', () => {
    describe('When the split write runs', () => {
      it('Then the blob roots nothing', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await linearHistory(ctx, 1);
        const blob = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: enc.encode('b'),
        });
        await pointRef(ctx, 'refs/heads/main', ids[0]!);
        await pointRef(ctx, 'refs/tags/blob', blob);
        const sut = writeSplitCommitGraph;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({ written: true, commitCount: 1 });
      });
    });
  });

  describe('Given a chain naming a layer that is missing', () => {
    describe('When the split write runs', () => {
      it('Then no existing layer loads and the new chain replaces the stale one', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await linearHistory(ctx, 1);
        await pointRef(ctx, 'refs/heads/main', ids[0]!);
        await ctx.fs.writeUtf8(commitGraphChainPath(commonGitDir(ctx)), `${'c'.repeat(40)}\n`);
        const sut = writeSplitCommitGraph;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({ written: true, commitCount: 1 });
        expect(await chainHashes(ctx)).not.toContain('c'.repeat(40));
      });
    });
  });

  describe('Given a corrupt single-file graph beside a split chain', () => {
    describe('When the split write runs', () => {
      it('Then the chain is read instead, and the corrupt file is unlinked once nothing bases on it', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const gitDir = commonGitDir(ctx);
        const ids = await linearHistory(ctx, 2);
        await pointRef(ctx, 'refs/heads/main', ids[1]!);
        await writeSplitCommitGraph(ctx);
        await ctx.fs.writeUtf8(commitGraphPath(gitDir), 'not a graph');
        await pointRef(ctx, 'refs/heads/next', await commitOn(ctx, [ids[1]!], 'next'));
        const sut = writeSplitCommitGraph;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({ written: true, commitCount: 3 });
        expect(await ctx.fs.exists(commitGraphPath(gitDir))).toBe(false);
      });
    });
  });

  describe('Given stray files beside the chain layers', () => {
    describe('When the split write runs', () => {
      it('Then an unlisted .graph is expired unless dated in the future, and other names are kept', async () => {
        // Arrange
        const base = await buildSeededContext();
        const layersDir = commitGraphLayersDir(commonGitDir(base));
        const ids = await linearHistory(base, 1);
        await pointRef(base, 'refs/heads/main', ids[0]!);
        await base.fs.writeUtf8(`${layersDir}/graph-stale.graph`, 's');
        await base.fs.writeUtf8(`${layersDir}/graph-future.graph`, 'f');
        await base.fs.writeUtf8(`${layersDir}/notes.txt`, 'n');
        const ctx = withFs(base, {
          stat: async (path) => {
            const stat = await base.fs.stat(path);
            return path.endsWith('future.graph')
              ? { ...stat, mtimeMs: Date.now() + 3_600_000 }
              : stat;
          },
        });
        const sut = writeSplitCommitGraph;

        // Act
        await sut(ctx);

        // Assert
        expect(await ctx.fs.exists(`${layersDir}/graph-stale.graph`)).toBe(false);
        expect(await ctx.fs.exists(`${layersDir}/graph-future.graph`)).toBe(true);
        expect(await ctx.fs.exists(`${layersDir}/notes.txt`)).toBe(true);
      });
    });
  });

  describe('Given a stray .graph that vanishes before it is examined', () => {
    describe('When the split write expires layers', () => {
      it('Then it is skipped', async () => {
        // Arrange
        const base = await buildSeededContext();
        const layersDir = commitGraphLayersDir(commonGitDir(base));
        const ids = await linearHistory(base, 1);
        await pointRef(base, 'refs/heads/main', ids[0]!);
        await base.fs.writeUtf8(`${layersDir}/graph-gone.graph`, 'g');
        const ctx = withFs(base, {
          stat: (path) =>
            path.endsWith('gone.graph') ? Promise.reject(fileNotFound(path)) : base.fs.stat(path),
        });
        const sut = writeSplitCommitGraph;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.written).toBe(true);
        expect(await ctx.fs.exists(`${layersDir}/graph-gone.graph`)).toBe(true);
      });
    });
  });

  describe('Given a stray .graph whose stat is refused', () => {
    describe('When the split write expires layers', () => {
      it('Then the refusal propagates', async () => {
        // Arrange
        const base = await buildSeededContext();
        const stray = `${commitGraphLayersDir(commonGitDir(base))}/graph-denied.graph`;
        const ids = await linearHistory(base, 1);
        await pointRef(base, 'refs/heads/main', ids[0]!);
        await base.fs.writeUtf8(stray, 'd');
        const ctx = withFs(base, {
          stat: (path) =>
            path === stray ? Promise.reject(permissionDenied(path)) : base.fs.stat(path),
        });
        const sut = writeSplitCommitGraph;

        // Act
        const caught = await caughtFrom(() => sut(ctx));

        // Assert
        expect((caught as TsgitError).data).toEqual(permissionDenied(stray).data);
      });
    });
  });

  describe('Given a held commit-graph-chain.lock', () => {
    describe('When the split write runs', () => {
      it('Then it refuses as locked and writes no layer', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const chain = commitGraphChainPath(commonGitDir(ctx));
        const ids = await linearHistory(ctx, 1);
        await pointRef(ctx, 'refs/heads/main', ids[0]!);
        await ctx.fs.writeUtf8(`${chain}.lock`, '');
        const sut = writeSplitCommitGraph;

        // Act
        const caught = await caughtFrom(() => sut(ctx));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'RESOURCE_LOCKED',
          resource: 'commit-graph',
          path: `${chain}.lock`,
        });
        expect(await ctx.fs.exists(chain)).toBe(false);
      });
    });
  });

  describe.each([
    { label: 'a shallow repository', file: shallowFilePath },
    { label: 'a registered graft', file: (gitDir: string) => `${gitDir}/info/grafts` },
  ])('Given $label', ({ file }) => {
    describe('When the split write runs', () => {
      it('Then nothing is written', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await linearHistory(ctx, 1);
        await pointRef(ctx, 'refs/heads/main', ids[0]!);
        await ctx.fs.writeUtf8(file(commonGitDir(ctx)), `${ids[0]}\n`);
        const sut = writeSplitCommitGraph;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({ written: false, commitCount: 0 });
        expect(await ctx.fs.exists(commitGraphChainPath(commonGitDir(ctx)))).toBe(false);
      });
    });
  });

  describe('Given a repository with no commits', () => {
    describe('When the split write runs', () => {
      it('Then nothing is written', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = writeSplitCommitGraph;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({ written: false, commitCount: 0 });
      });
    });
  });
});
