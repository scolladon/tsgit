/**
 * fsck's `commit-graph verify` over a split chain: the chain is loaded the
 * way git's loader does — each line's layer searched in every source, matched
 * against the layers below it — then verified tip to base with chain-global
 * parent positions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { type FsckFinding, fsck } from '../../../../src/application/commands/fsck.js';
import { refreshObjectStore } from '../../../../src/application/primitives/object-store.js';
import {
  commitGraphChainPath,
  commitGraphLayerPath,
  commitGraphLayerPathIn,
  commonGitDir,
} from '../../../../src/application/primitives/path-layout.js';
import * as readObjectMod from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeSplitCommitGraph } from '../../../../src/application/primitives/write-split-commit-graph.js';
import { parseCommitGraphLayer, positionOf } from '../../../../src/domain/commit/commit-graph.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const EXIT_COMMIT_GRAPH = 16;
const OTHER_TREE = 'a'.repeat(40) as ObjectId;
const IDENT = { name: 'Ada', email: 'ada@example.com', timezoneOffset: '+0000' };

interface Chain {
  readonly ctx: Context;
  readonly tree: ObjectId;
  readonly commits: readonly ObjectId[];
  readonly base: string;
  readonly tip: string;
}

const commitOn = (
  ctx: Context,
  tree: ObjectId,
  parents: ObjectId[],
  timestamp: number,
): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree,
      parents,
      author: { ...IDENT, timestamp },
      committer: { ...IDENT, timestamp },
      message: 'm',
      extraHeaders: [],
    },
  });

const advance = async (ctx: Context, tree: ObjectId, commits: ObjectId[]): Promise<void> => {
  const parents = commits.length === 0 ? [] : [commits[commits.length - 1] as ObjectId];
  commits.push(await commitOn(ctx, tree, parents, 1_700_000_000 + commits.length));
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${commits.at(-1)}\n`);
};

const chainLines = async (ctx: Context): Promise<string[]> =>
  (await ctx.fs.readUtf8(commitGraphChainPath(commonGitDir(ctx)))).split('\n').filter(Boolean);

/** `baseCommits` in a base layer, `tipCommits` more in a tip layer above it (split writes fold a tip that is not small enough). */
const twoLayerChain = async (tipCommits = 1, baseCommits = 3): Promise<Chain> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  const tree = await writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });
  const commits: ObjectId[] = [];
  for (let n = 0; n < baseCommits; n += 1) await advance(ctx, tree, commits);
  await writeSplitCommitGraph(ctx);
  for (let n = 0; n < tipCommits; n += 1) await advance(ctx, tree, commits);
  await writeSplitCommitGraph(ctx);
  const [base, tip] = (await chainLines(ctx)) as [string, string];
  return { ctx, tree, commits, base, tip };
};

const layerPath = (ctx: Context, hash: string): string =>
  commitGraphLayerPath(commonGitDir(ctx), hash);

/** Points `id`'s root tree elsewhere in its layer, restamping the trailer when asked. */
const swapRootTreeIn = async (
  ctx: Context,
  hash: string,
  id: ObjectId,
  restamp: boolean,
): Promise<void> => {
  const bytes = new Uint8Array(await ctx.fs.read(layerPath(ctx, hash)));
  const layer = parseCommitGraphLayer(bytes);
  const entry = layer._commitDataOffset + (positionOf(layer, id) as number) * 36;
  bytes.fill(0xaa, entry, entry + 20);
  if (restamp)
    bytes.set(await ctx.hash.hash(bytes.subarray(0, bytes.length - 20)), bytes.length - 20);
  await ctx.fs.write(layerPath(ctx, hash), bytes);
};

const HASH_BYTES = 20;
const CHUNK_TABLE_ENTRY = 12;
const PARENT_ONE_AT = HASH_BYTES;
const GENERATION_AT = HASH_BYTES + 8;
const BEYOND_THE_CHAIN = 99;
const GENERATION_BELOW_ITS_PARENT = 1;
const GENERATION_WORD_SHIFT = 2;

const chunkStart = (bytes: Uint8Array, id: string): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const table = 8 + CHUNK_TABLE_ENTRY * (bytes[6] as number);
  for (let at = 8; at < table; at += CHUNK_TABLE_ENTRY) {
    if (new TextDecoder().decode(bytes.subarray(at, at + 4)) === id) {
      return Number(view.getBigUint64(at + 4));
    }
  }
  throw new Error(`no ${id} chunk`);
};

const restamp = async (ctx: Context, bytes: Uint8Array): Promise<void> => {
  bytes.set(
    await ctx.hash.hash(bytes.subarray(0, bytes.length - HASH_BYTES)),
    bytes.length - HASH_BYTES,
  );
};

const readLayer = async (ctx: Context, hash: string): Promise<Uint8Array> =>
  new Uint8Array(await ctx.fs.read(layerPath(ctx, hash)));

/** Points the first parent of the tip's first commit past the chain's end, restamping the trailer. */
const sendTipParentBeyondTheChain = async (ctx: Context, tip: string): Promise<void> => {
  const bytes = await readLayer(ctx, tip);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  view.setUint32(chunkStart(bytes, 'CDAT') + PARENT_ONE_AT, BEYOND_THE_CHAIN);
  await restamp(ctx, bytes);
  await ctx.fs.write(layerPath(ctx, tip), bytes);
};

/**
 * Leaves the base without generation data and the tip's one commit with a
 * topological level below its parent's, the chain otherwise consistent:
 * the base is renamed after its new trailer and the tip's base chunk follows.
 */
const mixGenerationData = async (ctx: Context, base: string, tip: string): Promise<void> => {
  const baseBytes = await readLayer(ctx, base);
  const at = new TextDecoder()
    .decode(baseBytes.subarray(0, 8 + CHUNK_TABLE_ENTRY * (baseBytes[6] as number)))
    .indexOf('GDA2');
  baseBytes.set(new TextEncoder().encode('XXXX'), at);
  await restamp(ctx, baseBytes);
  const trailer = baseBytes.subarray(baseBytes.length - HASH_BYTES);
  const renamed = Array.from(trailer, (byte) => byte.toString(16).padStart(2, '0')).join('');
  await ctx.fs.write(layerPath(ctx, renamed), baseBytes);
  const tipBytes = await readLayer(ctx, tip);
  tipBytes.set(trailer, chunkStart(tipBytes, 'BASE'));
  const generationAt = chunkStart(tipBytes, 'CDAT') + GENERATION_AT;
  new DataView(tipBytes.buffer, tipBytes.byteOffset).setUint32(
    generationAt,
    GENERATION_BELOW_ITS_PARENT << GENERATION_WORD_SHIFT,
  );
  await restamp(ctx, tipBytes);
  await ctx.fs.write(layerPath(ctx, tip), tipBytes);
  await ctx.fs.writeUtf8(commitGraphChainPath(commonGitDir(ctx)), `${renamed}\n${tip}\n`);
};

/** The object database stops answering for `id`, as a pruned loose object would. */
const hideFromObjectDatabase = (id: ObjectId): void => {
  const read = readObjectMod.readObject;
  vi.spyOn(readObjectMod, 'readObject').mockImplementation((ctx, wanted, ...rest) =>
    wanted === id
      ? Promise.reject(new TsgitError({ code: 'OBJECT_NOT_FOUND', id }))
      : read(ctx, wanted, ...rest),
  );
};

const graphFindings = (findings: ReadonlyArray<FsckFinding>): ReadonlyArray<unknown> =>
  findings
    .filter((finding) => finding.type === 'commit-graph-invalid')
    .map(({ type: _type, artefact: _artefact, ...verdict }) => verdict);

describe('fsck commit-graph chain verify', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Given a sound two-layer chain whose tip names its parent in the base', () => {
    describe('When fsck runs', () => {
      it('Then no commit-graph finding is reported', async () => {
        // Arrange
        const { ctx } = await twoLayerChain();
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([]);
        expect(result.exitCode & EXIT_COMMIT_GRAPH).toBe(0);
      });
    });
  });

  describe('Given a tip layer recording another root tree, restamped', () => {
    describe('When fsck runs', () => {
      it('Then the tip commit is reported against the chain-global graph', async () => {
        // Arrange
        const { ctx, tree, commits, tip } = await twoLayerChain();
        await swapRootTreeIn(ctx, tip, commits[3] as ObjectId, true);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          { check: 'root-tree', id: commits[3], recorded: OTHER_TREE, actual: tree },
        ]);
        expect(result.exitCode & EXIT_COMMIT_GRAPH).toBe(EXIT_COMMIT_GRAPH);
      });
    });
  });

  describe('Given a base layer restamped after its root tree changed', () => {
    describe('When fsck runs', () => {
      it('Then the tip no longer matches, the base alone is verified and the chain is incomplete', async () => {
        // Arrange
        const { ctx, tree, commits, base } = await twoLayerChain();
        await swapRootTreeIn(ctx, base, commits[0] as ObjectId, true);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          { check: 'chain-mismatch' },
          { check: 'chain-layer-missing' },
          { check: 'root-tree', id: commits[0], recorded: OTHER_TREE, actual: tree },
          { check: 'chain-incomplete' },
        ]);
      });
    });
  });

  describe('Given a tip root tree changed and a base root tree changed without restamping', () => {
    describe('When fsck runs', () => {
      it('Then the base checksum lets its commits be compared again', async () => {
        // Arrange
        const { ctx, tree, commits, base, tip } = await twoLayerChain();
        await swapRootTreeIn(ctx, tip, commits[3] as ObjectId, true);
        await swapRootTreeIn(ctx, base, commits[0] as ObjectId, false);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          { check: 'root-tree', id: commits[3], recorded: OTHER_TREE, actual: tree },
          { check: 'checksum' },
          { check: 'root-tree', id: commits[0], recorded: OTHER_TREE, actual: tree },
        ]);
      });
    });
  });

  describe('Given a tip root tree changed and a base commit gone from the object database', () => {
    describe('When fsck runs', () => {
      it('Then the base commits are not compared once the tip has reported', async () => {
        // Arrange
        const { ctx, tree, commits, tip } = await twoLayerChain();
        await swapRootTreeIn(ctx, tip, commits[3] as ObjectId, true);
        hideFromObjectDatabase(commits[0] as ObjectId);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          { check: 'root-tree', id: commits[3], recorded: OTHER_TREE, actual: tree },
        ]);
      });
    });
  });

  describe('Given only a base commit gone from the object database', () => {
    describe('When fsck runs', () => {
      it('Then the base layer reports it', async () => {
        // Arrange
        const { ctx, commits } = await twoLayerChain();
        hideFromObjectDatabase(commits[0] as ObjectId);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          { check: 'odb-unparsable', id: commits[0] },
        ]);
      });
    });
  });

  describe('Given a tip layer truncated below any graph git maps', () => {
    describe('When fsck runs', () => {
      it('Then the tip fails to load, the base is verified and the chain is incomplete', async () => {
        // Arrange
        const { ctx, tip } = await twoLayerChain();
        const bytes = await ctx.fs.read(layerPath(ctx, tip));
        await ctx.fs.write(layerPath(ctx, tip), bytes.subarray(0, 40));
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          { check: 'layer-load-failure', layer: tip, failure: { kind: 'too-small' } },
          { check: 'chain-layer-missing' },
          { check: 'chain-incomplete' },
        ]);
      });
    });
  });

  describe('Given the base layer missing', () => {
    describe('When fsck runs', () => {
      it('Then no layer loads and verify fails with only the missing layer reported', async () => {
        // Arrange
        const { ctx, base } = await twoLayerChain();
        await ctx.fs.rm(layerPath(ctx, base));
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          { check: 'chain-layer-missing' },
          { check: 'chain-unloaded' },
        ]);
        expect(result.exitCode & EXIT_COMMIT_GRAPH).toBe(EXIT_COMMIT_GRAPH);
      });
    });
  });

  describe('Given a chain line that is not a hash', () => {
    describe('When fsck runs', () => {
      it('Then the line is named and the layers before it are verified', async () => {
        // Arrange
        const { ctx, base, tip } = await twoLayerChain();
        const line = `zz${tip.slice(2)}`;
        await ctx.fs.writeUtf8(commitGraphChainPath(commonGitDir(ctx)), `${base}\n${line}\n`);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          { check: 'chain-line-not-hash', line },
          { check: 'chain-incomplete' },
        ]);
      });
    });
  });

  describe('Given the chain lines swapped', () => {
    describe('When fsck runs', () => {
      it('Then the base has no base chunk and the lone tip dies on its parent position', async () => {
        // Arrange
        const { ctx, commits, base, tip } = await twoLayerChain();
        const baseLayer = parseCommitGraphLayer(await ctx.fs.read(layerPath(ctx, base)));
        const parentPosition = positionOf(baseLayer, commits[2] as ObjectId);
        await ctx.fs.writeUtf8(commitGraphChainPath(commonGitDir(ctx)), `${tip}\n${base}\n`);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          { check: 'chain-no-base-chunk' },
          { check: 'chain-layer-missing' },
          { check: 'invalid-parent-position', position: parentPosition },
        ]);
      });
    });
  });

  describe('Given a chain file shorter than one hash', () => {
    describe('When fsck runs', () => {
      it('Then the chain is too small to open', async () => {
        // Arrange
        const { ctx } = await twoLayerChain();
        await ctx.fs.writeUtf8(commitGraphChainPath(commonGitDir(ctx)), 'abc\n');
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([{ check: 'chain-too-small' }]);
      });
    });
  });

  describe('Given an empty chain file', () => {
    describe('When fsck runs', () => {
      it('Then it reads as no chain', async () => {
        // Arrange
        const { ctx } = await twoLayerChain();
        await ctx.fs.writeUtf8(commitGraphChainPath(commonGitDir(ctx)), '');
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([]);
      });
    });
  });

  describe('Given a chain of exactly one hash and no newline', () => {
    describe('When fsck runs', () => {
      it('Then it holds no whole line and nothing loads', async () => {
        // Arrange
        const { ctx, base } = await twoLayerChain();
        await ctx.fs.writeUtf8(commitGraphChainPath(commonGitDir(ctx)), base);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([{ check: 'chain-unloaded' }]);
      });
    });
  });

  describe('Given a third chain line naming the tip again', () => {
    describe('When fsck runs', () => {
      it('Then the repeated tip has too few base entries for the layers below it', async () => {
        // Arrange
        const { ctx, base, tip } = await twoLayerChain();
        const chain = `${base}\n${tip}\n${tip}\n`;
        await ctx.fs.writeUtf8(commitGraphChainPath(commonGitDir(ctx)), chain);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          { check: 'chain-base-chunk-too-small' },
          { check: 'chain-layer-missing' },
          { check: 'chain-incomplete' },
        ]);
      });
    });
  });

  describe('Given a chain whose base line names another layer than the tip records', () => {
    describe('When fsck runs', () => {
      it('Then the tip does not match the chain and the other layer is verified alone', async () => {
        // Arrange
        const { ctx, tree, commits, base, tip } = await twoLayerChain();
        const bytes = new Uint8Array(await ctx.fs.read(layerPath(ctx, base)));
        const layer = parseCommitGraphLayer(bytes);
        const entry =
          layer._commitDataOffset + (positionOf(layer, commits[0] as ObjectId) as number) * 36;
        bytes.fill(0xaa, entry, entry + 20);
        const trailer = await ctx.hash.hash(bytes.subarray(0, bytes.length - 20));
        bytes.set(trailer, bytes.length - 20);
        const other = Buffer.from(trailer).toString('hex');
        await ctx.fs.write(layerPath(ctx, other), bytes);
        await ctx.fs.writeUtf8(commitGraphChainPath(commonGitDir(ctx)), `${other}\n${tip}\n`);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          { check: 'chain-mismatch' },
          { check: 'chain-layer-missing' },
          { check: 'root-tree', id: commits[0], recorded: OTHER_TREE, actual: tree },
          { check: 'chain-incomplete' },
        ]);
      });
    });
  });

  describe('Given a chain line shorter than a hash', () => {
    describe('When fsck runs', () => {
      it('Then the short line is not a hash', async () => {
        // Arrange
        const { ctx, base } = await twoLayerChain();
        const chain = `${base}\nabc\n${'x'.repeat(40)}\n`;
        await ctx.fs.writeUtf8(commitGraphChainPath(commonGitDir(ctx)), chain);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          { check: 'chain-line-not-hash', line: 'abc' },
          { check: 'chain-incomplete' },
        ]);
      });
    });
  });

  describe('Given an upper-case base line whose layer file carries that spelling', () => {
    describe('When fsck runs', () => {
      it('Then the line names the same layer the tip records', async () => {
        // Arrange
        const { ctx, base, tip } = await twoLayerChain();
        const upper = base.toUpperCase();
        await ctx.fs.write(layerPath(ctx, upper), await ctx.fs.read(layerPath(ctx, base)));
        await ctx.fs.writeUtf8(commitGraphChainPath(commonGitDir(ctx)), `${upper}\n${tip}\n`);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([]);
      });
    });
  });

  describe('Given a tip layer git cannot load here but sound in an alternate', () => {
    describe('When fsck runs', () => {
      it('Then the refusal is named and the alternate copy completes the chain', async () => {
        // Arrange
        const { ctx, tip } = await twoLayerChain();
        const sound = await ctx.fs.read(layerPath(ctx, tip));
        await ctx.fs.write(layerPath(ctx, tip), sound.subarray(0, 40));
        const alternate = `${commonGitDir(ctx)}/alternate-objects`;
        await ctx.fs.write(commitGraphLayerPathIn(alternate, tip), sound);
        await ctx.fs.writeUtf8(`${commonGitDir(ctx)}/objects/info/alternates`, `${alternate}\n`);
        refreshObjectStore(ctx);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          { check: 'layer-load-failure', layer: tip, failure: { kind: 'too-small' } },
        ]);
      });
    });
  });

  describe('Given reading a layer fails outside the error model', () => {
    describe('When fsck runs', () => {
      it('Then the fault propagates', async () => {
        // Arrange
        const { ctx, tip } = await twoLayerChain();
        const read = ctx.fs.read.bind(ctx.fs);
        const fault = new Error('unexpected');
        vi.spyOn(ctx.fs, 'read').mockImplementation((path) =>
          path === layerPath(ctx, tip) ? Promise.reject(fault) : read(path),
        );
        const sut = fsck;

        // Act
        let caught: unknown;
        try {
          await sut(ctx);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBe(fault);
      });
    });
  });

  describe('Given a tip of three commits, each naming the one before as its parent', () => {
    describe('When fsck runs', () => {
      it('Then the parent is found in the tip layer and no commit-graph finding is reported', async () => {
        // Arrange
        const { ctx, base, tip } = await twoLayerChain(3, 7);
        expect(await chainLines(ctx)).toEqual([base, tip]);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([]);
      });
    });
  });

  describe('Given a tip whose first commit names a parent past the end of the chain and a base with a bad checksum', () => {
    describe('When fsck runs', () => {
      it('Then verification dies on the tip and the base is never reached', async () => {
        // Arrange
        const { ctx, tip, base, commits } = await twoLayerChain();
        await sendTipParentBeyondTheChain(ctx, tip);
        await swapRootTreeIn(ctx, base, commits[0] as ObjectId, false);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          { check: 'invalid-parent-position', position: BEYOND_THE_CHAIN },
        ]);
      });
    });
  });

  describe('Given a base without generation data under a tip whose commit sits below its parent', () => {
    describe('When fsck runs', () => {
      it('Then the chain reads topological levels and the tip commit is reported', async () => {
        // Arrange
        const { ctx, commits, base, tip } = await twoLayerChain();
        await mixGenerationData(ctx, base, tip);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          {
            check: 'generation',
            id: commits[3],
            generation: GENERATION_BELOW_ITS_PARENT,
            minimum: 4,
          },
        ]);
      });
    });
  });

  describe('Given a chain file one byte short of a hash line', () => {
    describe('When fsck runs', () => {
      it('Then the chain is too small to open', async () => {
        // Arrange
        const { ctx } = await twoLayerChain();
        await ctx.fs.writeUtf8(commitGraphChainPath(commonGitDir(ctx)), `${'a'.repeat(38)}\n`);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([{ check: 'chain-too-small' }]);
      });
    });
  });
});
