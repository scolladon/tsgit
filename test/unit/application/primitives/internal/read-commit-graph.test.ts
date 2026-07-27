import { describe, expect, it } from 'vitest';
import { createCommit } from '../../../../../src/application/primitives/create-commit.js';
import { commitHeader } from '../../../../../src/application/primitives/internal/read-commit-graph.js';
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
});
