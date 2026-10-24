import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { type ChangedPath, status } from '../../../../src/application/commands/status.js';
import {
  invalidateIndexCache,
  readIndex,
} from '../../../../src/application/primitives/read-index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { serializeIndexFixtureAsync } from '../primitives/fixtures.js';
import { seedIndex } from './add-index-fixtures.js';

const author = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const MOVED_HEAD = 'b'.repeat(40);
const NO_SUBMODULE_CHANGE = {
  commitChanged: false,
  trackedChanges: false,
  untrackedChanges: false,
};

const gitlinkRow = (text: string) => ({ path: 'sub', text, mode: FILE_MODE.GITLINK });

const layOutModule = async (ctx: Context, head: string): Promise<void> => {
  const gitDir = `${ctx.layout.gitDir}/modules/sub`;
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/.git`, 'gitdir: ../.git/modules/sub\n');
  await ctx.fs.writeUtf8(`${gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.mkdir(`${gitDir}/objects`);
  await ctx.fs.writeUtf8(`${gitDir}/refs/heads/main`, `${head}\n`);
};

const idOf = async (ctx: Context, path: string): Promise<string | undefined> =>
  (await readIndex(ctx)).entries.find((entry) => entry.path === path)?.id;

/** `k` and a gitlink `sub` committed; the submodule checkout, when laid out, holds `head`. */
const committed = async (head?: string): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/k`, 'k\n');
  await seedIndex(ctx, [{ path: 'k', text: 'k\n' }, gitlinkRow('recorded\n')]);
  await commit(ctx, { message: 'first', author });
  if (head !== undefined) await layOutModule(ctx, head);
  return ctx;
};

const OVERSIZED_BYTES = (1 << 20) + 1;

const writeOversizedDotGit = (ctx: Context): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/.git`, 'x'.repeat(OVERSIZED_BYTES));

const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    return (err as { data: unknown }).data;
  }
  return undefined;
};

const markAssumeValid = async (ctx: Context, path: string): Promise<void> => {
  const index = await readIndex(ctx);
  const entries = index.entries.map((entry) =>
    entry.path === path ? { ...entry, flags: { ...entry.flags, assumeValid: true } } : entry,
  );
  invalidateIndexCache(ctx);
  await ctx.fs.write(
    `${ctx.layout.gitDir}/index`,
    await serializeIndexFixtureAsync({ ...index, entries }, ctx),
  );
};

const rowOf = async (ctx: Context, path: string): Promise<ChangedPath | undefined> =>
  (await status(ctx)).changes.find((change) => change.path === path);

describe('status submodule field', () => {
  describe('Given a gitlink whose submodule checkout moved', () => {
    describe('When status runs', () => {
      it('Then the row reports the commit as changed', async () => {
        // Arrange
        const ctx = await committed(MOVED_HEAD);
        const recorded = await idOf(ctx, 'sub');
        const sut = status;

        // Act
        const result = (await sut(ctx)).changes.find((change) => change.path === 'sub');

        // Assert
        expect(result).toEqual({
          path: 'sub',
          unstaged: 'modified',
          head: { id: recorded, mode: FILE_MODE.GITLINK },
          index: { id: recorded, mode: FILE_MODE.GITLINK },
          worktree: { mode: FILE_MODE.GITLINK },
          submodule: { ...NO_SUBMODULE_CHANGE, commitChanged: true },
        });
      });
    });
  });

  describe('Given a file in place of the gitlink', () => {
    describe('When status runs', () => {
      it('Then the row carries the three flags unset', async () => {
        // Arrange
        const ctx = await committed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub`, 'plain\n');

        // Act
        const result = await rowOf(ctx, 'sub');

        // Assert
        expect(result?.unstaged).toBe('type-changed');
        expect(result?.submodule).toEqual(NO_SUBMODULE_CHANGE);
      });
    });
  });

  describe('Given a modified regular file', () => {
    describe('When status runs', () => {
      it('Then the row has no submodule field', async () => {
        // Arrange
        const ctx = await committed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/k`, 'changed\n');

        // Act
        const result = await rowOf(ctx, 'k');

        // Assert
        expect(result?.unstaged).toBe('modified');
        expect('submodule' in (result as ChangedPath)).toBe(false);
      });
    });
  });

  describe('Given a gitlink removed from the index', () => {
    describe('When status runs', () => {
      it('Then the staged deletion carries the three flags unset', async () => {
        // Arrange
        const ctx = await committed();
        await seedIndex(ctx, [{ path: 'k', text: 'k\n' }]);

        // Act
        const result = await rowOf(ctx, 'sub');

        // Assert
        expect(result?.staged).toBe('deleted');
        expect(result?.submodule).toEqual(NO_SUBMODULE_CHANGE);
      });
    });
  });

  describe('Given a moved submodule staged in the index', () => {
    describe('When status runs', () => {
      it('Then the staged row carries the three flags unset', async () => {
        // Arrange
        const ctx = await committed();
        await seedIndex(ctx, [{ path: 'k', text: 'k\n' }, gitlinkRow('moved\n')]);
        await layOutModule(ctx, (await idOf(ctx, 'sub')) as string);

        // Act
        const result = await rowOf(ctx, 'sub');

        // Assert
        expect(result?.staged).toBe('modified');
        expect(result?.unstaged).toBeUndefined();
        expect(result?.submodule).toEqual(NO_SUBMODULE_CHANGE);
      });
    });
  });

  describe('Given a gitlink whose .git is a gitfile past the size git reads', () => {
    describe('When status runs', () => {
      it('Then it refuses with GITFILE_TOO_LARGE at the .git path', async () => {
        // Arrange
        const ctx = await committed();
        await writeOversizedDotGit(ctx);
        const sut = status;

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toEqual({ code: 'GITFILE_TOO_LARGE', path: 'sub/.git' });
      });
    });
  });

  describe('Given an assume-valid gitlink whose .git is a gitfile past the size git reads', () => {
    describe('When status runs', () => {
      it('Then it resolves without a row for the gitlink', async () => {
        // Arrange
        const ctx = await committed();
        await markAssumeValid(ctx, 'sub');
        await writeOversizedDotGit(ctx);
        const sut = status;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.changes.filter((change) => change.path === 'sub')).toEqual([]);
      });
    });
  });

  describe('Given a skip-worktree gitlink whose .git is a gitfile past the size git reads', () => {
    describe('When status runs', () => {
      it('Then it resolves without a row for the gitlink', async () => {
        // Arrange
        const ctx = await committed();
        await seedIndex(ctx, [
          { path: 'k', text: 'k\n' },
          { ...gitlinkRow('recorded\n'), skipWorktree: true },
        ]);
        await writeOversizedDotGit(ctx);
        const sut = status;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.changes.filter((change) => change.path === 'sub')).toEqual([]);
      });
    });
  });

  describe('Given a removed gitlink', () => {
    describe('When status runs', () => {
      it('Then the row is a deletion and nothing is refused', async () => {
        // Arrange
        const ctx = await committed();
        const sut = status;

        // Act
        const result = (await sut(ctx)).changes.find((change) => change.path === 'sub');

        // Assert
        expect(result?.unstaged).toBe('deleted');
      });
    });
  });
});
