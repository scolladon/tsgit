import { describe, expect, it } from 'vitest';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { MAX_WALK_QUEUE_SIZE } from '../../../../src/application/primitives/types.js';
import { walkCommits } from '../../../../src/application/primitives/walk-commits.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
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

async function linearChain(
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  n: number,
): Promise<ObjectId[]> {
  const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
  const treeId = await writeObject(ctx, tree);
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
  const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
  const treeId = await writeObject(ctx, tree);
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

describe('walkCommits', () => {
  it('Given empty from, When walkCommits is called, Then throws INVALID_WALK_INPUT', async () => {
    const ctx = await buildSeededContext();
    try {
      for await (const _ of walkCommits(ctx, { from: [] })) void _;
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('INVALID_WALK_INPUT');
    }
  });

  it('Given from.length > MAX_WALK_SEEDS, When walkCommits is called, Then throws INVALID_WALK_INPUT /too many/', async () => {
    const ctx = await buildSeededContext();
    const seeds = Array.from(
      { length: 1025 },
      (_, i) => i.toString().padStart(40, '0') as ObjectId,
    );
    try {
      for await (const _ of walkCommits(ctx, { from: seeds })) void _;
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('INVALID_WALK_INPUT');
    }
  });

  it('Given from.length exactly 1024 (at cap), When walkCommits is called, Then passes validation and surfaces OBJECT_NOT_FOUND from the first read', async () => {
    const ctx = await buildSeededContext();
    const seeds = Array.from(
      { length: 1024 },
      (_, i) => i.toString(16).padStart(40, '0') as ObjectId,
    );
    let caught: unknown;
    try {
      for await (const _ of walkCommits(ctx, { from: seeds })) void _;
      expect.unreachable();
    } catch (error) {
      caught = error;
    }
    // Validation accepts at-cap seeds (kills `>` → `>=` boundary mutants).
    // The first read then fails because the seeds are synthetic — proving the
    // walk loop actually entered, not that validation silently swallowed.
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
  });

  it('Given a single-commit walk, When walkCommits is called, Then yields one commit then ends', async () => {
    const ctx = await buildSeededContext();
    const [rootId] = await linearChain(ctx, 1);
    const commits = await collect(walkCommits(ctx, { from: [rootId!] }));
    expect(commits.length).toBe(1);
  });

  it('Given a linear 5-commit chain, When walkCommits is called from head, Then yields 5 commits', async () => {
    const ctx = await buildSeededContext();
    const ids = await linearChain(ctx, 5);
    const commits = await collect(walkCommits(ctx, { from: [ids.at(-1)!] }));
    expect(commits.length).toBe(5);
  });

  it('Given until=[rootId], When walkCommits reaches root, Then excludes it', async () => {
    const ctx = await buildSeededContext();
    const ids = await linearChain(ctx, 3);
    const [rootId, , headId] = ids;
    const commits = await collect(walkCommits(ctx, { from: [headId!], until: [rootId!] }));
    expect(commits.length).toBe(2);
  });

  it('Given ignoreMissing=true and a missing parent, When walkCommits is called, Then child is yielded without error', async () => {
    const ctx = await buildSeededContext();
    const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
    const treeId = await writeObject(ctx, tree);
    const missingId = 'f'.repeat(40) as ObjectId;
    const childId = await createCommit(ctx, {
      tree: treeId,
      parents: [missingId],
      author: AUTHOR,
      committer: AUTHOR,
      message: 'shallow child',
    });
    const commits = await collect(walkCommits(ctx, { from: [childId], ignoreMissing: true }));
    expect(commits.length).toBe(1);
  });

  it('Given ignoreMissing=false and a missing parent, When walkCommits is called, Then throws OBJECT_NOT_FOUND', async () => {
    const ctx = await buildSeededContext();
    const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
    const treeId = await writeObject(ctx, tree);
    const missingId = 'f'.repeat(40) as ObjectId;
    const childId = await createCommit(ctx, {
      tree: treeId,
      parents: [missingId],
      author: AUTHOR,
      committer: AUTHOR,
      message: 'shallow child',
    });
    try {
      for await (const _ of walkCommits(ctx, { from: [childId] })) void _;
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
    }
  });

  it('Given an aborted signal, When walkCommits is iterated, Then throws OPERATION_ABORTED', async () => {
    const ctx = await buildSeededContext();
    const [id] = await linearChain(ctx, 1);
    const controller = new AbortController();
    controller.abort();
    const aborted = { ...ctx, signal: controller.signal };
    try {
      for await (const _ of walkCommits(aborted, { from: [id!] })) void _;
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('OPERATION_ABORTED');
    }
  });

  it('Given a diamond DAG (A→B,C and B,C→D), When walkCommits is called from D, Then every ancestor appears exactly once', async () => {
    const ctx = await buildSeededContext();
    const { a, b, c, d } = await buildDiamond(ctx);
    const commits = await collect(walkCommits(ctx, { from: [d] }));
    const ids = commits.map((c0) => c0.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
    expect(ids).toContain(c);
    expect(ids).toContain(d);
    expect(ids[0]).toBe(d);
  });

  it('Given a diamond DAG, When walkCommits is called with the default topo order, Then children precede their parents', async () => {
    // Kills any mutant that degrades ordering below the topo contract (e.g.
    // enqueueParents swapped with dequeue-head semantics). Asserts the
    // positional invariant rather than exact sequence so equivalent topo
    // linearizations pass.
    const ctx = await buildSeededContext();
    const { a, b, c, d } = await buildDiamond(ctx);
    const commits = await collect(walkCommits(ctx, { from: [d] }));
    const indexOf = (id: ObjectId) => commits.findIndex((x) => x.id === id);
    // D is the seed — it must come first.
    expect(indexOf(d)).toBe(0);
    // Both B and C must come before A (their shared parent).
    expect(indexOf(b)).toBeLessThan(indexOf(a));
    expect(indexOf(c)).toBeLessThan(indexOf(a));
    // B and C are children of D, so they must come after D.
    expect(indexOf(b)).toBeGreaterThan(indexOf(d));
    expect(indexOf(c)).toBeGreaterThan(indexOf(d));
  });

  it('Given a diamond and order=first-parent, When walkCommits is called from D, Then the C branch is NOT visited', async () => {
    // Kills the ternary that chooses [parents[0]] vs all parents for first-parent.
    const ctx = await buildSeededContext();
    const { a, b, c, d } = await buildDiamond(ctx);
    const commits = await collect(walkCommits(ctx, { from: [d], order: 'first-parent' }));
    const ids = commits.map((c0) => c0.id);
    // First-parent from D: D → B → A. C is the second parent of D, excluded.
    expect(ids).toContain(d);
    expect(ids).toContain(b);
    expect(ids).toContain(a);
    expect(ids).not.toContain(c);
  });

  it('Given a corrupted loose object and default verifyHash, When walkCommits is iterated, Then throws OBJECT_HASH_MISMATCH', async () => {
    // Kills the `options.verifyHash ?? true` BooleanLiteral mutant to `false`:
    // default must be true, otherwise a hash-mismatched object would be yielded
    // silently.
    const ctx = await buildSeededContext();
    // Build a valid commit, then overwrite its loose file with different content.
    const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
    const treeId = await writeObject(ctx, tree);
    const commitId = await createCommit(ctx, {
      tree: treeId,
      parents: [],
      author: AUTHOR,
      committer: AUTHOR,
      message: 'original',
    });
    // Now corrupt the commit's loose file.
    const { computeLooseObjectPath } = await import('../../../../src/domain/storage/loose-path.js');
    const bogus = new TextEncoder().encode('commit 3\0xyz');
    const compressed = await ctx.compressor.deflate(bogus);
    await ctx.fs.write(
      `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(commitId)}`,
      compressed,
    );
    try {
      for await (const _ of walkCommits(ctx, { from: [commitId] })) void _;
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('OBJECT_HASH_MISMATCH');
    }
  });

  it('Given verifyHash=false and a loose file whose bytes belong to a DIFFERENT commit, When walkCommits is iterated, Then the walk succeeds (threaded verifyHash=false skips hash check)', async () => {
    // Kills the `{ verifyHash }` ObjectLiteral `{}` mutant: under `{}`,
    // readObject defaults to verifyHash=true and would throw OBJECT_HASH_MISMATCH
    // before yielding, whereas the correct code forwards verifyHash=false and
    // parses the impostor commit bytes successfully.
    const ctx = await buildSeededContext();
    const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
    const treeId = await writeObject(ctx, tree);
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
    // Overwrite commitA's loose file with commitB's bytes.
    const { computeLooseObjectPath } = await import('../../../../src/domain/storage/loose-path.js');
    const bPath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(commitB)}`;
    const aPath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(commitA)}`;
    const bBytes = await ctx.fs.read(bPath);
    await ctx.fs.write(aPath, bBytes);

    const commits = await collect(walkCommits(ctx, { from: [commitA], verifyHash: false }));
    expect(commits.length).toBeGreaterThanOrEqual(1);
    // Parsed content belongs to commitB, not commitA.
    expect(commits[0]?.data.message).toMatch(/impostor/);
  });

  it('Given a commit that references a visited parent, When walkCommits is iterated, Then the parent is not re-visited (kills the visited-set short-circuit)', async () => {
    // Forces the first conjunct of `visited.has || missing.has || until.has`
    // to actually fire. Built as a diamond so d's two paths both converge on
    // `a` — visiting `a` twice would cause duplicates.
    const ctx = await buildSeededContext();
    const { a, d } = await buildDiamond(ctx);
    const commits = await collect(walkCommits(ctx, { from: [d] }));
    const aCount = commits.filter((x) => x.id === a).length;
    expect(aCount).toBe(1);
  });

  it('Given ignoreMissing=true and readObject throws a non-OBJECT_NOT_FOUND TsgitError, When walkCommits is iterated, Then the error propagates (not silently treated as missing)', async () => {
    // Kills the `error.data.code === 'OBJECT_NOT_FOUND'` EqualityOperator/true
    // mutant: under `true` a PERMISSION_DENIED error would be swallowed when
    // ignoreMissing=true. The correct code only swallows OBJECT_NOT_FOUND.
    const ctx = await buildSeededContext();
    const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
    const treeId = await writeObject(ctx, tree);
    const commitId = await createCommit(ctx, {
      tree: treeId,
      parents: [],
      author: AUTHOR,
      committer: AUTHOR,
      message: 'm',
    });
    const wrapped = {
      ...ctx,
      fs: {
        ...ctx.fs,
        read: async (path: string) => {
          if (path.includes('objects')) {
            throw new TsgitError({ code: 'PERMISSION_DENIED', path });
          }
          return ctx.fs.read(path);
        },
      },
    };
    try {
      for await (const _ of walkCommits(wrapped, { from: [commitId], ignoreMissing: true })) {
        void _;
      }
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('PERMISSION_DENIED');
    }
  });

  it('Given an abort between two yielded commits, When walkCommits continues, Then throws OPERATION_ABORTED at the next loop head', async () => {
    // Kills the `ctx.signal?.aborted` ConditionalExpression `false` mutant:
    // under `false`, the abort check inside the while loop is never true and
    // the walk runs to completion silently.
    const ctx = await buildSeededContext();
    const ids = await linearChain(ctx, 3);
    const controller = new AbortController();
    const aborted = { ...ctx, signal: controller.signal };
    try {
      const yielded: ObjectId[] = [];
      for await (const c of walkCommits(aborted, { from: [ids.at(-1)!] })) {
        yielded.push(c.id);
        // Abort after first commit is yielded; next loop-head check fires.
        controller.abort();
      }
      expect.unreachable();
    } catch (error) {
      expect((error as TsgitError).data.code).toBe('OPERATION_ABORTED');
    }
  });

  it('Given a non-TsgitError thrown by readObject, When walkCommits is iterated, Then the error propagates unchanged', async () => {
    // Kills the `isObjectNotFound` mutants on `error instanceof TsgitError && code === 'OBJECT_NOT_FOUND'`.
    const ctx = await buildSeededContext();
    const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
    const treeId = await writeObject(ctx, tree);
    const commitId = await createCommit(ctx, {
      tree: treeId,
      parents: [],
      author: AUTHOR,
      committer: AUTHOR,
      message: 'm',
    });
    const wrapped = {
      ...ctx,
      fs: {
        ...ctx.fs,
        read: async () => {
          throw new Error('io boom');
        },
      },
    };
    try {
      for await (const _ of walkCommits(wrapped, { from: [commitId], ignoreMissing: true })) {
        void _;
      }
      expect.unreachable();
    } catch (error) {
      expect(error).not.toBeInstanceOf(TsgitError);
      expect((error as Error).message).toBe('io boom');
    }
  });

  describe('queue-overflow guard', () => {
    it('Given a seed commit with MAX_WALK_QUEUE_SIZE+1 distinct parents, When walking, Then throws INVALID_WALK_INPUT with the queue-overflow reason', async () => {
      // Arrange — one commit whose parents would push the queue past its bound.
      // The guard `state.queue.length >= MAX_WALK_QUEUE_SIZE` must fire on the
      // (MAX+1)-th push: a `> ` mutant or a `false` mutant lets all parents
      // enqueue, after which the walk dequeues a fake parent and surfaces
      // OBJECT_NOT_FOUND instead — a different, killable outcome.
      const ctx = await buildSeededContext();
      const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
      const treeId = await writeObject(ctx, tree);
      const parents = Array.from(
        { length: MAX_WALK_QUEUE_SIZE + 1 },
        (_, i) => i.toString(16).padStart(40, '0') as ObjectId,
      );
      const seed = await createCommit(ctx, {
        tree: treeId,
        parents,
        author: AUTHOR,
        committer: AUTHOR,
        message: 'octopus',
      });

      // Act & Assert
      let caught: unknown;
      try {
        for await (const _ of walkCommits(ctx, { from: [seed] })) void _;
        expect.unreachable();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data.code).toBe('INVALID_WALK_INPUT');
      expect((caught as TsgitError).data).toEqual(
        expect.objectContaining({ reason: expect.stringContaining('queue') }),
      );
    });

    it('Given a seed whose MAX_WALK_QUEUE_SIZE+1 parents are all an already-visited oid, When walking, Then the dedup guard skips them all and the walk completes without overflow', async () => {
      // Arrange — walk from [v, H] where H lists the SAME visited oid `v`
      // MAX+1 times. The `visited.has(parent) || ...` pre-filter in
      // enqueueParents must skip every duplicate so the queue never grows.
      // Any mutant that weakens that guard (`||`→`&&`, or the whole condition
      // forced to `false`) lets all MAX+1 copies enqueue and trips the
      // overflow guard — observably different from this clean completion.
      const ctx = await buildSeededContext();
      const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
      const treeId = await writeObject(ctx, tree);
      const v = await createCommit(ctx, {
        tree: treeId,
        parents: [],
        author: AUTHOR,
        committer: AUTHOR,
        message: 'visited-root',
      });
      const head = await createCommit(ctx, {
        tree: treeId,
        parents: Array.from({ length: MAX_WALK_QUEUE_SIZE + 1 }, () => v),
        author: { ...AUTHOR, timestamp: AUTHOR.timestamp + 1 },
        committer: { ...AUTHOR, timestamp: AUTHOR.timestamp + 1 },
        message: 'head-with-duplicate-parents',
      });

      // Act
      const commits = await collect(walkCommits(ctx, { from: [v, head] }));

      // Assert — exactly v and head, each once; no overflow throw.
      const ids = commits.map((c) => c.id).sort();
      expect(ids).toEqual([v, head].sort());
    });
  });

  describe('abort guard inside the walk loop', () => {
    it('Given a signal already aborted before iteration, When walkCommits is iterated, Then yields zero commits and throws OPERATION_ABORTED', async () => {
      // Arrange — the loop-head `if (ctx.signal?.aborted) throw` must fire on
      // the very first iteration. A `false` mutant of that condition lets the
      // walk yield the seed commit; asserting zero yields kills it.
      const ctx = await buildSeededContext();
      const [id] = await linearChain(ctx, 1);
      const controller = new AbortController();
      controller.abort();
      const aborted = { ...ctx, signal: controller.signal };

      // Act & Assert
      const yielded: ObjectId[] = [];
      let caught: unknown;
      try {
        for await (const c of walkCommits(aborted, { from: [id as ObjectId] })) {
          yielded.push(c.id);
        }
        expect.unreachable();
      } catch (error) {
        caught = error;
      }
      expect(yielded).toEqual([]);
      expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
    });

    it('Given a signal whose aborted flag is truthy but not strictly true, When walkCommits is iterated, Then the loop-head guard alone throws OPERATION_ABORTED', async () => {
      // Arrange — `readObject`'s abort check is strict (`aborted === true`)
      // while the loop-head guard at line 42 is a truthiness test. A signal
      // with `aborted: 1` is truthy-but-not-`true`, so `readObject` never
      // aborts and the loop-head guard is the ONLY abort path. A `false`
      // mutant of that guard lets the walk run to completion silently.
      const ctx = await buildSeededContext();
      const [id] = await linearChain(ctx, 1);
      const truthySignal = { aborted: 1 } as unknown as AbortSignal;
      const aborted = { ...ctx, signal: truthySignal };

      // Act & Assert
      const yielded: ObjectId[] = [];
      let caught: unknown;
      try {
        for await (const c of walkCommits(aborted, { from: [id as ObjectId] })) {
          yielded.push(c.id);
        }
        expect.unreachable();
      } catch (error) {
        caught = error;
      }
      expect(yielded).toEqual([]);
      expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
    });
  });

  describe('shallow boundary', () => {
    it('Given options.shallow is undefined, When walking a chain, Then yields every commit (regression guard)', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const ids = await linearChain(ctx, 4);

      // Act — no shallow option → behavior identical to today.
      const seen = await collect(walkCommits(ctx, { from: [ids[3] as ObjectId] }));

      // Assert
      expect(seen.length).toBe(4);
    });

    it('Given options.shallow is empty, When walking, Then identical to undefined-shallow (regression guard)', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const ids = await linearChain(ctx, 4);

      // Act
      const seen = await collect(
        walkCommits(ctx, { from: [ids[3] as ObjectId], shallow: new Set<ObjectId>() }),
      );

      // Assert
      expect(seen.length).toBe(4);
    });

    it('Given shallow = {tip}, When walking from tip, Then yields ONLY the tip', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const ids = await linearChain(ctx, 4);
      const tip = ids[3] as ObjectId;

      // Act
      const seen = await collect(walkCommits(ctx, { from: [tip], shallow: new Set([tip]) }));

      // Assert
      expect(seen.length).toBe(1);
      expect(seen[0]?.id).toBe(tip);
    });

    it('Given shallow boundary and the parent object is missing, When walking, Then no OBJECT_NOT_FOUND raised', async () => {
      // Arrange — seed a child commit pointing at a fictional parent oid.
      const ctx = await buildSeededContext();
      const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
      const treeId = await writeObject(ctx, tree);
      const fakeParent = '0000000000000000000000000000000000000001' as ObjectId;
      const child = await createCommit(ctx, {
        tree: treeId,
        parents: [fakeParent],
        author: { ...AUTHOR, timestamp: 1 },
        committer: { ...AUTHOR, timestamp: 1 },
        message: 'child of missing parent',
      });

      // Act — shallow boundary at `child` means the walker MUST NOT try to
      // read the missing parent.
      const seen = await collect(walkCommits(ctx, { from: [child], shallow: new Set([child]) }));

      // Assert
      expect(seen.length).toBe(1);
      expect(seen[0]?.id).toBe(child);
    });

    it('Given two shallow seeds from distinct histories, When walking, Then both seeds yielded; neither parent walked', async () => {
      // Arrange — two disjoint linear chains with different message prefixes
      // so the commit oids differ. linearChain alone would produce identical
      // oids across calls because the inputs collapse to the same content.
      const ctx = await buildSeededContext();
      const tree: Tree = { type: 'tree', entries: [], id: '' as ObjectId };
      const treeId = await writeObject(ctx, tree);
      const mkLine = async (label: string): Promise<ObjectId> => {
        let parent: ObjectId[] = [];
        let tip: ObjectId = '' as ObjectId;
        for (let i = 0; i < 3; i += 1) {
          tip = await createCommit(ctx, {
            tree: treeId,
            parents: parent,
            author: { ...AUTHOR, timestamp: 1700000000 + i },
            committer: { ...AUTHOR, timestamp: 1700000000 + i },
            message: `${label}-${i}`,
          });
          parent = [tip];
        }
        return tip;
      };
      const tip1 = await mkLine('alpha');
      const tip2 = await mkLine('beta');

      // Act
      const seen = await collect(
        walkCommits(ctx, { from: [tip1, tip2], shallow: new Set([tip1, tip2]) }),
      );

      // Assert
      expect(seen.length).toBe(2);
      const ids = seen.map((c) => c.id).sort();
      expect(ids).toEqual([tip1, tip2].sort());
    });

    it('Given shallow boundary at the parent of the seed, When walking, Then seed + boundary both yielded but no further walk', async () => {
      // Arrange — linear chain c0 ← c1 ← c2; shallow at c1.
      const ctx = await buildSeededContext();
      const ids = await linearChain(ctx, 3);
      const seed = ids[2] as ObjectId;
      const boundary = ids[1] as ObjectId;

      // Act
      const seen = await collect(walkCommits(ctx, { from: [seed], shallow: new Set([boundary]) }));

      // Assert — c2 + c1 are yielded; c0 is NOT walked because c1 is shallow.
      expect(seen.map((c) => c.id)).toEqual([seed, boundary]);
    });
  });
});
