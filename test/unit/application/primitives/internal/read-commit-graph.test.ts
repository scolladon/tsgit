import { describe, expect, it } from 'vitest';
import { createCommit } from '../../../../../src/application/primitives/create-commit.js';
import {
  commitHeader,
  createBoundedReader,
} from '../../../../../src/application/primitives/internal/read-commit-graph.js';
import {
  commitGraphChainPath,
  commonGitDir,
} from '../../../../../src/application/primitives/path-layout.js';
import { readObject } from '../../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type {
  AuthorIdentity,
  Commit,
  ObjectId,
  Tree,
} from '../../../../../src/domain/objects/index.js';
import { buildSeededContext, instrumentedContext, writeCommitGraph } from '../fixtures.js';

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
  });

  describe('createBoundedReader', () => {
    describe('Given a bound of 2 and 5 ids started without awaiting between them', () => {
      describe('When every read is eventually awaited', () => {
        it('Then concurrent in-flight reads never exceed the bound', async () => {
          // Arrange
          let active = 0;
          let maxActive = 0;
          const read = async (id: ObjectId): Promise<ObjectId> => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
            active -= 1;
            return id;
          };
          const boundedRead = createBoundedReader(2, read);
          const ids = [
            '1'.repeat(40),
            '2'.repeat(40),
            '3'.repeat(40),
            '4'.repeat(40),
            '5'.repeat(40),
          ].map((hex) => hex as ObjectId);

          // Act
          const promises = ids.map((id) => boundedRead.start(id));
          await Promise.all(promises);

          // Assert
          expect(maxActive).toBeLessThanOrEqual(2);
        });
      });
    });

    describe('Given the same id started twice before either resolves', () => {
      describe('When both calls are awaited', () => {
        it('Then the underlying read runs exactly once and both see its result', async () => {
          // Arrange
          let callCount = 0;
          const read = async (id: ObjectId): Promise<ObjectId> => {
            callCount += 1;
            await Promise.resolve();
            return id;
          };
          const boundedRead = createBoundedReader(4, read);
          const id = 'a'.repeat(40) as ObjectId;

          // Act
          const first = boundedRead.start(id);
          const second = boundedRead.start(id);
          const [firstResult, secondResult] = await Promise.all([first, second]);

          // Assert
          expect(callCount).toBe(1);
          expect(firstResult).toBe(id);
          expect(secondResult).toBe(id);
        });
      });
    });

    describe('Given a read that rejects', () => {
      describe('When the rejection is never synchronously awaited by the starter', () => {
        it('Then a later await on the same promise still observes the rejection', async () => {
          // Arrange — pins the unhandled-rejection-safe fire-and-forget contract:
          // `start` must not swallow the error for a real awaiter.
          const read = async (): Promise<never> => {
            throw new Error('boom');
          };
          const boundedRead = createBoundedReader(1, read);
          const id = 'b'.repeat(40) as ObjectId;

          // Act
          boundedRead.start(id); // fire-and-forget, exactly as a prefetching walk would
          let caught: unknown;
          try {
            await boundedRead.start(id);
          } catch (error) {
            caught = error;
          }

          // Assert
          expect(caught).toBeInstanceOf(Error);
          expect((caught as Error).message).toBe('boom');
        });
      });
    });
  });
});
