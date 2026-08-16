import { describe, expect, it } from 'vitest';
import { createCommit } from '../../../../../src/application/primitives/create-commit.js';
import { commitHeader } from '../../../../../src/application/primitives/internal/read-commit-graph.js';
import {
  commitGraphChainPath,
  commitGraphPath,
  commonGitDir,
} from '../../../../../src/application/primitives/path-layout.js';
import { readObject } from '../../../../../src/application/primitives/read-object.js';
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
          // fallback (never a memoized rejection poisoning later walks)
          expect(header).toBeUndefined();
          expect(secondHeader).toBeUndefined();
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
            expect(header).toEqual(firstPass[i]);
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

          // Act — c4's header has never been computed, so it is a cache miss.
          const header = await commitHeader(ctx, c4.id);

          // Assert
          expectHeaderMatchesCommit(header, c4);
          const graphReads = calls().filter(
            (call) => call.method === 'read' && call.path.includes('commit-graph'),
          );
          expect(graphReads.length).toBe(1);
        });
      });
    });

    describe('Given an oid absent from the graph', () => {
      describe('When commitHeader is called for it twice', () => {
        it('Then both calls return undefined — the uncached-miss asymmetry holds across repeat calls', async () => {
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

    describe('Given a CDAT parent position that resolves to an out-of-range oid lookup', () => {
      describe('When commitHeader is called for the commit that carries it', () => {
        it('Then the resulting (non-decode-failure) error propagates instead of degrading to absent', async () => {
          // Arrange — a globalPos far beyond any layer's real coverage still
          // "matches" the base layer (layerOffsets[0]===0), so
          // findLayerForGlobalPosition returns a wildly out-of-range localPos;
          // reading its oid clamps to an empty slice, and ObjectId.fromRaw
          // rejects it with INVALID_OBJECT_ID — a code that does NOT start
          // with INVALID_COMMIT_GRAPH, so it must propagate, not be swallowed.
          const ctx = await buildSeededContext();
          const tree = await emptyTree(ctx);
          const c0 = await makeCommit(ctx, tree, [], 1, 'c0');
          const c1 = await makeCommit(ctx, tree, [c0.id], 2, 'c1');
          await writeCommitGraph(ctx, [[c0, c1]]);
          const gitDir = commonGitDir(ctx);
          const graphPath = commitGraphPath(gitDir);
          const original = await ctx.fs.read(graphPath);
          await ctx.fs.write(graphPath, corruptFirstRealParent1Position(original, 0x6fffffff));

          // Act + Assert
          try {
            await commitHeader(ctx, c1.id);
            expect.unreachable();
          } catch (error) {
            expect((error as TsgitError).data.code).toBe('INVALID_OBJECT_ID');
          }
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
