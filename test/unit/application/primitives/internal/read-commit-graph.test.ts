import { describe, expect, it } from 'vitest';
import { createCommit } from '../../../../../src/application/primitives/create-commit.js';
import {
  commitHeader,
  insertBounded,
  isGraphKnownAbsent,
} from '../../../../../src/application/primitives/internal/read-commit-graph.js';
import {
  commitGraphChainPath,
  commitGraphPath,
  commonGitDir,
} from '../../../../../src/application/primitives/path-layout.js';
import { readObject } from '../../../../../src/application/primitives/read-object.js';
import { walkCommits } from '../../../../../src/application/primitives/walk-commits.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { NO_PARENT } from '../../../../../src/domain/commit/commit-graph.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import type {
  AuthorIdentity,
  Commit,
  ObjectId,
  Tree,
} from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildCommitGraphBytes } from '../../../domain/commit/arbitraries.js';
import { buildSeededContext, instrumentedContext, writeCommitGraph } from '../fixtures.js';

const withFsOverride = (ctx: Context, overrides: Partial<Context['fs']>): Context => ({
  ...ctx,
  fs: { ...ctx.fs, ...overrides },
});

function findChunkRowIndex(bytes: Uint8Array, id: string): number {
  const numChunks = bytes[6]!;
  const decoder = new TextDecoder();
  for (let i = 0; i < numChunks; i += 1) {
    const rowStart = 8 + i * 12;
    if (decoder.decode(bytes.subarray(rowStart, rowStart + 4)) === id) return i;
  }
  throw new Error(`chunk ${id} not present in fixture`);
}

function renameChunkRowId(bytes: Uint8Array, id: string, newId: string): Uint8Array {
  const copy = bytes.slice();
  const rowStart = 8 + findChunkRowIndex(copy, id) * 12;
  copy.set(new TextEncoder().encode(newId), rowStart);
  return copy;
}

/** Overwrite the first CDAT entry whose parent1 slot is a real (non-NO_PARENT)
 *  position with `position` — used to force an out-of-range global position
 *  through `findLayerForGlobalPosition`/`oidAtPosition`. */
function corruptFirstRealParent1Position(bytes: Uint8Array, position: number): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  const numChunks = copy[6]!;
  const decoder = new TextDecoder();
  let cdatStart = -1;
  let commitCount = -1;
  for (let i = 0; i < numChunks; i += 1) {
    const rowStart = 8 + i * 12;
    const id = decoder.decode(copy.subarray(rowStart, rowStart + 4));
    const offset = view.getUint32(rowStart + 4) * 0x100000000 + view.getUint32(rowStart + 8);
    if (id === 'OIDF') commitCount = view.getUint32(offset + 255 * 4);
    if (id === 'CDAT') cdatStart = offset;
  }
  const hashLength = 20;
  const entrySize = hashLength + 16;
  for (let pos = 0; pos < commitCount; pos += 1) {
    const entryOffset = cdatStart + pos * entrySize;
    if (view.getUint32(entryOffset + hashLength) !== NO_PARENT) {
      view.setUint32(entryOffset + hashLength, position);
      return copy;
    }
  }
  throw new Error('no commit with a real parent1 position found in fixture');
}

/**
 * A structurally-valid-enough commit-graph whose OIDF chunk table row is
 * followed by an unrecognized ("ZZZZ") row that absorbs the offset jump back
 * down to a small, in-bounds OIDL/CDAT/trailer — every VALIDATED chunk
 * (OIDF's own FANOUT_SIZE check) passes, but the `commitCount` read
 * (`view.getUint32(oidf.start + 1020)`) lands ~100MB past the small backing
 * buffer, throwing a genuine RangeError (not a TsgitError).
 */
function buildRangeErrorTriggeringGraphBytes(): Uint8Array {
  const bytes = new Uint8Array(110);
  const view = new DataView(bytes.buffer);
  const textEncoder = new TextEncoder();
  bytes.set(textEncoder.encode('CGPH'), 0);
  view.setUint8(4, 1); // version
  view.setUint8(5, 1); // hashVersion
  view.setUint8(6, 4); // numChunks: OIDF, ZZZZ, OIDL, CDAT
  view.setUint8(7, 0); // numBaseGraphs
  const setRow = (index: number, id: string, offset: number): void => {
    const rowStart = 8 + index * 12;
    bytes.set(textEncoder.encode(id), rowStart);
    view.setUint32(rowStart + 4, Math.floor(offset / 0x100000000));
    view.setUint32(rowStart + 8, offset % 0x100000000);
  };
  setRow(0, 'OIDF', 100_000_000);
  setRow(1, 'ZZZZ', 100_001_024); // OIDF's end: exactly FANOUT_SIZE (1024) wide
  setRow(2, 'OIDL', 80);
  setRow(3, 'CDAT', 80);
  setRow(4, '', 80); // trailer sentinel
  return bytes;
}

const AUTHOR: AuthorIdentity = {
  name: 'Alice',
  email: 'a@a.com',
  timestamp: 1700000000,
  timezoneOffset: '+0000',
};

const oid = (prefix: string): ObjectId => (prefix + '0'.repeat(40 - prefix.length)) as ObjectId;

interface MixedChainCommits {
  readonly root: ObjectId;
  readonly middle: ObjectId;
  readonly tip: ObjectId;
}

/**
 * Write git's "mixed generation" chain shape: the BASE layer stores corrected
 * commit dates (GDA2), while the TIP layer — a `commitGraph.generationVersion=1`
 * write — stores none. Generations are chosen so the two readings disagree:
 * corrected dates would report 1000/1001 for the base layer, topological levels
 * report 1/2. Synthetic oids, because only the graph is being read here.
 */
async function writeMixedGenerationChain(ctx: Context): Promise<MixedChainCommits> {
  const commits: MixedChainCommits = { root: oid('aa01'), middle: oid('aa02'), tip: oid('aa03') };
  const baseBytes = buildCommitGraphBytes({
    hashVersion: 1,
    numBaseGraphs: 0,
    baseGraphHashes: [],
    includeGenerationData: true,
    commits: [
      {
        oid: commits.root,
        rootTree: oid('ee01'),
        parentPositions: [],
        generationV1: 1,
        committerDate: 1000,
        generationV2Offset: 0,
      },
      {
        oid: commits.middle,
        rootTree: oid('ee02'),
        parentPositions: [0],
        generationV1: 2,
        committerDate: 900,
        generationV2Offset: 101,
      },
    ],
  });
  const baseHash = (await ctx.hash.hashHex(baseBytes)) as ObjectId;
  const tipBytes = buildCommitGraphBytes({
    hashVersion: 1,
    numBaseGraphs: 1,
    baseGraphHashes: [baseHash],
    includeGenerationData: false,
    commits: [
      {
        oid: commits.tip,
        rootTree: oid('ee03'),
        parentPositions: [1],
        generationV1: 3,
        committerDate: 500,
        generationV2Offset: 0,
      },
    ],
  });
  const tipHash = (await ctx.hash.hashHex(tipBytes)) as ObjectId;
  const gitDir = commonGitDir(ctx);
  await ctx.fs.write(`${gitDir}/objects/info/commit-graphs/graph-${baseHash}.graph`, baseBytes);
  await ctx.fs.write(`${gitDir}/objects/info/commit-graphs/graph-${tipHash}.graph`, tipBytes);
  await ctx.fs.writeUtf8(commitGraphChainPath(gitDir), `${baseHash}\n${tipHash}\n`);
  return commits;
}

async function emptyTree(ctx: Awaited<ReturnType<typeof buildSeededContext>>): Promise<ObjectId> {
  const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
  return writeObject(ctx, tree);
}

async function makeCommit(
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  tree: ObjectId,
  parents: ReadonlyArray<ObjectId>,
  timestamp: number,
  message: string,
): Promise<Commit> {
  const id = await createCommit(ctx, {
    tree,
    parents,
    author: { ...AUTHOR, timestamp },
    committer: { ...AUTHOR, timestamp },
    message,
  });
  const object = await readObject(ctx, id);
  if (object.type !== 'commit') throw new Error('expected a commit');
  return object;
}

/** Pin D's 5-commit shape: c0 root, c1/c2 linear, c3 merges c0+c2, c4 tip. */
async function buildFiveCommitHistory(
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
): Promise<{ c0: Commit; c1: Commit; c2: Commit; c3: Commit; c4: Commit }> {
  const tree = await emptyTree(ctx);
  const c0 = await makeCommit(ctx, tree, [], 1, 'c0');
  const c1 = await makeCommit(ctx, tree, [c0.id], 2, 'c1');
  const c2 = await makeCommit(ctx, tree, [c1.id], 3, 'c2');
  const c3 = await makeCommit(ctx, tree, [c0.id, c2.id], 4, 'c3');
  const c4 = await makeCommit(ctx, tree, [c3.id], 5, 'c4');
  return { c0, c1, c2, c3, c4 };
}

function expectHeaderMatchesCommit(
  header: Awaited<ReturnType<typeof commitHeader>>,
  commit: Commit,
): void {
  expect(header).toBeDefined();
  expect(header?.rootTree).toBe(commit.data.tree);
  expect(header?.parents).toEqual(commit.data.parents);
  expect(header?.committerDate).toBe(commit.data.committer.timestamp);
  expect(header?.generation).toBeGreaterThan(0);
}

describe('read-commit-graph', () => {
  describe('commitHeader', () => {
    describe('Given a single-file commit-graph over a 5-commit merge history', () => {
      describe('When commitHeader is called for every commit', () => {
        it('Then rootTree/parents/committerDate/generation match object reads', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { c0, c1, c2, c3, c4 } = await buildFiveCommitHistory(ctx);
          await writeCommitGraph(ctx, [[c0, c1, c2, c3, c4]]);

          // Act + Assert
          for (const commit of [c0, c1, c2, c3, c4]) {
            const header = await commitHeader(ctx, commit.id);
            expectHeaderMatchesCommit(header, commit);
          }
        });
      });
    });

    describe('Given a chain/split commit-graph (base=[c0,c1,c2], tip=[c3,c4])', () => {
      describe('When commitHeader is called for commits in each layer', () => {
        it('Then cross-layer parent resolution matches object reads', async () => {
          // Arrange — c3 (tip) has both parents in the base layer; c4 (tip)
          // has its single parent resolved within the tip layer itself.
          const ctx = await buildSeededContext();
          const { c0, c1, c2, c3, c4 } = await buildFiveCommitHistory(ctx);
          await writeCommitGraph(ctx, [
            [c0, c1, c2],
            [c3, c4],
          ]);

          // Act + Assert
          for (const commit of [c0, c1, c2, c3, c4]) {
            const header = await commitHeader(ctx, commit.id);
            expectHeaderMatchesCommit(header, commit);
          }
        });
      });
    });

    describe('Given a single-file graph with an octopus (3-parent) merge', () => {
      describe('When commitHeader is called for the merge commit', () => {
        it('Then all three parents resolve via the EDGE chunk, in order', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const tree = await emptyTree(ctx);
          const d0 = await makeCommit(ctx, tree, [], 1, 'd0');
          const d1 = await makeCommit(ctx, tree, [], 2, 'd1');
          const d2 = await makeCommit(ctx, tree, [], 3, 'd2');
          const d3 = await makeCommit(ctx, tree, [d0.id, d1.id, d2.id], 4, 'd3');
          await writeCommitGraph(ctx, [[d0, d1, d2, d3]]);

          // Act
          const header = await commitHeader(ctx, d3.id);

          // Assert
          expectHeaderMatchesCommit(header, d3);
        });
      });
    });

    describe('Given a fixture graph over a child whose parent carries a much newer date', () => {
      describe('When commitHeader is called for both commits', () => {
        it('Then each generation is the corrected commit date git would store', async () => {
          // Arrange — git's corrected commit date is
          // `max(committerDate, max(parentGeneration) + 1)`, so a child
          // committed BEFORE its parent still outranks it by exactly one.
          const ctx = await buildSeededContext();
          const tree = await emptyTree(ctx);
          const root = await makeCommit(ctx, tree, [], 1000, 'root');
          const child = await makeCommit(ctx, tree, [root.id], 10, 'child');
          await writeCommitGraph(ctx, [[root, child]]);

          // Act
          const rootHeader = await commitHeader(ctx, root.id);
          const childHeader = await commitHeader(ctx, child.id);

          // Assert
          expect(rootHeader?.generation).toBe(1000);
          expect(childHeader?.generation).toBe(1001);
        });
      });
    });

    describe('Given a layer set that omits a commit referenced as a parent', () => {
      describe('When the fixture is asked to write that graph', () => {
        it('Then it refuses, because a valid commit-graph never omits a parent', async () => {
          // Arrange — encoding the absent parent as position 0 would forge a
          // phantom edge to whichever commit sorts first, silently weakening
          // every walk assertion built on the graph.
          const ctx = await buildSeededContext();
          const tree = await emptyTree(ctx);
          const root = await makeCommit(ctx, tree, [], 1, 'root');
          const child = await makeCommit(ctx, tree, [root.id], 2, 'child');
          const sut = writeCommitGraph;

          // Act
          const attempt = sut(ctx, [[child]]);

          // Assert
          await expect(attempt).rejects.toThrow(`parent ${root.id} is outside every layer`);
        });
      });
    });

    describe('Given a chain whose tip layer stores no corrected commit dates', () => {
      describe('When commitHeader is called for commits in both layers', () => {
        it('Then every layer serves topological levels, not just the one missing GDA2', async () => {
          // Arrange — git's `validate_mixed_generation_chain` clears
          // `read_generation_data` on EVERY layer as soon as one lacks GDA2, so
          // the base layer's stored corrected dates (1000/1001) must not be
          // served alongside the tip layer's levels.
          const ctx = await buildSeededContext();
          const { root, middle, tip } = await writeMixedGenerationChain(ctx);

          // Act
          const rootHeader = await commitHeader(ctx, root);
          const middleHeader = await commitHeader(ctx, middle);
          const tipHeader = await commitHeader(ctx, tip);

          // Assert
          expect(rootHeader?.generation).toBe(1);
          expect(middleHeader?.generation).toBe(2);
          expect(tipHeader?.generation).toBe(3);
          expect(middleHeader?.parents).toEqual([root]);
          expect(tipHeader?.parents).toEqual([middle]);
        });
      });
    });

    describe('Given a commit that is real but absent from an otherwise-valid graph', () => {
      describe('When commitHeader is called for it', () => {
        it('Then returns undefined', async () => {
          // Arrange — the graph only covers c0..c3; c4 is real but not included.
          const ctx = await buildSeededContext();
          const { c0, c1, c2, c3, c4 } = await buildFiveCommitHistory(ctx);
          await writeCommitGraph(ctx, [[c0, c1, c2, c3]]);

          // Act
          const header = await commitHeader(ctx, c4.id);

          // Assert
          expect(header).toBeUndefined();
        });
      });
    });

    describe('Given a chain whose most-recent layer file has been deleted', () => {
      describe('When commitHeader is called for a commit that lives in the still-present base layer', () => {
        it('Then the WHOLE graph is treated as absent (returns undefined)', async () => {
          // Arrange — Pin D staleness: a chain referencing a missing layer is
          // treated as absent, not "partially available".
          const ctx = await buildSeededContext();
          const { c0, c1, c2, c3, c4 } = await buildFiveCommitHistory(ctx);
          await writeCommitGraph(ctx, [
            [c0, c1, c2],
            [c3, c4],
          ]);
          const gitDir = commonGitDir(ctx);
          const chainText = await ctx.fs.readUtf8(commitGraphChainPath(gitDir));
          const tipHash = chainText.trim().split('\n').at(-1)!;
          await ctx.fs.rm(`${gitDir}/objects/info/commit-graphs/graph-${tipHash}.graph`);

          // Act — c0 lives entirely in the still-present base layer.
          const header = await commitHeader(ctx, c0.id);

          // Assert
          expect(header).toBeUndefined();
        });
      });
    });

    describe('Given a present-but-corrupt single-file commit-graph', () => {
      describe('When commitHeader is called for a real commit', () => {
        it('Then the graph degrades to absent (undefined) instead of throwing', async () => {
          // Arrange — garbage bytes where the graph should be; git treats a
          // corrupt graph as absent (warn + object-read fallback, exit 0)
          const ctx = await buildSeededContext();
          const tree = await emptyTree(ctx);
          const commit = await makeCommit(ctx, tree, [], 1, 'corrupt-graph');
          const gitDir = commonGitDir(ctx);
          await ctx.fs.write(
            `${gitDir}/objects/info/commit-graph`,
            new TextEncoder().encode('not a commit graph at all'),
          );

          // Act
          const header = await commitHeader(ctx, commit.id);
          const secondHeader = await commitHeader(ctx, commit.id);

          // Assert — degraded on the first call AND the cached verdict is the
          // fallback (never a memoized rejection poisoning later walks); the
          // session now knows the graph is absent
          expect(header).toBeUndefined();
          expect(secondHeader).toBeUndefined();
          expect(isGraphKnownAbsent(ctx)).toBe(true);
        });
      });
    });

    describe('Given no commit-graph file at all', () => {
      describe('When commitHeader is called for a real commit', () => {
        it('Then returns undefined', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const tree = await emptyTree(ctx);
          const commit = await makeCommit(ctx, tree, [], 1, 'solo');

          // Act
          const header = await commitHeader(ctx, commit.id);

          // Assert
          expect(header).toBeUndefined();
        });
      });
    });

    describe('Given no commit-graph file at all', () => {
      describe('When commitHeader probes the chain file', () => {
        it('Then readUtf8 is never called (the exists() presence check short-circuits it)', async () => {
          // Arrange — pins the budget invariant from tryReadUtf8's own doc
          // comment: the common absent-graph case must cost a presence check,
          // not a failed read.
          const base = await buildSeededContext();
          const tree = await emptyTree(base);
          const commit = await makeCommit(base, tree, [], 1, 'solo');
          const { ctx, calls } = instrumentedContext(base);

          // Act
          const header = await commitHeader(ctx, commit.id);

          // Assert
          expect(header).toBeUndefined();
          const chainReads = calls().filter(
            (call) => call.method === 'readUtf8' && call.path.includes('commit-graph'),
          );
          expect(chainReads.length).toBe(0);
        });
      });
    });

    describe('Given a commit-graph consulted across two separate commitHeader calls', () => {
      describe('When both calls target the same Context', () => {
        it('Then the graph file is read only once (parsed once, then cached)', async () => {
          // Arrange
          const base = await buildSeededContext();
          const { c0, c1 } = await buildFiveCommitHistory(base);
          await writeCommitGraph(base, [[c0, c1]]);
          const { ctx, calls } = instrumentedContext(base);

          // Act
          await commitHeader(ctx, c0.id);
          await commitHeader(ctx, c1.id);

          // Assert
          const graphReads = calls().filter(
            (call) => call.method === 'read' && call.path.includes('commit-graph'),
          );
          expect(graphReads.length).toBe(1);
        });
      });
    });

    describe('Given a commit-graph and a repeated walk over the same commit set', () => {
      describe('When commitHeader is called for every commit across two full passes', () => {
        it('Then every returned CommitHeader is deep-equal across both passes', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { c0, c1, c2, c3, c4 } = await buildFiveCommitHistory(ctx);
          await writeCommitGraph(ctx, [[c0, c1, c2, c3, c4]]);
          const commits = [c0, c1, c2, c3, c4];

          // Act
          const firstPass: Array<Awaited<ReturnType<typeof commitHeader>>> = [];
          for (const commit of commits) {
            firstPass.push(await commitHeader(ctx, commit.id));
          }
          const secondPass: Array<Awaited<ReturnType<typeof commitHeader>>> = [];
          for (const commit of commits) {
            secondPass.push(await commitHeader(ctx, commit.id));
          }

          // Assert
          for (const [i, header] of firstPass.entries()) {
            expectHeaderMatchesCommit(header, commits[i]!);
          }
          for (const [i, header] of secondPass.entries()) {
            // Reference identity, not deep equality: a header is built as a
            // fresh object literal on every miss, so only a genuine cache hit
            // can return the same reference — deleting or silently dropping
            // the memo fails this assertion where toEqual would still pass.
            expect(header).toBe(firstPass[i]);
          }
        });
      });
    });

    describe('Given a commit-graph already loaded via a prior commitHeader call', () => {
      describe('When commitHeader is called for a different commit whose header is not yet cached', () => {
        it('Then no additional read on a commit-graph path occurs — the header is re-derived from the already-parsed graph', async () => {
          // Arrange — pins the R3 eviction-safety property: a header-cache
          // miss (whether never-computed or evicted) must be re-derivable
          // from `graph` alone, with zero further `ctx.fs` calls.
          const base = await buildSeededContext();
          const { c0, c1, c2, c3, c4 } = await buildFiveCommitHistory(base);
          await writeCommitGraph(base, [[c0, c1, c2, c3, c4]]);
          const { ctx, calls } = instrumentedContext(base);
          await commitHeader(ctx, c0.id);
          const callsAfterGraphLoad = calls().length;

          // Act — c4's header has never been computed, so it is a cache miss.
          const header = await commitHeader(ctx, c4.id);

          // Assert — TOTAL fs-call invariance, not a filtered subset: any fs
          // call the miss path might gain on any method or path (a loose or
          // pack object fallback included) fails this, where a
          // commit-graph-path filter would let it slip through.
          expectHeaderMatchesCommit(header, c4);
          expect(calls().length).toBe(callsAfterGraphLoad);
        });
      });
    });

    describe('Given an oid absent from the graph', () => {
      describe('When commitHeader is called for it twice', () => {
        it('Then both calls return undefined', async () => {
          // Arrange — the graph only covers c0..c3; c4 is real but not included.
          const ctx = await buildSeededContext();
          const { c0, c1, c2, c3, c4 } = await buildFiveCommitHistory(ctx);
          await writeCommitGraph(ctx, [[c0, c1, c2, c3]]);

          // Act
          const first = await commitHeader(ctx, c4.id);
          const second = await commitHeader(ctx, c4.id);

          // Assert
          expect(first).toBeUndefined();
          expect(second).toBeUndefined();
        });
      });
    });

    describe('Given ctx.fs.read throws a non-FILE_NOT_FOUND error while probing the single-file graph', () => {
      describe('When commitHeader is called', () => {
        it('Then the error propagates unchanged (not swallowed as absent/corrupt)', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const tree = await emptyTree(ctx);
          const commit = await makeCommit(ctx, tree, [], 1, 'solo');
          const gitDir = commonGitDir(ctx);
          const graphPath = commitGraphPath(gitDir);
          const wrapped = withFsOverride(ctx, {
            exists: async (path) => (path === graphPath ? true : ctx.fs.exists(path)),
            read: async (path) => {
              if (path === graphPath) throw new TsgitError({ code: 'PERMISSION_DENIED', path });
              return ctx.fs.read(path);
            },
          });

          // Act + Assert
          try {
            await commitHeader(wrapped, commit.id);
            expect.unreachable();
          } catch (error) {
            expect((error as TsgitError).data.code).toBe('PERMISSION_DENIED');
          }
        });
      });
    });

    describe('Given ctx.fs.read throws FILE_NOT_FOUND despite exists() reporting the single-file graph present', () => {
      describe('When commitHeader is called', () => {
        it('Then the narrow TOCTOU window resolves to absent, not a thrown error', async () => {
          // Arrange — exists()=true then read() fails FILE_NOT_FOUND simulates
          // the file disappearing between the two calls.
          const ctx = await buildSeededContext();
          const tree = await emptyTree(ctx);
          const commit = await makeCommit(ctx, tree, [], 1, 'solo');
          const gitDir = commonGitDir(ctx);
          const graphPath = commitGraphPath(gitDir);
          const wrapped = withFsOverride(ctx, {
            exists: async (path) => (path === graphPath ? true : ctx.fs.exists(path)),
            read: async (path) => {
              if (path === graphPath) throw new TsgitError({ code: 'FILE_NOT_FOUND', path });
              return ctx.fs.read(path);
            },
          });

          // Act
          const header = await commitHeader(wrapped, commit.id);

          // Assert
          expect(header).toBeUndefined();
        });
      });
    });

    describe('Given ctx.fs.readUtf8 throws a non-FILE_NOT_FOUND error while probing the chain file', () => {
      describe('When commitHeader is called', () => {
        it('Then the error propagates unchanged', async () => {
          // Arrange — no single-file graph, so loadGraphUncached falls to loadChain.
          const ctx = await buildSeededContext();
          const tree = await emptyTree(ctx);
          const commit = await makeCommit(ctx, tree, [], 1, 'solo');
          const gitDir = commonGitDir(ctx);
          const chainPath = commitGraphChainPath(gitDir);
          const wrapped = withFsOverride(ctx, {
            exists: async (path) => (path === chainPath ? true : ctx.fs.exists(path)),
            readUtf8: async (path) => {
              if (path === chainPath) throw new TsgitError({ code: 'PERMISSION_DENIED', path });
              return ctx.fs.readUtf8(path);
            },
          });

          // Act + Assert
          try {
            await commitHeader(wrapped, commit.id);
            expect.unreachable();
          } catch (error) {
            expect((error as TsgitError).data.code).toBe('PERMISSION_DENIED');
          }
        });
      });
    });

    describe('Given ctx.fs.readUtf8 throws FILE_NOT_FOUND despite exists() reporting the chain file present', () => {
      describe('When commitHeader is called', () => {
        it('Then the graph degrades to absent instead of throwing', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const tree = await emptyTree(ctx);
          const commit = await makeCommit(ctx, tree, [], 1, 'solo');
          const gitDir = commonGitDir(ctx);
          const chainPath = commitGraphChainPath(gitDir);
          const wrapped = withFsOverride(ctx, {
            exists: async (path) => (path === chainPath ? true : ctx.fs.exists(path)),
            readUtf8: async (path) => {
              if (path === chainPath) throw new TsgitError({ code: 'FILE_NOT_FOUND', path });
              return ctx.fs.readUtf8(path);
            },
          });

          // Act
          const header = await commitHeader(wrapped, commit.id);

          // Assert
          expect(header).toBeUndefined();
        });
      });
    });

    describe('Given a chain file whose hash lines carry leading/trailing whitespace', () => {
      describe('When commitHeader is called for a commit in the (still-resolvable) base layer', () => {
        it('Then the padded lines are trimmed before being used as layer filenames', async () => {
          // Arrange — kills the `.trim()` drop: without it, the padded
          // "  <hash>  " string never matches a real `graph-<hash>.graph`
          // file, so the layer read fails and the whole chain degrades absent.
          const ctx = await buildSeededContext();
          const { c0, c1, c2, c3, c4 } = await buildFiveCommitHistory(ctx);
          await writeCommitGraph(ctx, [
            [c0, c1, c2],
            [c3, c4],
          ]);
          const gitDir = commonGitDir(ctx);
          const chainPath = commitGraphChainPath(gitDir);
          const chainText = await ctx.fs.readUtf8(chainPath);
          const paddedText = `${chainText
            .split('\n')
            .filter((line) => line.length > 0)
            .map((hash) => `  ${hash}  `)
            .join('\n')}\n`;
          await ctx.fs.writeUtf8(chainPath, paddedText);

          // Act
          const header = await commitHeader(ctx, c0.id);

          // Assert
          expect(header).toBeDefined();
          expect(header?.rootTree).toBe(c0.data.tree);
        });
      });
    });

    describe('Given commitHeader called twice for the same oid', () => {
      describe('When both calls target the same Context', () => {
        it('Then the second call returns the exact same cached header object', async () => {
          // Arrange — kills the header-cache-map recreation guard: without it,
          // every call discards the previous per-Context cache and recomputes
          // (and re-allocates) the header from scratch.
          const ctx = await buildSeededContext();
          const tree = await emptyTree(ctx);
          const commit = await makeCommit(ctx, tree, [], 1, 'solo');
          await writeCommitGraph(ctx, [[commit]]);

          // Act
          const first = await commitHeader(ctx, commit.id);
          const second = await commitHeader(ctx, commit.id);

          // Assert
          expect(second).toBe(first);
        });
      });
    });

    describe('Given the commit-graph read rejects transiently on the first attempt', () => {
      describe('When commitHeader is retried by a second, independent call', () => {
        it('Then the retry re-attempts the read instead of replaying the cached rejection', async () => {
          // Arrange — kills the no-op eviction-catch mutant: without evicting
          // the rejected promise from graphCache, every subsequent call
          // replays the SAME stale rejection forever, even after the
          // transient failure has cleared.
          const ctx = await buildSeededContext();
          const tree = await emptyTree(ctx);
          const commit = await makeCommit(ctx, tree, [], 1, 'solo');
          await writeCommitGraph(ctx, [[commit]]);
          const gitDir = commonGitDir(ctx);
          const graphPath = commitGraphPath(gitDir);
          let attempts = 0;
          const flaky = withFsOverride(ctx, {
            read: async (path) => {
              if (path === graphPath) {
                attempts += 1;
                if (attempts === 1) throw new TsgitError({ code: 'PERMISSION_DENIED', path });
              }
              return ctx.fs.read(path);
            },
          });

          // Act
          let firstError: unknown;
          try {
            await commitHeader(flaky, commit.id);
            expect.unreachable();
          } catch (error) {
            firstError = error;
          }
          await Promise.resolve();
          const second = await commitHeader(flaky, commit.id);

          // Assert
          expect((firstError as TsgitError).data.code).toBe('PERMISSION_DENIED');
          expect(second).toBeDefined();
          expect(second?.rootTree).toBe(commit.data.tree);
          expect(attempts).toBe(2);
        });
      });
    });

    describe('Given a single-file graph with an octopus merge whose EDGE chunk becomes unreadable after writing', () => {
      describe('When commitHeader is called for the merge commit', () => {
        it('Then the graph degrades to absent instead of throwing, and stays poisoned for later calls', async () => {
          // Arrange — a decode failure discovered mid-lookup (not at parse
          // time) must still be caught by commitHeader's own try/catch and
          // degrade the whole graph to absent for the rest of the lifetime.
          const ctx = await buildSeededContext();
          const tree = await emptyTree(ctx);
          const d0 = await makeCommit(ctx, tree, [], 1, 'd0');
          const d1 = await makeCommit(ctx, tree, [], 2, 'd1');
          const d2 = await makeCommit(ctx, tree, [], 3, 'd2');
          const d3 = await makeCommit(ctx, tree, [d0.id, d1.id, d2.id], 4, 'd3');
          await writeCommitGraph(ctx, [[d0, d1, d2, d3]]);
          const gitDir = commonGitDir(ctx);
          const graphPath = commitGraphPath(gitDir);
          const original = await ctx.fs.read(graphPath);
          await ctx.fs.write(graphPath, renameChunkRowId(original, 'EDGE', 'ZZZZ'));

          // Act
          const header = await commitHeader(ctx, d3.id);
          const secondHeader = await commitHeader(ctx, d3.id);

          // Assert
          expect(header).toBeUndefined();
          expect(secondHeader).toBeUndefined();
        });
      });

      describe('When a DIFFERENT, structurally-clean commit is looked up right after', () => {
        it('Then it ALSO comes back absent — the whole graph degrades, not just the failing entry', async () => {
          // Arrange — d0 is parentless: its own lookup never touches the
          // corrupt EDGE chunk at all, so it can only come back absent here
          // if the FIRST call's degrade actually poisoned the cached graph
          // object itself, rather than the graph staying cached (structurally
          // intact from d0's point of view) for a would-be-clean second read.
          const ctx = await buildSeededContext();
          const tree = await emptyTree(ctx);
          const d0 = await makeCommit(ctx, tree, [], 1, 'd0');
          const d1 = await makeCommit(ctx, tree, [], 2, 'd1');
          const d2 = await makeCommit(ctx, tree, [], 3, 'd2');
          const d3 = await makeCommit(ctx, tree, [d0.id, d1.id, d2.id], 4, 'd3');
          await writeCommitGraph(ctx, [[d0, d1, d2, d3]]);
          const gitDir = commonGitDir(ctx);
          const graphPath = commitGraphPath(gitDir);
          const original = await ctx.fs.read(graphPath);
          await ctx.fs.write(graphPath, renameChunkRowId(original, 'EDGE', 'ZZZZ'));

          // Act
          const header = await commitHeader(ctx, d3.id);
          const cleanHeader = await commitHeader(ctx, d0.id);

          // Assert
          expect(header).toBeUndefined();
          expect(cleanHeader).toBeUndefined();
        });
      });
    });

    describe('Given a single-file graph whose OIDF chunk table entry causes a genuine RangeError while parsing', () => {
      describe('When commitHeader is called for a real commit', () => {
        it('Then the graph degrades to absent instead of throwing', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const tree = await emptyTree(ctx);
          const commit = await makeCommit(ctx, tree, [], 1, 'solo');
          const gitDir = commonGitDir(ctx);
          await ctx.fs.write(commitGraphPath(gitDir), buildRangeErrorTriggeringGraphBytes());

          // Act
          const header = await commitHeader(ctx, commit.id);

          // Assert
          expect(header).toBeUndefined();
        });
      });
    });

    describe('Given a CDAT parent position far beyond every layer', () => {
      describe('When commitHeader is called for the commit that carries it', () => {
        it('Then the graph degrades to absent and the session records it, instead of reading past the OID table', async () => {
          // Arrange — git dies with `invalid parent position N`; tsgit's
          // documented posture for a graph that fails to decode is to answer
          // from objects for the rest of the session, so the position is
          // refused as a decode fault and the graph becomes absent.
          const ctx = await buildSeededContext();
          const tree = await emptyTree(ctx);
          const c0 = await makeCommit(ctx, tree, [], 1, 'c0');
          const c1 = await makeCommit(ctx, tree, [c0.id], 2, 'c1');
          await writeCommitGraph(ctx, [[c0, c1]]);
          const gitDir = commonGitDir(ctx);
          const graphPath = commitGraphPath(gitDir);
          const original = await ctx.fs.read(graphPath);
          await ctx.fs.write(graphPath, corruptFirstRealParent1Position(original, 0x6fffffff));

          // Act
          const header = await commitHeader(ctx, c1.id);

          // Assert
          expect(header).toBeUndefined();
          expect(isGraphKnownAbsent(ctx)).toBe(true);
        });
      });
    });

    describe('Given a CDAT parent position equal to the layer commit count (one past the last entry)', () => {
      describe('When commitHeader is called for the commit that carries it', () => {
        it('Then the graph degrades to absent rather than fabricating a parent from the bytes after the OID table', async () => {
          // Arrange — position == commitCount is the boundary that used to slip
          // through: the 20 bytes after OIDL are the first CDAT entry's root
          // tree, which came back as a "parent".
          const ctx = await buildSeededContext();
          const tree = await emptyTree(ctx);
          const c0 = await makeCommit(ctx, tree, [], 1, 'c0');
          const c1 = await makeCommit(ctx, tree, [c0.id], 2, 'c1');
          await writeCommitGraph(ctx, [[c0, c1]]);
          const gitDir = commonGitDir(ctx);
          const graphPath = commitGraphPath(gitDir);
          const original = await ctx.fs.read(graphPath);
          await ctx.fs.write(graphPath, corruptFirstRealParent1Position(original, 2));

          // Act
          const header = await commitHeader(ctx, c1.id);
          const walked: ObjectId[] = [];
          for await (const commit of walkCommits(ctx, { from: [c1.id] })) walked.push(commit.id);

          // Assert — no fabricated parent; the walk falls back to the bodies
          expect(header).toBeUndefined();
          expect(isGraphKnownAbsent(ctx)).toBe(true);
          expect(walked).toEqual([c1.id, c0.id]);
        });
      });
    });

    describe('Given a commit-graph covering an oid, with no .git/shallow file', () => {
      describe('When commitHeader is called for that oid', () => {
        it('Then it resolves the header from the graph (control — proves the shallow cases below are not vacuous)', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { c0, c1, c2, c3, c4 } = await buildFiveCommitHistory(ctx);
          await writeCommitGraph(ctx, [[c0, c1, c2, c3, c4]]);

          // Act
          const header = await commitHeader(ctx, c0.id);

          // Assert
          expect(header).toBeDefined();
        });
      });
    });

    describe('Given a commit-graph covering an oid, with a non-empty .git/shallow present', () => {
      describe('When commitHeader is called for that oid', () => {
        it('Then it returns undefined — the graph is ignored while a shallow file is present', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { c0, c1, c2, c3, c4 } = await buildFiveCommitHistory(ctx);
          await writeCommitGraph(ctx, [[c0, c1, c2, c3, c4]]);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${c3.id}\n`);

          // Act
          const header = await commitHeader(ctx, c0.id);

          // Assert
          expect(header).toBeUndefined();
        });
      });
    });

    describe('Given a commit-graph covering an oid, with a 0-byte .git/shallow present', () => {
      describe('When commitHeader is called for that oid', () => {
        it('Then it also returns undefined — presence, not content, gates the graph', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { c0, c1, c2, c3, c4 } = await buildFiveCommitHistory(ctx);
          await writeCommitGraph(ctx, [[c0, c1, c2, c3, c4]]);
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, '');

          // Act
          const header = await commitHeader(ctx, c0.id);

          // Assert
          expect(header).toBeUndefined();
        });
      });
    });
  });
});

describe('insertBounded', () => {
  describe('Given a map below its cap', () => {
    describe('When a new key is inserted', () => {
      it('Then the entry is added and nothing is evicted', () => {
        // Arrange
        const sut = insertBounded;
        const map = new Map<string, number>([['a', 1]]);

        // Act
        sut(map, 3, 'b', 2);

        // Assert
        expect([...map.entries()]).toEqual([
          ['a', 1],
          ['b', 2],
        ]);
      });
    });
  });

  describe('Given a map exactly at its cap', () => {
    describe('When a new key is inserted', () => {
      it('Then the oldest-inserted entry is evicted and the size stays at the cap', () => {
        // Arrange
        const sut = insertBounded;
        const map = new Map<string, number>([
          ['a', 1],
          ['b', 2],
        ]);

        // Act
        sut(map, 2, 'c', 3);

        // Assert
        expect(map.has('a')).toBe(false);
        expect([...map.entries()]).toEqual([
          ['b', 2],
          ['c', 3],
        ]);
      });
    });

    describe('When an existing key is overwritten', () => {
      it('Then no entry is evicted and the value is replaced in place', () => {
        // Arrange
        const sut = insertBounded;
        const map = new Map<string, number>([
          ['a', 1],
          ['b', 2],
        ]);

        // Act
        sut(map, 2, 'a', 9);

        // Assert
        expect([...map.entries()]).toEqual([
          ['a', 9],
          ['b', 2],
        ]);
      });
    });
  });

  describe('Given a map one below its cap', () => {
    describe('When a new key is inserted', () => {
      it('Then nothing is evicted — the boundary is at the cap, not below it', () => {
        // Arrange
        const sut = insertBounded;
        const map = new Map<string, number>([['a', 1]]);

        // Act
        sut(map, 2, 'b', 2);

        // Assert
        expect(map.size).toBe(2);
        expect(map.has('a')).toBe(true);
      });
    });
  });
});

describe('isGraphKnownAbsent', () => {
  describe('Given a session that has not probed for a graph yet', () => {
    describe('When asked whether the graph is known absent', () => {
      it('Then it is not — nothing has been probed', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = isGraphKnownAbsent;

        // Act
        const result = sut(ctx);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a repository with no commit-graph, When one header probe has run', () => {
    it('Then the session knows the graph is absent', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const tree = await emptyTree(ctx);
      const commit = await makeCommit(ctx, tree, [], 1, 'no-graph');
      await commitHeader(ctx, commit.id);
      const sut = isGraphKnownAbsent;

      // Act
      const result = sut(ctx);

      // Assert
      expect(result).toBe(true);
    });
  });

  describe('Given a repository with a commit-graph, When one header probe has run', () => {
    it('Then the session does not call the graph absent', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const tree = await emptyTree(ctx);
      const commit = await makeCommit(ctx, tree, [], 1, 'graphed');
      await writeCommitGraph(ctx, [[commit]]);
      await commitHeader(ctx, commit.id);
      const sut = isGraphKnownAbsent;

      // Act
      const result = sut(ctx);

      // Assert
      expect(result).toBe(false);
    });
  });
});
