import { describe, expect, it } from 'vitest';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import {
  commitGraphChainPath,
  commonGitDir,
} from '../../../../src/application/primitives/path-layout.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { walkCommitsByDate } from '../../../../src/application/primitives/walk-commits-by-date.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type {
  AuthorIdentity,
  Commit,
  ObjectId,
  Tree,
} from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext, instrumentedContext, writeCommitGraph } from './fixtures.js';

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

async function linearChain(
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  n: number,
): Promise<ObjectId[]> {
  const treeId = await emptyTree(ctx);
  const ids: ObjectId[] = [];
  let parent: ObjectId[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = await createCommit(ctx, {
      tree: treeId,
      parents: parent,
      author: { ...AUTHOR, timestamp: 1700000000 + i },
      committer: { ...AUTHOR, timestamp: 1700000000 + i },
      message: `c${i}`,
    });
    ids.push(id);
    parent = [id];
  }
  return ids;
}

async function buildDiamond(
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
): Promise<{ a: ObjectId; b: ObjectId; c: ObjectId; d: ObjectId }> {
  const treeId = await emptyTree(ctx);
  const commit = async (msg: string, ts: number, parents: ObjectId[]): Promise<ObjectId> =>
    createCommit(ctx, {
      tree: treeId,
      parents,
      author: { ...AUTHOR, timestamp: ts },
      committer: { ...AUTHOR, timestamp: ts },
      message: msg,
    });
  const a = await commit('a', 1, []);
  const b = await commit('b', 2, [a]);
  const c = await commit('c', 3, [a]);
  const d = await commit('d', 4, [b, c]);
  return { a, b, c, d };
}

async function collect(iter: AsyncIterable<Commit>): Promise<Commit[]> {
  const out: Commit[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

const idsOf = (commits: ReadonlyArray<Commit>): ObjectId[] => commits.map((c) => c.id);

async function asCommits(ctx: Context, ids: ReadonlyArray<ObjectId>): Promise<Commit[]> {
  const commits: Commit[] = [];
  for (const id of ids) {
    const object = await readObject(ctx, id);
    if (object.type !== 'commit') throw new Error('expected a commit');
    commits.push(object);
  }
  return commits;
}

describe('walkCommitsByDate', () => {
  describe('Given empty from', () => {
    describe('When walkCommitsByDate is called', () => {
      it('Then throws INVALID_WALK_INPUT', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act & Assert
        try {
          for await (const _ of walkCommitsByDate(ctx, { from: [] })) void _;
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('INVALID_WALK_INPUT');
        }
      });
    });
  });

  describe('Given from.length > MAX_WALK_SEEDS', () => {
    describe('When walkCommitsByDate is called', () => {
      it('Then throws INVALID_WALK_INPUT /too many/', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const seeds = Array.from(
          { length: 1025 },
          (_, i) => i.toString().padStart(40, '0') as ObjectId,
        );

        // Act & Assert
        try {
          for await (const _ of walkCommitsByDate(ctx, { from: seeds })) void _;
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('INVALID_WALK_INPUT');
          expect((error as TsgitError).data).toEqual(
            expect.objectContaining({ reason: expect.stringMatching(/too many/) }),
          );
        }
      });
    });
  });

  describe('Given from.length exactly 1024 (at cap)', () => {
    describe('When walkCommitsByDate is called', () => {
      it('Then passes validation and surfaces OBJECT_NOT_FOUND from the first read', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const seeds = Array.from(
          { length: 1024 },
          (_, i) => i.toString(16).padStart(40, '0') as ObjectId,
        );

        // Act & Assert — at-cap seeds pass validation (kills `>` → `>=`), then the
        // first eager read fails because the seeds are synthetic.
        let caught: unknown;
        try {
          for await (const _ of walkCommitsByDate(ctx, { from: seeds })) void _;
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        expect((caught as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
      });
    });
  });

  describe('Given a linear 5-commit chain', () => {
    describe('When walkCommitsByDate is called from head', () => {
      it('Then yields all five newest-commit-date first', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await linearChain(ctx, 5);

        // Act
        const commits = await collect(walkCommitsByDate(ctx, { from: [ids.at(-1)!] }));

        // Assert
        expect(idsOf(commits)).toEqual([...ids].reverse());
      });
    });
  });

  describe('Given a diamond DAG with strictly increasing dates', () => {
    describe('When walkCommitsByDate is called from the merge', () => {
      it('Then yields all parents in exact newest-date order [d, c, b, a]', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { a, b, c, d } = await buildDiamond(ctx);

        // Act
        const commits = await collect(walkCommitsByDate(ctx, { from: [d] }));

        // Assert — a topo/FIFO mutant would yield [d, b, c, a].
        expect(idsOf(commits)).toEqual([d, c, b, a]);
      });
    });
  });

  describe('Given two roots with equal committer dates', () => {
    describe('When walkCommitsByDate is called from both', () => {
      it('Then they pop in oid-ascending order', async () => {
        // Arrange — same timestamp, different messages → different oids.
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const mkRoot = (message: string): Promise<ObjectId> =>
          createCommit(ctx, {
            tree: treeId,
            parents: [],
            author: { ...AUTHOR, timestamp: 1700000123 },
            committer: { ...AUTHOR, timestamp: 1700000123 },
            message,
          });
        const r1 = await mkRoot('first root');
        const r2 = await mkRoot('second root');
        const [lower, higher] = r1 < r2 ? [r1, r2] : [r2, r1];

        // Act
        const commits = await collect(walkCommitsByDate(ctx, { from: [r1, r2] }));

        // Assert — kills the `a.oid < b.oid` tie-break mutant.
        expect(idsOf(commits)).toEqual([lower, higher]);
      });
    });
  });

  describe('Given a diamond reached from the merge', () => {
    describe('When walkCommitsByDate is called', () => {
      it('Then the shared base appears exactly once', async () => {
        // Arrange — isolates seen.has(parent)=true / until.has(parent)=false.
        const ctx = await buildSeededContext();
        const { a, d } = await buildDiamond(ctx);

        // Act
        const commits = await collect(walkCommitsByDate(ctx, { from: [d] }));

        // Assert
        expect(idsOf(commits).filter((id) => id === a)).toEqual([a]);
      });
    });
  });

  describe('Given a duplicate seed', () => {
    describe('When walkCommitsByDate is called', () => {
      it('Then it is yielded exactly once', async () => {
        // Arrange — pins the deduped seed iteration (raw-from would yield twice).
        const ctx = await buildSeededContext();
        const [root] = await linearChain(ctx, 1);

        // Act
        const commits = await collect(walkCommitsByDate(ctx, { from: [root!, root!] }));

        // Assert
        expect(idsOf(commits)).toEqual([root]);
      });
    });
  });

  describe('Given a seed that is also an ancestor of another seed', () => {
    describe('When walkCommitsByDate is called', () => {
      it('Then the shared ancestor is yielded once', async () => {
        // Arrange — from=[merge, base]; pins `new Set(options.from)` seeding.
        const ctx = await buildSeededContext();
        const { a, d } = await buildDiamond(ctx);

        // Act
        const commits = await collect(walkCommitsByDate(ctx, { from: [d, a] }));

        // Assert
        expect(idsOf(commits).filter((id) => id === a)).toEqual([a]);
      });
    });
  });

  describe('Given until=[base]', () => {
    describe('When walkCommitsByDate reaches the base as a parent', () => {
      it('Then the base is excluded', async () => {
        // Arrange — isolates until.has(parent)=true / seen.has(parent)=false.
        const ctx = await buildSeededContext();
        const { a, b, c, d } = await buildDiamond(ctx);

        // Act
        const commits = await collect(walkCommitsByDate(ctx, { from: [d], until: [a] }));

        // Assert
        expect(idsOf(commits)).toEqual([d, c, b]);
      });
    });
  });

  describe('Given a seed listed in until', () => {
    describe('When the seed oid is missing and ignoreMissing is false', () => {
      it('Then it is neither read nor yielded (no throw)', async () => {
        // Arrange — the until-gate must fire before the eager read; a read-then-skip
        // impl would throw OBJECT_NOT_FOUND on the synthetic oid.
        const ctx = await buildSeededContext();
        const missingId = 'f'.repeat(40) as ObjectId;

        // Act
        const commits = await collect(
          walkCommitsByDate(ctx, { from: [missingId], until: [missingId] }),
        );

        // Assert
        expect(commits).toEqual([]);
      });
    });
  });

  describe('Given shallow={tip}', () => {
    describe('When walkCommitsByDate is called from tip', () => {
      it('Then only the tip is yielded', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await linearChain(ctx, 4);
        const tip = ids.at(-1)!;

        // Act
        const commits = await collect(
          walkCommitsByDate(ctx, { from: [tip], shallow: new Set([tip]) }),
        );

        // Assert
        expect(idsOf(commits)).toEqual([tip]);
      });
    });
  });

  describe('Given a hand-written .git/shallow file and no shallow option', () => {
    describe('When walkCommitsByDate is called from tip', () => {
      it('Then the walk auto-loads the file and stops at the boundary', async () => {
        // Arrange — linear chain of 4; .git/shallow names the second-from-tip.
        const ctx = await buildSeededContext();
        const ids = await linearChain(ctx, 4);
        const tip = ids.at(-1)!;
        const boundary = ids.at(-2)!;
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${boundary}\n`);

        // Act — no `shallow` option at all.
        const commits = await collect(walkCommitsByDate(ctx, { from: [tip] }));

        // Assert
        expect(idsOf(commits)).toEqual([tip, boundary]);
      });
    });
  });

  describe('Given a .git/shallow file and an explicit empty override', () => {
    describe('When walkCommitsByDate is called from tip', () => {
      it('Then the caller-supplied empty set wins and the walk is not stopped', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await linearChain(ctx, 4);
        const tip = ids.at(-1)!;
        const boundary = ids.at(-2)!;
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${boundary}\n`);

        // Act
        const commits = await collect(
          walkCommitsByDate(ctx, { from: [tip], shallow: new Set<ObjectId>() }),
        );

        // Assert — the escape hatch: repository state is not consulted.
        expect(idsOf(commits).length).toBe(4);
      });
    });
  });

  describe('Given an auto-loaded shallow boundary', () => {
    describe('When the boundary commit is yielded', () => {
      it('Then its reported parents are empty, not just skipped from the frontier', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await linearChain(ctx, 4);
        const tip = ids.at(-1)!;
        const boundary = ids.at(-2)!;
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/shallow`, `${boundary}\n`);

        // Act
        const commits = await collect(walkCommitsByDate(ctx, { from: [tip] }));

        // Assert — the yielded object is grafted, not merely frontier-skipped.
        const boundaryCommit = commits.find((c) => c.id === boundary);
        expect(boundaryCommit?.data.parents).toEqual([]);
      });
    });
  });

  describe('Given ignoreMissing=true and a missing parent', () => {
    describe('When walkCommitsByDate is called', () => {
      it('Then the child is yielded without error', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const missingId = 'f'.repeat(40) as ObjectId;
        const child = await createCommit(ctx, {
          tree: treeId,
          parents: [missingId],
          author: AUTHOR,
          committer: AUTHOR,
          message: 'child of missing parent',
        });

        // Act
        const commits = await collect(
          walkCommitsByDate(ctx, { from: [child], ignoreMissing: true }),
        );

        // Assert
        expect(idsOf(commits)).toEqual([child]);
      });
    });
  });

  describe('Given ignoreMissing=false and a missing parent', () => {
    describe('When walkCommitsByDate is called', () => {
      it('Then throws OBJECT_NOT_FOUND', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const missingId = 'f'.repeat(40) as ObjectId;
        const child = await createCommit(ctx, {
          tree: treeId,
          parents: [missingId],
          author: AUTHOR,
          committer: AUTHOR,
          message: 'child of missing parent',
        });

        // Act & Assert
        try {
          for await (const _ of walkCommitsByDate(ctx, { from: [child] })) void _;
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
        }
      });
    });
  });

  describe('Given a non-commit seed', () => {
    describe('When walkCommitsByDate is called', () => {
      it('Then the seed is skipped (zero commits)', async () => {
        // Arrange — a tree oid is not a commit.
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);

        // Act
        const commits = await collect(walkCommitsByDate(ctx, { from: [treeId] }));

        // Assert
        expect(commits).toEqual([]);
      });
    });
  });

  describe('Given a corrupted loose object and default verifyHash', () => {
    describe('When walkCommitsByDate is iterated', () => {
      it('Then throws OBJECT_HASH_MISMATCH', async () => {
        // Arrange — kills the `verifyHash ?? true` default → false mutant.
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const commitId = await createCommit(ctx, {
          tree: treeId,
          parents: [],
          author: AUTHOR,
          committer: AUTHOR,
          message: 'original',
        });
        const { computeLooseObjectPath } = await import(
          '../../../../src/domain/storage/loose-path.js'
        );
        const bogus = new TextEncoder().encode('commit 3\0xyz');
        const compressed = await ctx.compressor.deflate(bogus);
        await ctx.fs.write(
          `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(commitId)}`,
          compressed,
        );

        // Act & Assert
        try {
          for await (const _ of walkCommitsByDate(ctx, { from: [commitId] })) void _;
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('OBJECT_HASH_MISMATCH');
        }
      });
    });
  });

  describe('Given verifyHash=false and a loose file whose bytes belong to a different commit', () => {
    describe('When walkCommitsByDate is iterated', () => {
      it('Then the walk succeeds and parses the impostor commit', async () => {
        // Arrange — covers the non-nullish verifyHash branch (explicit false).
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const commitA = await createCommit(ctx, {
          tree: treeId,
          parents: [],
          author: AUTHOR,
          committer: AUTHOR,
          message: 'original',
        });
        const commitB = await createCommit(ctx, {
          tree: treeId,
          parents: [],
          author: { ...AUTHOR, timestamp: AUTHOR.timestamp + 1 },
          committer: { ...AUTHOR, timestamp: AUTHOR.timestamp + 1 },
          message: 'impostor',
        });
        const { computeLooseObjectPath } = await import(
          '../../../../src/domain/storage/loose-path.js'
        );
        const aPath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(commitA)}`;
        const bPath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(commitB)}`;
        await ctx.fs.write(aPath, await ctx.fs.read(bPath));

        // Act
        const commits = await collect(
          walkCommitsByDate(ctx, { from: [commitA], verifyHash: false }),
        );

        // Assert
        expect(commits[0]?.data.message).toMatch(/impostor/);
      });
    });
  });

  describe('Given an already-aborted signal', () => {
    describe('When walkCommitsByDate is iterated', () => {
      it('Then yields zero commits and throws OPERATION_ABORTED', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const [id] = await linearChain(ctx, 1);
        const controller = new AbortController();
        controller.abort();
        const aborted = { ...ctx, signal: controller.signal };

        // Act & Assert
        const yielded: ObjectId[] = [];
        let caught: unknown;
        try {
          for await (const c of walkCommitsByDate(aborted, { from: [id!] })) yielded.push(c.id);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        expect(yielded).toEqual([]);
        expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
      });
    });
  });

  describe('Given a signal aborted after yielding a parentless seed with another seed queued', () => {
    describe('When walkCommitsByDate reaches the next loop head', () => {
      it('Then throws OPERATION_ABORTED without reading further', async () => {
        // Arrange — two parentless roots, so the next loop head is reached with NO
        // intervening read. This isolates the loop-head `ctx.signal?.aborted`
        // guard: during parent expansion readObject's own abort check would mask
        // it, but a parentless commit triggers no read before the guard fires.
        const ctx = await buildSeededContext();
        const treeId = await emptyTree(ctx);
        const mkRoot = (ts: number, message: string): Promise<ObjectId> =>
          createCommit(ctx, {
            tree: treeId,
            parents: [],
            author: { ...AUTHOR, timestamp: ts },
            committer: { ...AUTHOR, timestamp: ts },
            message,
          });
        const newer = await mkRoot(1700000200, 'newer root');
        const older = await mkRoot(1700000100, 'older root');
        const controller = new AbortController();
        const aborted = { ...ctx, signal: controller.signal };

        // Act & Assert
        const yielded: ObjectId[] = [];
        let caught: unknown;
        try {
          for await (const c of walkCommitsByDate(aborted, { from: [newer, older] })) {
            yielded.push(c.id);
            controller.abort();
          }
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        expect(yielded).toEqual([newer]);
        expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
      });
    });
  });

  describe('commit-graph integration', () => {
    describe('Given a single-file commit-graph covering the whole diamond', () => {
      describe('When walkCommitsByDate is called from the merge', () => {
        it('Then the yielded set/order is identical to the graph-absent walk', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { a, b, c, d } = await buildDiamond(ctx);
          const baseline = await collect(walkCommitsByDate(ctx, { from: [d] }));
          await writeCommitGraph(ctx, [await asCommits(ctx, [a, b, c, d])]);

          // Act
          const withGraph = await collect(walkCommitsByDate(ctx, { from: [d] }));

          // Assert
          expect(idsOf(withGraph)).toEqual(idsOf(baseline));
        });
      });
    });

    describe('Given a chain/split graph covering the whole diamond (base=[a,b], tip=[c,d])', () => {
      describe('When walkCommitsByDate is called from the merge', () => {
        it('Then the yielded set/order is identical to the graph-absent walk', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const { a, b, c, d } = await buildDiamond(ctx);
          const baseline = await collect(walkCommitsByDate(ctx, { from: [d] }));
          const commits = await asCommits(ctx, [a, b, c, d]);
          await writeCommitGraph(ctx, [
            commits.filter((commit) => commit.id === a || commit.id === b),
            commits.filter((commit) => commit.id === c || commit.id === d),
          ]);

          // Act
          const withGraph = await collect(walkCommitsByDate(ctx, { from: [d] }));

          // Assert
          expect(idsOf(withGraph)).toEqual(idsOf(baseline));
        });
      });
    });

    describe('Given a graph covering a 3-chain whose middle commit object was removed', () => {
      describe('When walkCommitsByDate is called from the tip with ignoreMissing', () => {
        it('Then the missing commit and its ancestors are not walked (stale header never enters the heap)', async () => {
          // Arrange — the graph still names B (and its parent A) but B's body
          // is gone; a header-dated heap push must not admit it or A
          const ctx = await buildSeededContext();
          const ids = await linearChain(ctx, 3);
          await writeCommitGraph(ctx, [await asCommits(ctx, ids)]);
          const missingId = ids[1]!;
          const { computeLooseObjectPath } = await import(
            '../../../../src/domain/storage/loose-path.js'
          );
          await ctx.fs.rm(`${ctx.layout.gitDir}/objects/${computeLooseObjectPath(missingId)}`);

          // Act
          const result = await collect(
            walkCommitsByDate(ctx, { from: [ids[2]!], ignoreMissing: true }),
          );

          // Assert
          expect(idsOf(result)).toEqual([ids[2]!]);
        });
      });
    });

    describe('Given a chain/split graph whose most-recent layer file was deleted', () => {
      describe('When walkCommitsByDate is called', () => {
        it('Then it falls back to object reads and yields the correct result', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const ids = await linearChain(ctx, 5);
          const baseline = await collect(walkCommitsByDate(ctx, { from: [ids.at(-1)!] }));
          const commits = await asCommits(ctx, ids);
          await writeCommitGraph(ctx, [commits.slice(0, 3), commits.slice(3)]);
          const gitDir = commonGitDir(ctx);
          const chainText = await ctx.fs.readUtf8(commitGraphChainPath(gitDir));
          const tipHash = chainText.trim().split('\n').at(-1)!;
          await ctx.fs.rm(`${gitDir}/objects/info/commit-graphs/graph-${tipHash}.graph`);

          // Act
          const withStaleGraph = await collect(walkCommitsByDate(ctx, { from: [ids.at(-1)!] }));

          // Assert
          expect(idsOf(withStaleGraph)).toEqual(idsOf(baseline));
        });
      });
    });

    describe('Given a commit-graph consulted across two separate walkCommitsByDate invocations', () => {
      describe('When both walks target the same Context', () => {
        it('Then the graph file is read only once', async () => {
          // Arrange
          const base = await buildSeededContext();
          const ids = await linearChain(base, 3);
          await writeCommitGraph(base, [await asCommits(base, ids)]);
          const { ctx, calls } = instrumentedContext(base);

          // Act
          await collect(walkCommitsByDate(ctx, { from: [ids.at(-1)!] }));
          await collect(walkCommitsByDate(ctx, { from: [ids.at(-1)!] }));

          // Assert
          const graphReads = calls().filter(
            (call) => call.method === 'read' && call.path.includes('commit-graph'),
          );
          expect(graphReads.length).toBe(1);
        });
      });
    });

    describe('Given an octopus merge with 5 graph-covered parents and a concurrency bound of 2', () => {
      describe('When walkCommitsByDate is called', () => {
        it('Then concurrent loose-object body reads never exceed the bound', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const treeId = await emptyTree(ctx);
          const parents: ObjectId[] = [];
          for (let i = 0; i < 5; i += 1) {
            parents.push(
              await createCommit(ctx, {
                tree: treeId,
                parents: [],
                author: { ...AUTHOR, timestamp: 1700000000 + i },
                committer: { ...AUTHOR, timestamp: 1700000000 + i },
                message: `root-${i}`,
              }),
            );
          }
          const merge = await createCommit(ctx, {
            tree: treeId,
            parents,
            author: { ...AUTHOR, timestamp: 1700000100 },
            committer: { ...AUTHOR, timestamp: 1700000100 },
            message: 'octopus',
          });
          await writeCommitGraph(ctx, [await asCommits(ctx, [...parents, merge])]);

          let active = 0;
          let maxActive = 0;
          const LOOSE_OBJECT_PATH = /\/objects\/[0-9a-f]{2}\//;
          const bounded: Context = {
            ...ctx,
            config: { parallelism: 2 },
            fs: {
              ...ctx.fs,
              read: async (path: string) => {
                if (!LOOSE_OBJECT_PATH.test(path)) return ctx.fs.read(path);
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise<void>((resolve) => setTimeout(resolve, 5));
                const result = await ctx.fs.read(path);
                active -= 1;
                return result;
              },
            },
          };

          // Act
          const commits = await collect(walkCommitsByDate(bounded, { from: [merge] }));

          // Assert
          expect(commits.length).toBe(6);
          expect(maxActive).toBeLessThanOrEqual(2);
        });
      });
    });
  });
});
