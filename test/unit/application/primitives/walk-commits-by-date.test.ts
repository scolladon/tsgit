import { describe, expect, it } from 'vitest';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { walkCommitsByDate } from '../../../../src/application/primitives/walk-commits-by-date.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type {
  AuthorIdentity,
  Commit,
  ObjectId,
  Tree,
} from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

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

  describe('Given a signal aborted between two yields', () => {
    describe('When walkCommitsByDate continues', () => {
      it('Then throws OPERATION_ABORTED at the next loop head', async () => {
        // Arrange — kills the loop-head `ctx.signal?.aborted` guard set to false.
        const ctx = await buildSeededContext();
        const ids = await linearChain(ctx, 3);
        const controller = new AbortController();
        const aborted = { ...ctx, signal: controller.signal };

        // Act & Assert
        const yielded: ObjectId[] = [];
        let caught: unknown;
        try {
          for await (const c of walkCommitsByDate(aborted, { from: [ids.at(-1)!] })) {
            yielded.push(c.id);
            controller.abort();
          }
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        expect(yielded).toEqual([ids.at(-1)]);
        expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
      });
    });
  });
});
