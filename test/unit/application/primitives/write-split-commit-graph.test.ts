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
import {
  commitDataAt,
  parseCommitGraphLayer,
  positionOf,
  storedBloomFilter,
} from '../../../../src/domain/commit/commit-graph.js';
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
  identity: AuthorIdentity = AUTHOR,
): Promise<ObjectId> {
  const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
  return createCommit(ctx, {
    tree: await writeObject(ctx, tree),
    parents,
    author: identity,
    committer: identity,
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

async function moveFile(ctx: Context, from: string, to: string): Promise<void> {
  await ctx.fs.write(to, await ctx.fs.read(from));
  await ctx.fs.rm(from);
}

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

  describe('Given a split layer holding the lower-ordered root and a new higher-ordered root of the same date', () => {
    describe('When the split write folds them with a budget of one filter', () => {
      it('Then the lower-ordered root gets the filter — pinned against git 2.55.0', async () => {
        // Arrange — `commitGraph.changedPaths=true`, `commitGraph.maxNewFilters=1`,
        // `git commit-graph write --reachable --split` over the two roots gives the
        // lower object id the filter and the higher a zero-length one.
        const ctx = await buildSeededContext();
        const [low, high] = [await commitOn(ctx, [], 'a'), await commitOn(ctx, [], 'b')].sort() as [
          ObjectId,
          ObjectId,
        ];
        await pointRef(ctx, 'refs/heads/main', low);
        await writeSplitCommitGraph(ctx);
        await ctx.fs.appendUtf8(
          `${commonGitDir(ctx)}/config`,
          '[commitGraph]\n\tchangedPaths\n\tmaxNewFilters = 1\n',
        );
        await pointRef(ctx, 'refs/heads/next', high);
        const sut = writeSplitCommitGraph;

        // Act
        await sut(ctx);

        // Assert
        const hashes = await chainHashes(ctx);
        const layer = await readLayer(ctx, hashes[0]!);
        const lengths = [low, high].map(
          (id) => storedBloomFilter(layer, positionOf(layer, id)!)?.length,
        );
        expect(hashes).toHaveLength(1);
        expect(lengths).toEqual([1, 0]);
      });
    });
  });

  describe('Given a single-file base of three linear commits and a child of its tip', () => {
    describe('When the split write adds the child as a layer', () => {
      it('Then the child carries the base tip level plus one and its corrected date past the base tip', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await linearHistory(ctx, 3);
        await pointRef(ctx, 'refs/heads/main', ids[2]!);
        await writeCommitGraph(ctx);
        const next = await commitOn(ctx, [ids[2]!], 'next');
        await pointRef(ctx, 'refs/heads/next', next);
        const sut = writeSplitCommitGraph;

        // Act
        await sut(ctx);

        // Assert
        const [, tipHash] = await chainHashes(ctx);
        const tip = await readLayer(ctx, tipHash!);
        const at = positionOf(tip, next)!;
        const level = commitDataAt(tip, at, { correctedCommitDates: false }).generation;
        const corrected = commitDataAt(tip, at, { correctedCommitDates: true }).generation;
        // git 2.55.0 (`commit-graph write --reachable`, then `--split=no-merge` over a new commit)
        // writes the same level and corrected date for the child.
        expect({ level, corrected }).toEqual({ level: 4, corrected: AUTHOR.timestamp + 3 });
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

  describe('Given commitGraph.changedPaths set and no commit-graph', () => {
    describe('When the split write runs', () => {
      it("Then the layer carries changed-path filters at git's default settings", async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await linearHistory(ctx, 2);
        await pointRef(ctx, 'refs/heads/main', ids[1]!);
        await ctx.fs.appendUtf8(`${commonGitDir(ctx)}/config`, '[commitGraph]\n\tchangedPaths\n');
        const sut = writeSplitCommitGraph;

        // Act
        await sut(ctx);

        // Assert
        const [hash] = await chainHashes(ctx);
        expect((await readLayer(ctx, hash!)).bloomSettings).toEqual({
          hashVersion: 1,
          numHashes: 7,
          bitsPerEntry: 10,
        });
      });
    });
  });

  describe('Given a top layer carrying changed-path filters and commitGraph.changedPaths false', () => {
    describe('When a new commit is written as a layer', () => {
      it("Then the new layer keeps the top layer's settings", async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await linearHistory(ctx, 6);
        const config = `${commonGitDir(ctx)}/config`;
        await pointRef(ctx, 'refs/heads/main', ids[4]!);
        await ctx.fs.appendUtf8(
          config,
          '[commitGraph]\n\tchangedPaths\n\tchangedPathsVersion = 2\n',
        );
        await writeSplitCommitGraph(ctx);
        await ctx.fs.appendUtf8(config, '\tchangedPaths = false\n\tchangedPathsVersion = -1\n');
        await pointRef(ctx, 'refs/heads/main', ids[5]!);
        const sut = writeSplitCommitGraph;

        // Act
        await sut(ctx);

        // Assert
        const hashes = await chainHashes(ctx);
        expect(hashes).toHaveLength(2);
        expect((await readLayer(ctx, hashes[1]!)).bloomSettings?.hashVersion).toBe(2);
      });
    });
  });

  describe('Given commitGraph.changedPaths set, commitGraph.maxNewFilters 1 and a linear history', () => {
    describe('When the split write runs', () => {
      it('Then only the lowest-generation commit gets a filter, the others a zero-length one', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await linearHistory(ctx, 3);
        await pointRef(ctx, 'refs/heads/main', ids[2]!);
        await ctx.fs.appendUtf8(
          `${commonGitDir(ctx)}/config`,
          '[commitGraph]\n\tchangedPaths\n\tmaxNewFilters = 1\n',
        );
        const sut = writeSplitCommitGraph;

        // Act
        await sut(ctx);

        // Assert
        const [hash] = await chainHashes(ctx);
        const layer = await readLayer(ctx, hash!);
        const lengths = ids.map((id) => storedBloomFilter(layer, positionOf(layer, id)!)?.length);
        expect(lengths).toEqual([1, 0, 0]);
      });
    });
  });

  describe('Given a budget of one filter over commits whose dates run against their generations', () => {
    const datedCommit = (
      ctx: Context,
      parents: readonly ObjectId[],
      timestamp: number,
    ): Promise<ObjectId> => commitOn(ctx, parents, `at ${timestamp}`, { ...AUTHOR, timestamp });

    const filterLengths = async (ctx: Context, ids: readonly ObjectId[]) => {
      const hashes = await chainHashes(ctx);
      const layer = await readLayer(ctx, hashes.at(-1)!);
      return ids.map((id) => storedBloomFilter(layer, positionOf(layer, id)!)?.length);
    };

    describe.each([
      { version: 2, expected: [1, 0] },
      { version: 1, expected: [0, 1] },
    ])(
      'When generation version $version writes a newer parent and its older child',
      ({ version, expected }) => {
        it('Then the lowest generation, else the oldest date, gets the filter', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const parent = await datedCommit(ctx, [], 1_700_001_000);
          const child = await datedCommit(ctx, [parent], 1_700_000_500);
          await pointRef(ctx, 'refs/heads/main', child);
          await ctx.fs.appendUtf8(
            `${commonGitDir(ctx)}/config`,
            `[commitGraph]\n\tchangedPaths\n\tmaxNewFilters = 1\n\tgenerationVersion = ${version}\n`,
          );
          const sut = writeSplitCommitGraph;

          // Act
          await sut(ctx);

          // Assert
          expect(await filterLengths(ctx, [parent, child])).toEqual(expected);
        });
      },
    );

    describe.each([
      { version: 2, expected: [1, 0, 0, 0] },
      { version: 1, expected: [0, 0, 1, 0] },
    ])(
      'When generation version $version folds an older layer into the new commits',
      ({ version, expected }) => {
        it('Then a folded commit keys by its corrected date, else by its level after every new one', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const config = `${commonGitDir(ctx)}/config`;
          await ctx.fs.appendUtf8(config, `[commitGraph]\n\tgenerationVersion = ${version}\n`);
          const ids: ObjectId[] = [];
          for (const offset of [100, 200])
            ids.push(await datedCommit(ctx, ids.slice(-1), 1_700_000_000 + offset));
          await pointRef(ctx, 'refs/heads/main', ids[1]!);
          await writeSplitCommitGraph(ctx);
          for (const offset of [300, 400])
            ids.push(await datedCommit(ctx, ids.slice(-1), 1_700_000_000 + offset));
          await pointRef(ctx, 'refs/heads/main', ids[3]!);
          await ctx.fs.appendUtf8(config, '\tchangedPaths\n\tmaxNewFilters = 1\n');
          const sut = writeSplitCommitGraph;

          // Act
          await sut(ctx);

          // Assert
          expect(await chainHashes(ctx)).toHaveLength(1);
          expect(await filterLengths(ctx, ids)).toEqual(expected);
        });
      },
    );
  });

  describe('Given a malformed commitGraph.maxNewFilters in a shallow repository', () => {
    describe('When the split write runs', () => {
      it('Then it refuses on the config before declining for the shallow boundary', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await linearHistory(ctx, 1);
        await pointRef(ctx, 'refs/heads/main', ids[0]!);
        await ctx.fs.writeUtf8(shallowFilePath(commonGitDir(ctx)), `${ids[0]}\n`);
        await ctx.fs.appendUtf8(
          `${commonGitDir(ctx)}/config`,
          '[commitGraph]\n\tmaxNewFilters = x\n',
        );
        const sut = writeSplitCommitGraph;

        // Act
        const result = await caughtFrom(() => sut(ctx));

        // Assert
        expect((result as TsgitError).data).toMatchObject({
          code: 'CONFIG_BAD_NUMERIC_VALUE',
          key: 'commitgraph.maxnewfilters',
          value: 'x',
          reason: 'invalid unit',
        });
      });
    });
  });

  describe('Given a malformed commitGraph.changedPaths in a shallow repository', () => {
    describe('When the split write runs', () => {
      it('Then it refuses on the config before declining for the shallow boundary', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await linearHistory(ctx, 1);
        await pointRef(ctx, 'refs/heads/main', ids[0]!);
        await ctx.fs.writeUtf8(shallowFilePath(commonGitDir(ctx)), `${ids[0]}\n`);
        await ctx.fs.appendUtf8(
          `${commonGitDir(ctx)}/config`,
          '[commitGraph]\n\tchangedPaths = x\n',
        );
        const sut = writeSplitCommitGraph;

        // Act
        const result = await caughtFrom(() => sut(ctx));

        // Assert
        expect((result as TsgitError).data).toMatchObject({
          code: 'CONFIG_BAD_BOOLEAN_VALUE',
          value: 'x',
        });
      });
    });
  });

  describe('Given an alternate whose chain holds the history and one new local commit', () => {
    describe('When the split write runs', () => {
      it("Then the new layer sits on the alternate's layer, which is never merged", async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const gitDir = commonGitDir(ctx);
        const altObjects = '/repo/alt/objects';
        await ctx.fs.mkdir(`${altObjects}/info/commit-graphs`);
        await ctx.fs.writeUtf8(`${gitDir}/objects/info/alternates`, `${altObjects}\n`);
        const ids = await linearHistory(ctx, 2);
        await pointRef(ctx, 'refs/heads/main', ids[1]!);
        await writeSplitCommitGraph(ctx);
        const [altHash] = await chainHashes(ctx);
        const layerName = `graph-${altHash}.graph`;
        await moveFile(
          ctx,
          `${commitGraphLayersDir(gitDir)}/${layerName}`,
          `${altObjects}/info/commit-graphs/${layerName}`,
        );
        await moveFile(
          ctx,
          commitGraphChainPath(gitDir),
          `${altObjects}/info/commit-graphs/commit-graph-chain`,
        );
        const next = await commitOn(ctx, [ids[1]!], 'next');
        await pointRef(ctx, 'refs/heads/next', next);
        const sut = writeSplitCommitGraph;

        // Act
        const result = await sut(ctx);

        // Assert
        const hashes = await chainHashes(ctx);
        const layer = await readLayer(ctx, hashes[1]!);
        expect(result).toEqual({ written: true, commitCount: 3 });
        expect(hashes[0]).toBe(altHash);
        expect(hashes).toHaveLength(2);
        expect(layer.commitCount).toBe(1);
        expect(positionOf(layer, next)).toBeDefined();
        expect(await ctx.fs.exists(`${altObjects}/info/commit-graphs/${layerName}`)).toBe(true);
      });
    });
  });

  describe('Given an alternate holding a single commit-graph file and one new local commit', () => {
    describe('When the split write runs', () => {
      it("Then the new layer stands alone over every commit, the alternate's file untouched", async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const gitDir = commonGitDir(ctx);
        const altObjects = '/repo/alt/objects';
        await ctx.fs.mkdir(`${altObjects}/info`);
        await ctx.fs.writeUtf8(`${gitDir}/objects/info/alternates`, `${altObjects}\n`);
        const ids = await linearHistory(ctx, 2);
        await pointRef(ctx, 'refs/heads/main', ids[1]!);
        await writeCommitGraph(ctx);
        await moveFile(ctx, commitGraphPath(gitDir), `${altObjects}/info/commit-graph`);
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
        expect(await ctx.fs.exists(`${altObjects}/info/commit-graph`)).toBe(true);
      });
    });
  });
});
