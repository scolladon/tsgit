import { describe, expect, it } from 'vitest';
import { createCommit } from '../../../../../src/application/primitives/create-commit.js';
import { loadCommitGraphBaseLayers } from '../../../../../src/application/primitives/internal/local-commit-graph-layers.js';
import { narrowObjectSourceAccess } from '../../../../../src/application/primitives/object-store.js';
import {
  commitGraphChainPath,
  commitGraphChainPathIn,
  commitGraphLayerPath,
  commitGraphLayerPathIn,
  commitGraphPath,
  commitGraphPathIn,
  commonGitDir,
} from '../../../../../src/application/primitives/path-layout.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeSplitCommitGraph } from '../../../../../src/application/primitives/write-split-commit-graph.js';
import { fileNotFound } from '../../../../../src/domain/error.js';
import type { ObjectId, Tree } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildSeededContext } from '../fixtures.js';

const AUTHOR = {
  name: 'Alice',
  email: 'a@a.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

const seedHistory = async (ctx: Context): Promise<void> => {
  const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
  const commit = await createCommit(ctx, {
    tree: await writeObject(ctx, tree),
    parents: [],
    author: AUTHOR,
    committer: AUTHOR,
    message: 'c',
  });
  await ctx.fs.writeUtf8(`${commonGitDir(ctx)}/refs/heads/main`, `${commit}\n`);
};

const recordingReads = (ctx: Context): { readonly ctx: Context; readonly reads: string[] } => {
  const reads: string[] = [];
  const read = (path: string): Promise<Uint8Array> => {
    if (path.includes('commit-graph')) reads.push(path);
    return ctx.fs.read(path);
  };
  return { ctx: { ...ctx, fs: { ...ctx.fs, read } }, reads };
};

describe('loadCommitGraphBaseLayers', () => {
  describe('Given no commit-graph file and no chain', () => {
    describe('When the base layers are loaded', () => {
      it('Then none is found and only the single file was looked for', async () => {
        // Arrange
        const seeded = await buildSeededContext();
        const { ctx, reads } = recordingReads(seeded);
        const sut = loadCommitGraphBaseLayers;

        // Act
        const result = await sut(ctx);

        // Assert
        expect({ result, reads }).toEqual({
          result: [],
          reads: [commitGraphPath(commonGitDir(ctx))],
        });
      });
    });
  });

  describe('Given a chain of one layer ending with a newline', () => {
    describe('When the base layers are loaded', () => {
      it('Then the layer is found and no other layer was looked for', async () => {
        // Arrange
        const seeded = await buildSeededContext();
        await seedHistory(seeded);
        await writeSplitCommitGraph(seeded);
        const gitDir = commonGitDir(seeded);
        const hash = (await seeded.fs.readUtf8(commitGraphChainPath(gitDir))).trim();
        const { ctx, reads } = recordingReads(seeded);
        const sut = loadCommitGraphBaseLayers;

        // Act
        const result = await sut(ctx);

        // Assert
        expect({ hashes: result.map((layer) => layer.hash), reads }).toEqual({
          hashes: [hash],
          reads: [commitGraphPath(gitDir), commitGraphLayerPath(gitDir, hash)],
        });
      });
    });
  });

  describe("Given an alternate holding a chain, read through the store's own view", () => {
    describe('When the base layers are loaded', () => {
      it("Then the chain and its layer are read through that view, not the repository's filesystem", async () => {
        // Arrange
        const altObjects = '/repo/alt/objects';
        const viewed: string[] = [];
        const viewFiles = new Map<string, Uint8Array>();
        const fromView = (path: string): Uint8Array => {
          viewed.push(path);
          const bytes = viewFiles.get(path);
          if (bytes === undefined) throw fileNotFound(path);
          return bytes;
        };
        const base = await buildSeededContext();
        const objectSourceAccess = (objectsDir: string) => ({
          ...narrowObjectSourceAccess(base.fs, objectsDir),
          read: (path: string) => Promise.resolve().then(() => fromView(path)),
          readUtf8: (path: string) =>
            Promise.resolve().then(() => new TextDecoder().decode(fromView(path))),
        });
        const ctx: Context = { ...base, objectSourceAccess };
        const gitDir = commonGitDir(ctx);
        await ctx.fs.mkdir(`${altObjects}/info/commit-graphs`);
        await ctx.fs.writeUtf8(`${gitDir}/objects/info/alternates`, `${altObjects}\n`);
        await seedHistory(ctx);
        await writeSplitCommitGraph(ctx);
        const chain = await ctx.fs.readUtf8(commitGraphChainPath(gitDir));
        const hash = chain.trim();
        viewFiles.set(commitGraphChainPathIn(altObjects), new TextEncoder().encode(chain));
        viewFiles.set(
          commitGraphLayerPathIn(altObjects, hash),
          await ctx.fs.read(commitGraphLayerPath(gitDir, hash)),
        );
        await ctx.fs.rm(commitGraphChainPath(gitDir));
        await ctx.fs.rm(commitGraphLayerPath(gitDir, hash));
        viewed.length = 0;
        const sut = loadCommitGraphBaseLayers;

        // Act
        const result = await sut(ctx);

        // Assert
        expect({ found: result.map((layer) => [layer.hash, layer.local]), viewed }).toEqual({
          found: [[hash, false]],
          viewed: [
            commitGraphPathIn(altObjects),
            commitGraphChainPathIn(altObjects),
            commitGraphLayerPathIn(altObjects, hash),
          ],
        });
      });
    });
  });
});
