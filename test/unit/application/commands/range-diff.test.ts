import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { mv } from '../../../../src/application/commands/mv.js';
import { rangeDiff } from '../../../../src/application/commands/range-diff.js';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import * as diffTreesMod from '../../../../src/application/primitives/diff-trees.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import type { LineDiff } from '../../../../src/domain/diff/index.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const makeClock = () => {
  let ts = 1000;
  return (): AuthorIdentity => {
    ts += 1000;
    return { name: 'A', email: 'a@x', timestamp: ts, timezoneOffset: '+0000' };
  };
};

const big = (changed: string): string => {
  const lines: string[] = [];
  for (let n = 1; n <= 20; n++) lines.push(n === 10 ? changed : `line ${n}`);
  return `${lines.join('\n')}\n`;
};

const decoder = new TextDecoder();

/** True when any rendered patch line on either side of the diff-of-diffs contains `needle`. */
const patchLinesInclude = (diff: LineDiff | undefined, needle: string): boolean => {
  if (diff === undefined) return false;
  return [...diff.oursLines, ...diff.theirsLines].some((line) =>
    decoder.decode(line).includes(needle),
  );
};

const commitFile = async (
  ctx: Context,
  clock: () => AuthorIdentity,
  path: string,
  content: string,
  message: string,
): Promise<string> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);
  await add(ctx, [path]);
  const author = clock();
  const result = await commit(ctx, { message, author, committer: author });
  return result.id;
};

describe('rangeDiff', () => {
  describe('Given a non-repository context, When rangeDiff runs', () => {
    it('Then it refuses', async () => {
      // Arrange
      const ctx = createMemoryContext();

      // Act + Assert
      await expect(
        rangeDiff(ctx, { old: { base: 'a', tip: 'b' }, new: { base: 'a', tip: 'c' } }),
      ).rejects.toThrow();
    });
  });

  describe('Given two ranges adding the same content under different messages, When rangeDiff runs', () => {
    it('Then the commit is matched and changed with a diff-of-diffs', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);
      const clock = makeClock();
      const base = await commitFile(ctx, clock, 'seed', 'seed\n', 'seed');
      await branchCreate(ctx, { name: 'v1' });
      await checkout(ctx, { rev: 'v1' });
      await commitFile(ctx, clock, 'f.txt', 'hello\n', 'old message');
      await checkout(ctx, { rev: 'main' });
      await branchCreate(ctx, { name: 'v2' });
      await checkout(ctx, { rev: 'v2' });
      await commitFile(ctx, clock, 'f.txt', 'hello\n', 'new message');

      // Act
      const result = await rangeDiff(ctx, { old: { base, tip: 'v1' }, new: { base, tip: 'v2' } });

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]?.status).toBe('changed');
      expect(result[0]?.diffOfDiffs).toBeDefined();
    });
  });

  describe('Given an empty old range, When rangeDiff runs', () => {
    it('Then every new commit is a creation', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);
      const clock = makeClock();
      const base = await commitFile(ctx, clock, 'seed', 'seed\n', 'seed');
      const tip = await commitFile(ctx, clock, 'f.txt', 'x\n', 'add f');

      // Act
      const result = await rangeDiff(ctx, { old: { base, tip: base }, new: { base, tip } });

      // Assert
      expect(result.map((e) => e.status)).toEqual(['only-new']);
    });
  });

  describe('Given a merge commit in a range, When rangeDiff runs', () => {
    it('Then the merge is excluded from the patch series', async () => {
      // Arrange — main: base, feat: fc; merge feat into main; range base..main has fc, mc, merge
      const ctx = createMemoryContext();
      await init(ctx);
      const clock = makeClock();
      const base = await commitFile(ctx, clock, 'seed', 'seed\n', 'seed');
      await branchCreate(ctx, { name: 'feat' });
      await checkout(ctx, { rev: 'feat' });
      await commitFile(ctx, clock, 'x.txt', 'x\n', 'on feat');
      await checkout(ctx, { rev: 'main' });
      await commitFile(ctx, clock, 'y.txt', 'y\n', 'on main');
      await mergeRun(ctx, { rev: 'feat', author: clock() });

      // Act — old has the two real commits (merge excluded); new is empty
      const result = await rangeDiff(ctx, { old: { base, tip: 'main' }, new: { base, tip: base } });

      // Assert — only the two non-merge commits, both deletions
      expect(result).toHaveLength(2);
      expect(result.every((e) => e.status === 'only-old')).toBe(true);
    });
  });

  describe('Given an unresolvable range endpoint, When rangeDiff runs', () => {
    it('Then it refuses', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);
      const clock = makeClock();
      const base = await commitFile(ctx, clock, 'seed', 'seed\n', 'seed');

      // Act + Assert
      await expect(
        rangeDiff(ctx, { old: { base, tip: 'nope' }, new: { base, tip: base } }),
      ).rejects.toThrow();
    });
  });

  describe('Given an invalid creation factor, When rangeDiff runs', () => {
    it('Then it refuses with INVALID_OPTION', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);
      const clock = makeClock();
      const base = await commitFile(ctx, clock, 'seed', 'seed\n', 'seed');

      // Act + Assert
      try {
        await rangeDiff(ctx, {
          old: { base, tip: base },
          new: { base, tip: base },
          creationFactor: -1,
        });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(TsgitError);
        expect((error as TsgitError).data).toMatchObject({
          code: 'INVALID_OPTION',
          option: 'creationFactor',
          reason: 'must be a non-negative integer; got -1',
        });
      }
    });
  });

  describe('Given near-identical patches, When the creation factor varies', () => {
    it('Then a high factor matches them and a zero factor splits them', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await init(ctx);
      const clock = makeClock();
      const base = await commitFile(ctx, clock, 'seed', 'seed\n', 'seed');
      await branchCreate(ctx, { name: 'v1' });
      await checkout(ctx, { rev: 'v1' });
      await commitFile(ctx, clock, 'big.txt', big('line 10'), 'add big');
      await checkout(ctx, { rev: 'main' });
      await branchCreate(ctx, { name: 'v2' });
      await checkout(ctx, { rev: 'v2' });
      await commitFile(ctx, clock, 'big.txt', big('line 10 changed'), 'add big');

      // Act
      const matched = await rangeDiff(ctx, { old: { base, tip: 'v1' }, new: { base, tip: 'v2' } });
      const split = await rangeDiff(ctx, {
        old: { base, tip: 'v1' },
        new: { base, tip: 'v2' },
        creationFactor: 0,
      });

      // Assert
      expect(matched.map((e) => e.status)).toEqual(['changed']);
      expect(split.map((e) => e.status)).toEqual(['only-old', 'only-new']);
    });
  });

  describe('Given a linear two-commit range, When rangeDiff runs', () => {
    it('Then the series is ordered oldest-first (position 1 is the older commit)', async () => {
      // Arrange — two distinct commits; the walk yields them newest-first, so only
      // the oldest-first reversal puts `older` at position 1 and `newer` at position 2.
      const ctx = createMemoryContext();
      await init(ctx);
      const clock = makeClock();
      const base = await commitFile(ctx, clock, 'seed', 'seed\n', 'seed');
      const older = await commitFile(ctx, clock, 'a.txt', 'a\n', 'add a');
      const newer = await commitFile(ctx, clock, 'b.txt', 'b\n', 'add b');

      // Act — the same range on both sides; both commits pair as unchanged
      const result = await rangeDiff(ctx, { old: { base, tip: newer }, new: { base, tip: newer } });

      // Assert — oldest-first order: `older` is position 1, `newer` is position 2
      expect(result.map((e) => e.status)).toEqual(['unchanged', 'unchanged']);
      expect(result[0]?.old?.id).toBe(older);
      expect(result[1]?.old?.id).toBe(newer);
    });
  });

  describe('Given a range whose series begins at a root commit, When rangeDiff runs', () => {
    it('Then the root commit is hydrated against the empty tree (no first parent)', async () => {
      // Arrange — an unrelated orphan base forces the walk to include main's root
      // commit, which has no first parent and must be diffed against the empty tree.
      const ctx = createMemoryContext();
      await init(ctx);
      const clock = makeClock();
      const root = await commitFile(ctx, clock, 'seed', 'seed\n', 'seed');
      await commitFile(ctx, clock, 'a', 'a\n', 'add a');
      const rootObject = await readObject(ctx, root as ObjectId);
      if (rootObject.type !== 'commit') throw new Error('expected a commit');
      const orphan = await createCommit(ctx, {
        tree: rootObject.data.tree,
        parents: [],
        author: clock(),
        committer: clock(),
        message: 'orphan',
      });

      // Act — the same range on both sides; the series spans [seed (root), add a]
      const result = await rangeDiff(ctx, {
        old: { base: orphan, tip: 'main' },
        new: { base: orphan, tip: 'main' },
      });

      // Assert — both commits pair as unchanged; the root resolved with no parent
      expect(result.map((e) => e.status)).toEqual(['unchanged', 'unchanged']);
      expect(result[0]?.old?.position).toBe(1);
      expect(result[1]?.new?.position).toBe(2);
    });
  });

  describe('Given ranges making the same edit to a nested file under different messages, When rangeDiff runs', () => {
    it('Then recursion surfaces the nested blob path in the diff-of-diffs', async () => {
      // Arrange — both sides make the identical `dir/f.txt` edit, so the diff slices
      // match and the pair is kept; only the commit message differs, so it is `changed`.
      const ctx = createMemoryContext();
      await init(ctx);
      const clock = makeClock();
      const base = await commitFile(ctx, clock, 'dir/f.txt', 'a\n', 'seed nested');
      await branchCreate(ctx, { name: 'v1' });
      await checkout(ctx, { rev: 'v1' });
      await commitFile(ctx, clock, 'dir/f.txt', 'b\n', 'old message');
      await checkout(ctx, { rev: 'main' });
      await branchCreate(ctx, { name: 'v2' });
      await checkout(ctx, { rev: 'v2' });
      await commitFile(ctx, clock, 'dir/f.txt', 'b\n', 'new message');

      // Act
      const result = await rangeDiff(ctx, { old: { base, tip: 'v1' }, new: { base, tip: 'v2' } });

      // Assert — recursion names the leaf `dir/f.txt`; without it the top-level tree entry
      // renders as `dir` (an opaque binary diff) and the nested path never appears.
      expect(result.map((e) => e.status)).toEqual(['changed']);
      expect(patchLinesInclude(result[0]?.diffOfDiffs, 'dir/f.txt')).toBe(true);
    });
  });

  describe('Given ranges making the same rename under different messages, When rangeDiff runs', () => {
    it('Then similarity detection folds the delete/add into a rename header', async () => {
      // Arrange — both sides rename `f.txt` to `g.txt` identically, so the diff slices
      // match and the pair is kept; only the commit message differs, so it is `changed`.
      const ctx = createMemoryContext();
      await init(ctx);
      const clock = makeClock();
      const base = await commitFile(ctx, clock, 'f.txt', big('line 10'), 'seed f');
      await branchCreate(ctx, { name: 'v1' });
      await checkout(ctx, { rev: 'v1' });
      await mv(ctx, ['f.txt'], 'g.txt');
      const author1 = clock();
      await commit(ctx, { message: 'old message', author: author1, committer: author1 });
      await checkout(ctx, { rev: 'main' });
      await branchCreate(ctx, { name: 'v2' });
      await checkout(ctx, { rev: 'v2' });
      await mv(ctx, ['f.txt'], 'g.txt');
      const author2 = clock();
      await commit(ctx, { message: 'new message', author: author2, committer: author2 });

      // Act
      const result = await rangeDiff(ctx, { old: { base, tip: 'v1' }, new: { base, tip: 'v2' } });

      // Assert — rename detection collapses the pair into a `f.txt => g.txt` header;
      // without it the patch degrades to separate `(deleted)`/`(new)` headers.
      expect(result.map((e) => e.status)).toEqual(['changed']);
      expect(patchLinesInclude(result[0]?.diffOfDiffs, 'f.txt => g.txt')).toBe(true);
    });
  });

  describe('Given a series with more commits than the ioBound limit, When rangeDiff runs', () => {
    it('Then commit hydration peaks at exactly the bound', async () => {
      // Arrange — an explicit ioBound distinct from cpuBound so a bucket-swap
      // regression (deriving the pool from the wrong bucket) fails loudly.
      // Each commit touches its own file, so every commit's `hydrate` call
      // reaches `diffTrees` and none is filtered out as a no-op.
      const ioBound = 3;
      const base = createMemoryContext();
      await init(base);
      const clock = makeClock();
      const seed = await commitFile(base, clock, 'seed.txt', 'seed', 'seed');
      const width = ioBound + 4;
      let tip = seed;
      for (let i = 0; i < width; i++) {
        tip = await commitFile(base, clock, `f${i}.txt`, `content-${i}`, `commit ${i}`);
      }
      const ctx: Context = { ...base, concurrency: { cpuBound: 1, ioBound } };
      let inFlight = 0;
      let maxInFlight = 0;
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      const realDiffTrees = diffTreesMod.diffTrees;
      const spy = vi
        .spyOn(diffTreesMod, 'diffTrees')
        .mockImplementation(async (spyCtx, a, b, opts) => {
          inFlight += 1;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          await gate;
          inFlight -= 1;
          return realDiffTrees(spyCtx, a, b, opts);
        });

      // Act
      try {
        const consumer = rangeDiff(ctx, {
          old: { base: seed, tip },
          new: { base: seed, tip: seed },
        });
        // Real repository plumbing (resolveCommit, walkCommitsByDate) precedes
        // hydration and spans a variable number of macrotask hops of its own
        // before any gated call is even reached, so poll until the bound is
        // hit rather than assuming a fixed number of ticks.
        for (let attempt = 0; attempt < 200 && maxInFlight < ioBound; attempt++) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        const peakWhileBlocked = maxInFlight;
        openGate();
        const result = await consumer;

        // Assert
        expect(result).toHaveLength(width);
        expect(peakWhileBlocked).toBe(ioBound);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
