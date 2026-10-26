import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../../src/application/commands/add.js';
import { commit } from '../../../../../src/application/commands/commit.js';
import { init } from '../../../../../src/application/commands/init.js';
import {
  refreshAndWriteIndex,
  refreshedIndex,
} from '../../../../../src/application/commands/internal/refresh-index.js';
import { acquireIndexLock } from '../../../../../src/application/primitives/internal/index-lock.js';
import { readIndex } from '../../../../../src/application/primitives/read-index.js';
import type { IndexEntry, IndexEntryFlags } from '../../../../../src/domain/git-index/index.js';
import type { AuthorIdentity, FilePath } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const T0 = 1_700_000_000_000;
const LATER_MS = 10_000;
const CLOCK = { toFake: ['Date' as const] };

afterEach(() => {
  vi.useRealTimers();
});

const write = (ctx: Context, path: string, content: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);

const committedRepo = async (): Promise<Context> => {
  vi.useFakeTimers(CLOCK);
  vi.setSystemTime(T0);
  const ctx = createMemoryContext();
  await init(ctx);
  await write(ctx, 'f', 'v1\n');
  await add(ctx, ['f']);
  await commit(ctx, { message: 'base', author: AUTHOR, committer: AUTHOR });
  return ctx;
};

const entryF = async (ctx: Context): Promise<IndexEntry> => {
  const found = (await readIndex(ctx)).entries.find((e) => e.path === 'f');
  if (found === undefined) throw new Error('f is not tracked');
  return found;
};

const flagF = async (ctx: Context, flags: Partial<IndexEntryFlags>): Promise<void> => {
  const lock = await acquireIndexLock(ctx);
  try {
    const entries = (await readIndex(ctx)).entries.map((e) =>
      e.path === 'f' ? { ...e, flags: { ...e.flags, ...flags } } : e,
    );
    await lock.commit(entries, 'update');
  } finally {
    await lock.release();
  }
};

const touchF = async (ctx: Context, content = 'v1\n'): Promise<void> => {
  vi.setSystemTime(T0 + LATER_MS);
  await write(ctx, 'f', content);
};

describe('Given a tracked file rewritten with the same bytes later', () => {
  describe('When the index is refreshed', () => {
    it('Then the index records its new stat', async () => {
      // Arrange
      const ctx = await committedRepo();
      const before = await entryF(ctx);
      await touchF(ctx);

      // Act
      const sut = refreshAndWriteIndex;
      await sut(ctx);

      // Assert
      const after = await entryF(ctx);
      expect(after.mtimeSeconds).toBeGreaterThan(before.mtimeSeconds);
      expect(after.id).toBe(before.id);
    });
  });
});

describe('Given nothing drifted', () => {
  describe('When the index is refreshed', () => {
    it('Then the index file is rewritten with the same bytes as git does', async () => {
      // Arrange
      const ctx = await committedRepo();
      vi.setSystemTime(T0 + LATER_MS);
      const indexPath = `${ctx.layout.gitDir}/index`;
      const bytes = await ctx.fs.read(indexPath);
      const mtime = (await ctx.fs.stat(indexPath)).mtimeMs;

      // Act
      const sut = refreshAndWriteIndex;
      await sut(ctx);

      // Assert
      expect(await ctx.fs.read(indexPath)).toEqual(bytes);
      expect((await ctx.fs.stat(indexPath)).mtimeMs).toBeGreaterThan(mtime);
    });
  });
});

describe('Given a tracked file whose index stat stays stale', () => {
  describe.each([
    ['a content-dirty file', async (ctx: Context) => touchF(ctx, 'edited\n'), {}],
    ['an assume-unchanged file', async (ctx: Context) => touchF(ctx), { assumeValid: true }],
    ['a skip-worktree file', async (ctx: Context) => touchF(ctx), { skipWorktree: true }],
  ])('When the index is refreshed over %s', (_name, drift, flags) => {
    it('Then the entry keeps its recorded stat', async () => {
      // Arrange
      const ctx = await committedRepo();
      await flagF(ctx, flags);
      const before = await entryF(ctx);
      await drift(ctx);

      // Act
      const sut = refreshAndWriteIndex;
      await sut(ctx);

      // Assert
      expect(await entryF(ctx)).toEqual(before);
    });
  });
});

const entryFIn = (index: { readonly entries: ReadonlyArray<IndexEntry> }): IndexEntry => {
  const found = index.entries.find((e) => e.path === 'f');
  if (found === undefined) throw new Error('f is not tracked');
  return found;
};

describe('Given a touched clean tracked file', () => {
  describe('When the refreshed index is computed', () => {
    it('Then the returned index carries the new stat, the file is verified and the disk index is untouched', async () => {
      // Arrange
      const ctx = await committedRepo();
      const read = await readIndex(ctx);
      await touchF(ctx);

      // Act
      const result = await refreshedIndex(ctx, read);

      // Assert
      expect(entryFIn(result.currentIndex).mtimeSeconds).toBeGreaterThan(
        entryFIn(read).mtimeSeconds,
      );
      expect(result.refreshed.map((e) => e.path)).toEqual(['f']);
      expect(result.verified('f' as FilePath)).toBe(true);
      expect(await entryF(ctx)).toEqual(entryFIn(read));
    });
  });
});

describe('Given a tracked file whose stat stays stale in the refreshed index', () => {
  describe.each([
    ['a content-dirty file', async (ctx: Context) => touchF(ctx, 'edited\n'), {}],
    ['an assume-unchanged file', async (ctx: Context) => touchF(ctx), { assumeValid: true }],
    ['a skip-worktree file', async (ctx: Context) => touchF(ctx), { skipWorktree: true }],
  ])('When the refreshed index is computed over %s', (_name, drift, flags) => {
    it('Then the entry keeps its recorded stat and nothing is refreshed', async () => {
      // Arrange
      const ctx = await committedRepo();
      await flagF(ctx, flags);
      const read = await readIndex(ctx);
      await drift(ctx);

      // Act
      const result = await refreshedIndex(ctx, read);

      // Assert
      expect(entryFIn(result.currentIndex)).toEqual(entryFIn(read));
      expect(result.refreshed).toEqual([]);
    });
  });
});
