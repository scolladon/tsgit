import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { rangeDiff } from '../../../../src/application/commands/range-diff.js';
import { createCommit } from '../../../../src/application/primitives/create-commit.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
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
      const sut = rangeDiff;

      // Act + Assert
      await expect(
        sut(ctx, { old: { base: 'a', tip: 'b' }, new: { base: 'a', tip: 'c' } }),
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
      const sut = rangeDiff;

      // Act
      const result = await sut(ctx, { old: { base, tip: 'v1' }, new: { base, tip: 'v2' } });

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
      const sut = rangeDiff;

      // Act
      const result = await sut(ctx, { old: { base, tip: base }, new: { base, tip } });

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
      const sut = rangeDiff;

      // Act — old has the two real commits (merge excluded); new is empty
      const result = await sut(ctx, { old: { base, tip: 'main' }, new: { base, tip: base } });

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
      const sut = rangeDiff;

      // Act + Assert
      await expect(
        sut(ctx, { old: { base, tip: 'nope' }, new: { base, tip: base } }),
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
      const sut = rangeDiff;

      // Act + Assert
      try {
        await sut(ctx, { old: { base, tip: base }, new: { base, tip: base }, creationFactor: -1 });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(TsgitError);
        expect((error as TsgitError).data).toMatchObject({
          code: 'INVALID_OPTION',
          option: 'creationFactor',
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
      const sut = rangeDiff;

      // Act
      const matched = await sut(ctx, { old: { base, tip: 'v1' }, new: { base, tip: 'v2' } });
      const split = await sut(ctx, {
        old: { base, tip: 'v1' },
        new: { base, tip: 'v2' },
        creationFactor: 0,
      });

      // Assert
      expect(matched.map((e) => e.status)).toEqual(['changed']);
      expect(split.map((e) => e.status)).toEqual(['only-old', 'only-new']);
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
      const sut = rangeDiff;

      // Act — the same range on both sides; the series spans [seed (root), add a]
      const result = await sut(ctx, {
        old: { base: orphan, tip: 'main' },
        new: { base: orphan, tip: 'main' },
      });

      // Assert — both commits pair as unchanged; the root resolved with no parent
      expect(result.map((e) => e.status)).toEqual(['unchanged', 'unchanged']);
      expect(result[0]?.old?.position).toBe(1);
      expect(result[1]?.new?.position).toBe(2);
    });
  });
});
