/**
 * fsck's `commit-graph verify` leg: every object source's commit-graph is
 * checked against its own checksum, OID order and fanout, then each commit it
 * holds against the object database — tree, parents, generation, date.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { type FsckFinding, fsck } from '../../../../src/application/commands/fsck.js';
import { runCommitGraphVerifyPass } from '../../../../src/application/commands/internal/fsck/commit-graph-verify.js';
import { getObjectStore } from '../../../../src/application/primitives/object-store.js';
import {
  commitGraphChainPath,
  commitGraphLayersDir,
  commitGraphPath,
  commonGitDir,
} from '../../../../src/application/primitives/path-layout.js';
import * as readObjectMod from '../../../../src/application/primitives/read-object.js';
import { writeCommitGraph } from '../../../../src/application/primitives/write-commit-graph.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeSplitCommitGraph } from '../../../../src/application/primitives/write-split-commit-graph.js';
import * as commitGraphMod from '../../../../src/domain/commit/commit-graph.js';
import {
  type CommitGraphLayer,
  parseCommitGraphLayer,
  positionOf,
} from '../../../../src/domain/commit/commit-graph.js';
import { serializeCommitGraph } from '../../../../src/domain/commit/commit-graph-writer.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const EXIT_COMMIT_GRAPH = 16;
const NO_PARENT = 0x70000000;
const IDENT = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const OTHER_TREE = 'a'.repeat(40) as ObjectId;
const ABSENT = '1'.repeat(40) as ObjectId;
const UNEXPECTED = new Error('unexpected');

interface Fixture {
  readonly ctx: Context;
  readonly tree: ObjectId;
  readonly root: ObjectId;
  readonly tip: ObjectId;
}

const commitOn = (ctx: Context, tree: ObjectId, parents: ObjectId[]): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: { tree, parents, author: IDENT, committer: IDENT, message: 'm', extraHeaders: [] },
  });

const repoWithGraph = async (): Promise<Fixture> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  const tree = await writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });
  const root = await commitOn(ctx, tree, []);
  const tip = await commitOn(ctx, tree, [root]);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${tip}\n`);
  await writeCommitGraph(ctx);
  return { ctx, tree, root, tip };
};

type Patch = (bytes: Uint8Array, entry: number, view: DataView) => void;
type GraphPatch = (bytes: Uint8Array, layer: CommitGraphLayer, view: DataView) => void;

/** Rewrites the graph bytes, then restamps the trailer so only the patch disagrees. */
const patchGraph = async (ctx: Context, patch: GraphPatch): Promise<void> => {
  const path = commitGraphPath(commonGitDir(ctx));
  const bytes = new Uint8Array(await ctx.fs.read(path));
  const layer = parseCommitGraphLayer(bytes);
  patch(bytes, layer, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const trailer = bytes.length - ctx.hashConfig.digestLength;
  bytes.set(await ctx.hash.hash(bytes.subarray(0, trailer)), trailer);
  await ctx.fs.write(path, bytes);
};

/** Rewrites one commit's CDAT entry. */
const patchEntry = (ctx: Context, id: ObjectId, patch: Patch): Promise<void> =>
  patchGraph(ctx, (bytes, layer, view) => {
    const position = positionOf(layer, id) as number;
    patch(bytes, layer._commitDataOffset + position * layer._commitDataEntrySize, view);
  });

/** Replaces the graph with one holding a single parentless `id`. */
const writeGraphOf = async (ctx: Context, id: ObjectId, tree: ObjectId): Promise<void> => {
  const graph = serializeCommitGraph(
    [{ id, rootTree: tree, parents: [], committerDate: IDENT.timestamp }],
    ctx.hashConfig,
  );
  const trailer = graph.length - ctx.hashConfig.digestLength;
  graph.set(await ctx.hash.hash(graph.subarray(0, trailer)), trailer);
  await ctx.fs.write(commitGraphPath(commonGitDir(ctx)), graph);
};

/** Renames the GDA2 chunk so the graph reads as topological levels only. */
const dropGenerationData = (ctx: Context): Promise<void> =>
  patchGraph(ctx, (bytes) => {
    const table = bytes.subarray(0, 8 + 12 * (bytes[6] as number));
    const at = new TextDecoder().decode(table).indexOf('GDA2');
    bytes.set(new TextEncoder().encode('XXXX'), at);
  });

const HASH_LENGTH = 20;
const V1_MAX_GENERATION_WORD = 0xfffffffc;
const setParent1 =
  (position: number): Patch =>
  (_bytes, entry, view) =>
    view.setUint32(entry + HASH_LENGTH, position);

const graphFindings = (findings: ReadonlyArray<FsckFinding>): ReadonlyArray<FsckFinding> =>
  findings.filter((finding) => finding.type === 'commit-graph-invalid');

describe('fsck commit-graph verify', () => {
  describe('Given a healthy commit-graph', () => {
    describe('When fsck runs', () => {
      it('Then no commit-graph finding is reported', async () => {
        // Arrange
        const { ctx } = await repoWithGraph();
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([]);
        expect(result.exitCode & EXIT_COMMIT_GRAPH).toBe(0);
      });
    });
  });

  describe('Given no commit-graph at all', () => {
    describe('When the commit-graph verify pass runs', () => {
      it('Then it reports nothing', async () => {
        // Arrange
        const { ctx } = await repoWithGraph();
        await ctx.fs.rm(commitGraphPath(commonGitDir(ctx)));
        const sut = runCommitGraphVerifyPass;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual({ findings: [], exitBit: 0 });
      });
    });
  });

  describe('Given a commit-graph whose trailer disagrees with its bytes', () => {
    describe('When fsck runs', () => {
      it('Then it reports the checksum and sets bit 16', async () => {
        // Arrange
        const { ctx } = await repoWithGraph();
        const path = commitGraphPath(commonGitDir(ctx));
        const bytes = new Uint8Array(await ctx.fs.read(path));
        bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0xff;
        await ctx.fs.write(path, bytes);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          { type: 'commit-graph-invalid', artefact: path, check: 'checksum' },
        ]);
        expect(result.exitCode & EXIT_COMMIT_GRAPH).toBe(EXIT_COMMIT_GRAPH);
      });
    });
  });

  describe('Given a commit-graph recording another root tree', () => {
    describe('When fsck runs', () => {
      it('Then it reports the recorded and actual trees', async () => {
        // Arrange
        const { ctx, tree, root } = await repoWithGraph();
        await patchEntry(ctx, root, (bytes, entry) =>
          bytes.set(new Uint8Array(HASH_LENGTH).fill(0xaa), entry),
        );
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          {
            type: 'commit-graph-invalid',
            artefact: commitGraphPath(commonGitDir(ctx)),
            check: 'root-tree',
            id: root,
            recorded: OTHER_TREE,
            actual: tree,
          },
        ]);
        expect(result.exitCode & EXIT_COMMIT_GRAPH).toBe(EXIT_COMMIT_GRAPH);
      });
    });
  });

  describe('Given a commit-graph giving a root commit a parent', () => {
    describe('When fsck runs', () => {
      it('Then the parent list is too long', async () => {
        // Arrange
        const { ctx, root } = await repoWithGraph();
        await patchEntry(ctx, root, setParent1(0));
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          {
            type: 'commit-graph-invalid',
            artefact: commitGraphPath(commonGitDir(ctx)),
            check: 'parents-too-long',
            id: root,
          },
        ]);
      });
    });
  });

  describe('Given a commit-graph dropping a commit parent', () => {
    describe('When fsck runs', () => {
      it('Then the parent list terminates early', async () => {
        // Arrange
        const { ctx, tip } = await repoWithGraph();
        await patchEntry(ctx, tip, setParent1(NO_PARENT));
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          {
            type: 'commit-graph-invalid',
            artefact: commitGraphPath(commonGitDir(ctx)),
            check: 'parents-terminate-early',
            id: tip,
          },
        ]);
      });
    });
  });

  describe('Given a commit-graph recording another committer date', () => {
    describe('When fsck runs', () => {
      it('Then it reports the recorded and actual dates', async () => {
        // Arrange
        const { ctx, tip } = await repoWithGraph();
        await patchEntry(ctx, tip, (_bytes, entry, view) =>
          view.setUint32(entry + HASH_LENGTH + 12, IDENT.timestamp + 1),
        );
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          {
            type: 'commit-graph-invalid',
            artefact: commitGraphPath(commonGitDir(ctx)),
            check: 'commit-date',
            id: tip,
            recordedDate: IDENT.timestamp + 1,
            actualDate: IDENT.timestamp,
          },
        ]);
      });
    });
  });

  describe('Given core.commitGraph=false over a corrupt commit-graph', () => {
    describe('When fsck runs', () => {
      it('Then the graph is not verified', async () => {
        // Arrange
        const { ctx, root } = await repoWithGraph();
        await patchEntry(ctx, root, setParent1(0));
        await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tcommitGraph = false\n');
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([]);
        expect(result.exitCode & EXIT_COMMIT_GRAPH).toBe(0);
      });
    });
  });
  describe('Given a commit-graph whose two OIDs are swapped', () => {
    describe('When fsck runs', () => {
      it('Then it reports the fanout, the order and each commit it cannot find, then stops', async () => {
        // Arrange
        const { ctx, root, tip } = await repoWithGraph();
        const [low, high] = [root, tip].sort() as [ObjectId, ObjectId];
        await patchGraph(ctx, (bytes, layer) => {
          const at = layer._oidLookupOffset;
          const first = bytes.slice(at, at + HASH_LENGTH);
          bytes.copyWithin(at, at + HASH_LENGTH, at + 2 * HASH_LENGTH);
          bytes.set(first, at + HASH_LENGTH);
        });
        const lowBucket = Number.parseInt(low.slice(0, 2), 16);
        const highBucket = Number.parseInt(high.slice(0, 2), 16);
        const artefact = commitGraphPath(commonGitDir(ctx));
        const fanout = Array.from({ length: highBucket - lowBucket }, (_, offset) => ({
          type: 'commit-graph-invalid',
          artefact,
          check: 'fanout',
          bucket: lowBucket + offset,
          recordedCount: 1,
          expectedCount: 0,
        }));
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          ...fanout,
          { type: 'commit-graph-invalid', artefact, check: 'graph-unparsable', id: high },
          { type: 'commit-graph-invalid', artefact, check: 'oid-order', previous: high, id: low },
          { type: 'commit-graph-invalid', artefact, check: 'graph-unparsable', id: low },
        ]);
      });
    });
  });

  describe('Given a commit-graph parent position past its last commit', () => {
    describe('When fsck runs', () => {
      it('Then it reports the position and verifies nothing more', async () => {
        // Arrange
        const { ctx, tip } = await repoWithGraph();
        await patchEntry(ctx, tip, setParent1(7));
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          {
            type: 'commit-graph-invalid',
            artefact: commitGraphPath(commonGitDir(ctx)),
            check: 'invalid-parent-position',
            position: 7,
          },
        ]);
        expect(result.exitCode & EXIT_COMMIT_GRAPH).toBe(EXIT_COMMIT_GRAPH);
      });
    });
  });

  describe('Given a commit-graph commit missing from the object database', () => {
    describe('When fsck runs', () => {
      it('Then it reports the commit unparsable from the object database', async () => {
        // Arrange
        const { ctx, tree } = await repoWithGraph();
        await writeGraphOf(ctx, ABSENT, tree);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          {
            type: 'commit-graph-invalid',
            artefact: commitGraphPath(commonGitDir(ctx)),
            check: 'odb-unparsable',
            id: ABSENT,
          },
        ]);
      });
    });
  });

  describe('Given a commit-graph naming a tree as a commit', () => {
    describe('When fsck runs', () => {
      it('Then the tree is unparsable as a commit', async () => {
        // Arrange
        const { ctx, tree } = await repoWithGraph();
        await writeGraphOf(ctx, tree, tree);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          {
            type: 'commit-graph-invalid',
            artefact: commitGraphPath(commonGitDir(ctx)),
            check: 'odb-unparsable',
            id: tree,
          },
        ]);
      });
    });
  });

  describe.each([
    { generations: 'corrected commit dates', drop: false, generation: IDENT.timestamp + 1 },
    { generations: 'topological levels', drop: true, generation: 2 },
  ])(
    'Given a commit-graph making a commit its own parent, read as $generations',
    ({ drop, generation }) => {
      describe('When fsck runs', () => {
        it('Then it reports the parent and a generation below its parent', async () => {
          // Arrange
          const { ctx, root, tip } = await repoWithGraph();
          if (drop) await dropGenerationData(ctx);
          const layer = parseCommitGraphLayer(
            await ctx.fs.read(commitGraphPath(commonGitDir(ctx))),
          );
          await patchEntry(ctx, tip, setParent1(positionOf(layer, tip) as number));
          const artefact = commitGraphPath(commonGitDir(ctx));
          const sut = fsck;

          // Act
          const result = await sut(ctx);

          // Assert
          expect(graphFindings(result.findings)).toEqual([
            {
              type: 'commit-graph-invalid',
              artefact,
              check: 'parent',
              id: tip,
              recorded: tip,
              actual: root,
            },
            {
              type: 'commit-graph-invalid',
              artefact,
              check: 'generation',
              id: tip,
              generation,
              minimum: generation + 1,
            },
          ]);
        });
      });
    },
  );

  describe('Given topological levels where a parent sits at the v1 generation ceiling', () => {
    describe('When fsck runs', () => {
      it('Then the child only needs the ceiling itself', async () => {
        // Arrange
        const { ctx, root, tip } = await repoWithGraph();
        await dropGenerationData(ctx);
        await patchEntry(ctx, root, (_bytes, entry, view) =>
          view.setUint32(entry + HASH_LENGTH + 8, V1_MAX_GENERATION_WORD),
        );
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          {
            type: 'commit-graph-invalid',
            artefact: commitGraphPath(commonGitDir(ctx)),
            check: 'generation',
            id: tip,
            generation: 2,
            minimum: 0x3fffffff,
          },
        ]);
      });
    });
  });

  describe('Given topological levels where one commit has generation zero', () => {
    describe('When fsck runs', () => {
      it('Then it reports both zero and non-zero generations', async () => {
        // Arrange
        const { ctx, root, tip } = await repoWithGraph();
        await dropGenerationData(ctx);
        await patchEntry(ctx, root, (_bytes, entry, view) =>
          view.setUint32(entry + HASH_LENGTH + 8, 0),
        );
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          {
            type: 'commit-graph-invalid',
            artefact: commitGraphPath(commonGitDir(ctx)),
            check: 'mixed-generations',
            zero: root,
            nonZero: tip,
          },
        ]);
      });
    });
  });

  describe('Given no commit-graph file and info/commit-graphs a file', () => {
    describe('When fsck runs', () => {
      it('Then it reports the chain it cannot open, setting bit 16', async () => {
        // Arrange
        const { ctx } = await repoWithGraph();
        const gitDir = commonGitDir(ctx);
        await ctx.fs.rm(commitGraphPath(gitDir));
        await ctx.fs.writeUtf8(commitGraphLayersDir(gitDir), 'x');
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          {
            type: 'commit-graph-invalid',
            artefact: commitGraphChainPath(gitDir),
            check: 'chain-unopenable',
            code: 'NOT_A_DIRECTORY',
          },
        ]);
        expect(result.exitCode & EXIT_COMMIT_GRAPH).toBe(EXIT_COMMIT_GRAPH);
      });
    });
  });

  describe('Given a sound split chain in place of the single file', () => {
    describe('When fsck runs', () => {
      it('Then no commit-graph finding is reported', async () => {
        // Arrange
        const { ctx } = await repoWithGraph();
        await ctx.fs.rm(commitGraphPath(commonGitDir(ctx)));
        await writeSplitCommitGraph(ctx);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(await ctx.fs.exists(commitGraphChainPath(commonGitDir(ctx)))).toBe(true);
        expect(graphFindings(result.findings)).toEqual([]);
      });
    });
  });

  describe('Given no commit-graph file and a chain directory with no chain', () => {
    describe('When fsck runs', () => {
      it('Then no commit-graph finding is reported', async () => {
        // Arrange
        const { ctx } = await repoWithGraph();
        const gitDir = commonGitDir(ctx);
        await ctx.fs.rm(commitGraphPath(gitDir));
        await ctx.fs.mkdir(commitGraphLayersDir(gitDir));
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([]);
      });
    });
  });

  /** A merge of the root, the tip and a side commit: its third parent lives in the EDGE chunk. */
  const octopusGraph = async (): Promise<
    Fixture & { readonly merge: ObjectId; readonly side: ObjectId }
  > => {
    const fixture = await repoWithGraph();
    const { ctx, tree, root, tip } = fixture;
    const side = await writeObject(ctx, {
      type: 'commit',
      id: '' as ObjectId,
      data: {
        tree,
        parents: [root],
        author: IDENT,
        committer: IDENT,
        message: 'side',
        extraHeaders: [],
      },
    });
    const merge = await commitOn(ctx, tree, [root, tip, side]);
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${merge}\n`);
    await writeCommitGraph(ctx);
    return { ...fixture, merge, side };
  };

  const chunkRow = (bytes: Uint8Array, id: string): number =>
    new TextDecoder().decode(bytes.subarray(0, 8 + 12 * (bytes[6] as number))).indexOf(id);

  const edgeStart = (bytes: Uint8Array, view: DataView): number =>
    view.getUint32(chunkRow(bytes, 'EDGE') + 8);

  describe.each([
    {
      damage: 'lost its EDGE chunk',
      patch: ((bytes) =>
        bytes.set(new TextEncoder().encode('XXXX'), chunkRow(bytes, 'EDGE'))) as GraphPatch,
    },
    {
      damage: 'an EDGE list that never ends',
      patch: ((bytes, _layer, view) => {
        const at = edgeStart(bytes, view) + 4;
        view.setUint32(at, view.getUint32(at) & 0x7fffffff);
      }) as GraphPatch,
    },
  ])('Given an octopus merge whose graph has $damage', ({ patch }) => {
    describe('When fsck runs', () => {
      it('Then the extra-edges pointer is out of bounds and the merge fails to parse', async () => {
        // Arrange
        const { ctx, merge } = await octopusGraph();
        await patchGraph(ctx, patch);
        const artefact = commitGraphPath(commonGitDir(ctx));
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          { type: 'commit-graph-invalid', artefact, check: 'extra-edges-out-of-bounds' },
          { type: 'commit-graph-invalid', artefact, check: 'graph-unparsable', id: merge },
        ]);
      });
    });
  });

  describe('Given an octopus merge whose EDGE list names a position past the graph', () => {
    describe('When fsck runs', () => {
      it('Then git dies on the position before reaching the end of the list', async () => {
        // Arrange
        const { ctx } = await octopusGraph();
        await patchGraph(ctx, (bytes, _layer, view) => {
          view.setUint32(edgeStart(bytes, view) + 4, 0x80000000 | 9);
        });
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          {
            type: 'commit-graph-invalid',
            artefact: commitGraphPath(commonGitDir(ctx)),
            check: 'invalid-parent-position',
            position: 9,
          },
        ]);
      });
    });
  });

  describe('Given a sound octopus merge in the graph', () => {
    describe('When fsck runs', () => {
      it('Then every parent the EDGE chunk holds verifies', async () => {
        // Arrange
        const { ctx } = await octopusGraph();
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([]);
      });
    });
  });

  describe('Given a commit-graph file shorter than any graph git maps', () => {
    describe('When fsck runs', () => {
      it('Then it reports the file git finds too small to load', async () => {
        // Arrange
        const { ctx } = await repoWithGraph();
        const garbage = new TextEncoder().encode('not a graph');
        await ctx.fs.write(commitGraphPath(commonGitDir(ctx)), garbage);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          {
            type: 'commit-graph-invalid',
            artefact: commitGraphPath(commonGitDir(ctx)),
            check: 'load-failure',
            failure: { kind: 'too-small' },
          },
        ]);
      });
    });
  });

  describe('Given a commit-graph git loads but tsgit cannot decode', () => {
    describe('When fsck runs', () => {
      it('Then it reports the graph malformed with the decode reason', async () => {
        // Arrange
        const { ctx } = await repoWithGraph();
        const path = commitGraphPath(commonGitDir(ctx));
        const bytes = new Uint8Array(await ctx.fs.read(path));
        const table = new TextDecoder().decode(bytes.subarray(0, 8 + 12 * (bytes[6] as number)));
        const view = new DataView(bytes.buffer, bytes.byteOffset);
        const gdaOffsetLow = table.indexOf('GDA2') + 8;
        view.setUint32(gdaOffsetLow, view.getUint32(gdaOffsetLow) + 4);
        await ctx.fs.write(path, bytes);
        let reason: unknown;
        try {
          parseCommitGraphLayer(bytes);
        } catch (error) {
          reason = (error as Error).message;
        }
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(graphFindings(result.findings)).toEqual([
          {
            type: 'commit-graph-invalid',
            artefact: path,
            check: 'load-failure',
            failure: { kind: 'malformed', reason },
          },
        ]);
      });
    });
  });

  describe.each([
    {
      fault: 'reading the graph is refused',
      arrange: async (ctx: Context): Promise<void> => {
        const { primary } = await getObjectStore(ctx);
        vi.spyOn(primary.fs, 'read').mockRejectedValueOnce(UNEXPECTED);
      },
    },
    {
      fault: 'decoding the graph fails unexpectedly',
      arrange: async (): Promise<void> => {
        vi.spyOn(commitGraphMod, 'parseCommitGraphLayer').mockImplementationOnce(() => {
          throw UNEXPECTED;
        });
      },
    },
    {
      fault: 'opening the chain fails outside the error model',
      arrange: async (ctx: Context): Promise<void> => {
        await ctx.fs.rm(commitGraphPath(commonGitDir(ctx)));
        const { primary } = await getObjectStore(ctx);
        const read = primary.fs.read.bind(primary.fs);
        vi.spyOn(primary.fs, 'read').mockImplementation((path) =>
          path === commitGraphChainPath(commonGitDir(ctx))
            ? Promise.reject(UNEXPECTED)
            : read(path),
        );
      },
    },
    {
      fault: 'reading a graph commit fails outside the object model',
      arrange: async (): Promise<void> => {
        vi.spyOn(readObjectMod, 'readObject').mockRejectedValueOnce(UNEXPECTED);
      },
    },
  ])('Given $fault', ({ arrange }) => {
    describe('When the commit-graph verify pass runs', () => {
      it('Then the fault propagates', async () => {
        // Arrange
        const { ctx } = await repoWithGraph();
        await arrange(ctx);
        const sut = runCommitGraphVerifyPass;

        // Act
        let caught: unknown;
        try {
          await sut(ctx);
        } catch (error) {
          caught = error;
        }

        // Assert
        vi.restoreAllMocks();
        expect(caught).toBe(UNEXPECTED);
      });
    });
  });
});
