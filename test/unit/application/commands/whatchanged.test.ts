import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../src/application/commands/init.js';
import { whatchanged } from '../../../../src/application/commands/whatchanged.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import {
  type AuthorIdentity,
  FILE_MODE,
  type ObjectId,
  type TreeEntry,
} from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { seedRepo } from './fixtures.js';

const enc = new TextEncoder();

const ident = (ts: number): AuthorIdentity => ({
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: ts,
  timezoneOffset: '+0000',
});

const blob = (ctx: Context, content: string): Promise<ObjectId> =>
  writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: enc.encode(content) });

const tree = async (ctx: Context, files: Readonly<Record<string, string>>): Promise<ObjectId> => {
  const entries: TreeEntry[] = await Promise.all(
    Object.entries(files).map(async ([name, content]) => ({
      mode: FILE_MODE.REGULAR,
      name,
      id: await blob(ctx, content),
    })),
  );
  return writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries });
};

/** Write a commit with a real tree built from `files` and explicit `parents`. */
const commitWith = async (
  ctx: Context,
  files: Readonly<Record<string, string>>,
  parents: ReadonlyArray<ObjectId>,
  message: string,
  ts: number,
): Promise<ObjectId> => {
  const treeId = await tree(ctx, files);
  return writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: treeId,
      parents: [...parents],
      author: ident(ts),
      committer: ident(ts),
      message,
      extraHeaders: [],
    },
  });
};

const pointMainAt = (ctx: Context, tip: ObjectId): Promise<unknown> =>
  seedRepo(ctx, { refs: { 'refs/heads/main': tip }, head: 'refs/heads/main' });

/** Linear chain: root(add a) → modify a + add b → rename b to c → empty. */
const seedLinear = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  const c1 = await commitWith(ctx, { 'a.txt': 'a\n' }, [], 'root', 1000);
  const c2 = await commitWith(ctx, { 'a.txt': 'a2\n', 'b.txt': 'b\n' }, [c1], 'mod a add b', 2000);
  const c3 = await commitWith(
    ctx,
    { 'a.txt': 'a2\n', 'c.txt': 'b\n' },
    [c2],
    'rename b to c',
    3000,
  );
  const c4 = await commitWith(ctx, { 'a.txt': 'a2\n', 'c.txt': 'b\n' }, [c3], 'empty', 4000);
  await pointMainAt(ctx, c4);
  return { ctx, c1, c2, c3, c4 };
};

/** Diamond: A → (B, C) → merge D[B,C], all with real, distinct content. */
const seedDiamond = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  const a = await commitWith(ctx, { 'a.txt': 'a\n' }, [], 'A', 1000);
  const b = await commitWith(ctx, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, [a], 'B', 2000);
  const c = await commitWith(ctx, { 'a.txt': 'a\n', 'c.txt': 'c\n' }, [a], 'C', 3000);
  const d = await commitWith(
    ctx,
    { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' },
    [b, c],
    'D-merge',
    4000,
  );
  await pointMainAt(ctx, d);
  return { ctx, a, b, c, d };
};

const messages = (entries: ReadonlyArray<{ readonly message: string }>): ReadonlyArray<string> =>
  entries.map((e) => e.message);

describe('whatchanged', () => {
  describe('Given a linear history, When whatchanged runs with defaults', () => {
    it('Then each non-merge commit pairs its log fields with first-parent changes', async () => {
      // Arrange
      const { ctx } = await seedLinear();
      const sut = whatchanged;

      // Act
      const result = await sut(ctx);

      // Assert — newest first; every entry carries log fields + changes
      expect(messages(result)).toEqual(['empty', 'rename b to c', 'mod a add b', 'root']);
      expect(result[2]?.changes.changes.map((c) => c.type).sort()).toEqual(['add', 'modify']);
      expect(result[2]?.author.name).toBe('Ada');
    });
  });

  describe('Given the root commit, When whatchanged runs', () => {
    it('Then its changes are the additions against the empty tree', async () => {
      // Arrange
      const { ctx, c1 } = await seedLinear();
      const sut = whatchanged;

      // Act
      const result = await sut(ctx, { rev: c1 });

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]?.changes.changes).toEqual([
        expect.objectContaining({ type: 'add', newPath: 'a.txt' }),
      ]);
    });
  });

  describe('Given a pure rename, When whatchanged runs', () => {
    it('Then it surfaces a single rename change (detection on)', async () => {
      // Arrange
      const { ctx, c3 } = await seedLinear();
      const sut = whatchanged;

      // Act
      const result = await sut(ctx, { rev: c3, limit: 1 });

      // Assert
      expect(result[0]?.changes.changes).toEqual([
        expect.objectContaining({ type: 'rename', oldPath: 'b.txt', newPath: 'c.txt' }),
      ]);
    });
  });

  describe('Given a content-free commit, When whatchanged runs', () => {
    it('Then the entry is present with an empty change set', async () => {
      // Arrange
      const { ctx, c4 } = await seedLinear();
      const sut = whatchanged;

      // Act
      const result = await sut(ctx, { rev: c4, limit: 1 });

      // Assert
      expect(result[0]?.message).toBe('empty');
      expect(result[0]?.changes.changes).toEqual([]);
    });
  });

  describe('Given a merge in the history, When whatchanged runs with defaults', () => {
    it('Then the merge is excluded but its ancestors remain', async () => {
      // Arrange
      const { ctx } = await seedDiamond();
      const sut = whatchanged;

      // Act
      const result = await sut(ctx);

      // Assert — D (2 parents) dropped; reachability preserved (C, B, A present)
      expect(messages(result)).toEqual(['C', 'B', 'A']);
    });
  });

  describe('Given a single-parent commit, When whatchanged runs', () => {
    it('Then it is NOT treated as a merge (kept in output)', async () => {
      // Arrange
      const { ctx, b } = await seedDiamond();
      const sut = whatchanged;

      // Act
      const result = await sut(ctx, { rev: b });

      // Assert — B has one parent (A); both present
      expect(messages(result)).toEqual(['B', 'A']);
      expect(result[0]?.changes.changes).toEqual([
        expect.objectContaining({ type: 'add', newPath: 'b.txt' }),
      ]);
    });
  });

  describe('Given a merge inside a limited window, When whatchanged limits the count', () => {
    it('Then the excluded merge does not consume a limit slot', async () => {
      // Arrange
      const { ctx } = await seedDiamond();
      const sut = whatchanged;

      // Act — walk pops D (merge, skipped), then must still yield two entries
      const result = await sut(ctx, { limit: 2 });

      // Assert
      expect(result).toHaveLength(2);
      expect(messages(result)).toEqual(['C', 'B']);
    });
  });

  describe('Given a history, When whatchanged filters by before', () => {
    it('Then commits at or after the threshold are excluded (boundary inclusive)', async () => {
      // Arrange — c2 sits exactly at the threshold second (2000)
      const { ctx, c3 } = await seedLinear();
      const sut = whatchanged;

      // Act
      const result = await sut(ctx, { rev: c3, before: new Date(2000 * 1000) });

      // Assert — c2 (== 2000) and c3 (> 2000) excluded; only root remains
      expect(messages(result)).toEqual(['root']);
    });
  });

  describe('Given a history, When whatchanged excludes a range', () => {
    it('Then commits reachable from the excluded rev are removed', async () => {
      // Arrange
      const { ctx, c1, c3 } = await seedLinear();
      const sut = whatchanged;

      // Act
      const result = await sut(ctx, { rev: c3, excluding: [c1] });

      // Assert
      expect(messages(result)).toEqual(['rename b to c', 'mod a add b']);
    });
  });

  describe('Given a diamond, When whatchanged walks first-parent', () => {
    it('Then only the first-parent chain (minus merges) is emitted', async () => {
      // Arrange
      const { ctx } = await seedDiamond();
      const sut = whatchanged;

      // Act
      const result = await sut(ctx, { order: 'first-parent' });

      // Assert — D dropped; spine D→B→A yields B, A (C, the 2nd parent, absent)
      expect(messages(result)).toEqual(['B', 'A']);
    });
  });

  describe('Given an unresolvable rev, When whatchanged runs', () => {
    it('Then it throws OBJECT_NOT_FOUND', async () => {
      // Arrange
      const { ctx } = await seedLinear();
      const sut = whatchanged;

      // Act
      let caught: unknown;
      try {
        await sut(ctx, { rev: 'no-such-rev' });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(Error);
      expect((caught as { data?: { code?: string } }).data?.code).toBe('OBJECT_NOT_FOUND');
    });
  });

  describe('Given an unresolvable excluding entry, When whatchanged runs', () => {
    it('Then it throws OBJECT_NOT_FOUND', async () => {
      // Arrange
      const { ctx, c3 } = await seedLinear();
      const sut = whatchanged;

      // Act
      let caught: unknown;
      try {
        await sut(ctx, { rev: c3, excluding: ['no-such-rev'] });
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(Error);
      expect((caught as { data?: { code?: string } }).data?.code).toBe('OBJECT_NOT_FOUND');
    });
  });

  describe('Given an unborn branch, When whatchanged runs', () => {
    it('Then it throws OBJECT_NOT_FOUND', async () => {
      // Arrange — wipe the only ref so HEAD points at an unresolvable branch
      const { ctx } = await seedLinear();
      await ctx.fs.rm(`${ctx.layout.gitDir}/refs/heads/main`);
      const sut = whatchanged;

      // Act
      let caught: unknown;
      try {
        await sut(ctx);
      } catch (err) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(Error);
      expect((caught as { data?: { code?: string } }).data?.code).toBe('OBJECT_NOT_FOUND');
    });
  });
});
