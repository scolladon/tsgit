import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { type ChangedPath, status } from '../../../../src/application/commands/status.js';
import { deriveGitlinkContext } from '../../../../src/application/primitives/internal/submodule-context.js';
import {
  invalidateIndexCache,
  readIndex,
} from '../../../../src/application/primitives/read-index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../src/ports/context.js';
import { serializeIndexFixtureAsync } from '../primitives/fixtures.js';
import { seedIndex } from './add-index-fixtures.js';

const author = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const NO_SUBMODULE_CHANGE = {
  commitChanged: false,
  trackedChanges: false,
  untrackedChanges: false,
};

const gitlinkRow = (text: string) => ({ path: 'sub', text, mode: FILE_MODE.GITLINK });

const idOf = async (ctx: Context, path: string): Promise<string | undefined> =>
  (await readIndex(ctx)).entries.find((entry) => entry.path === path)?.id;

/** `k` and a gitlink `sub` committed. */
const committed = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/k`, 'k\n');
  await seedIndex(ctx, [{ path: 'k', text: 'k\n' }, gitlinkRow('recorded\n')]);
  await commit(ctx, { message: 'first', author });
  return ctx;
};

const recordGitlinkId = async (ctx: Context, id: ObjectId): Promise<void> => {
  const index = await readIndex(ctx);
  const entries = index.entries.map((entry) => (entry.path === 'sub' ? { ...entry, id } : entry));
  invalidateIndexCache(ctx);
  await ctx.fs.write(
    `${ctx.layout.gitDir}/index`,
    await serializeIndexFixtureAsync({ ...index, entries, extensions: [] }, ctx),
  );
  invalidateIndexCache(ctx);
};

/** A superproject whose gitlink `sub` records the HEAD of a real, clean submodule holding `u`; returns both contexts. */
const withRealSubmodule = async (): Promise<{ readonly ctx: Context; readonly child: Context }> => {
  const ctx = await committed();
  const child = deriveGitlinkContext(ctx, `${ctx.layout.gitDir}/modules/sub`, 'sub' as FilePath);
  await init(child);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/.git`, 'gitdir: ../.git/modules/sub\n');
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/u`, 'u\n');
  await seedIndex(child, [{ path: 'u', text: 'u\n' }]);
  const { id } = await commit(child, { message: 'child', author });
  await status(child);
  await recordGitlinkId(ctx, id);
  await commit(ctx, { message: 'record', author });
  return { ctx, child };
};

/** Advances the submodule's HEAD to a new commit, leaving its index and files clean. */
const advanceChild = async (ctx: Context, child: Context): Promise<ObjectId> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/v`, 'v\n');
  await seedIndex(child, [
    { path: 'u', text: 'u\n' },
    { path: 'v', text: 'v\n' },
  ]);
  return (await commit(child, { message: 'advance', author })).id;
};

const STAT_RESOLUTION_MS = 2_000;
// The index stores whole seconds, so a rewrite only looks stat-dirty once the clock has moved past one.
const settle = (): void => {
  vi.setSystemTime(Date.now() + STAT_RESOLUTION_MS);
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

const appendConfig = async (ctx: Context, text: string): Promise<void> => {
  const path = `${ctx.layout.gitDir}/config`;
  await ctx.fs.writeUtf8(path, `${await ctx.fs.readUtf8(path)}${text}`);
};

const writeGitmodules = (ctx: Context, text: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitmodules`, text);

const gitmodulesIgnoring = (mode: string, name = 'sub'): string =>
  `[submodule "${name}"]\n\tpath = sub\n\turl = ../up\n\tignore = ${mode}\n`;

/** A moved submodule and the extra config / `.gitmodules` text that governs its ignore mode. */
const movedWith = async (setup: {
  readonly config?: string;
  readonly gitmodules?: string;
}): Promise<Context> => {
  const { ctx, child } = await withRealSubmodule();
  await advanceChild(ctx, child);
  if (setup.config !== undefined) await appendConfig(ctx, setup.config);
  if (setup.gitmodules !== undefined) await writeGitmodules(ctx, setup.gitmodules);
  return ctx;
};

describe('status submodule field', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Given a gitlink whose submodule checkout moved', () => {
    describe('When status runs', () => {
      it('Then the row reports the commit as changed', async () => {
        // Arrange
        const { ctx, child } = await withRealSubmodule();
        const recorded = await idOf(ctx, 'sub');
        await advanceChild(ctx, child);
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
        const { ctx, child } = await withRealSubmodule();
        await recordGitlinkId(ctx, await advanceChild(ctx, child));

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
  describe('Given an unmoved submodule with an edited tracked file', () => {
    describe('When status runs', () => {
      it('Then the row reports tracked changes inside it', async () => {
        // Arrange
        const { ctx } = await withRealSubmodule();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/u`, 'edited\n');
        const sut = status;

        // Act
        const result = (await sut(ctx)).changes.find((change) => change.path === 'sub');

        // Assert
        expect(result).toMatchObject({
          path: 'sub',
          unstaged: 'modified',
          worktree: { mode: FILE_MODE.GITLINK },
          submodule: { commitChanged: false, trackedChanges: true, untrackedChanges: false },
        });
      });
    });
  });

  describe('Given an unmoved submodule with an untracked file', () => {
    describe('When status runs', () => {
      it('Then the row reports untracked changes inside it', async () => {
        // Arrange
        const { ctx } = await withRealSubmodule();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/n`, 'n\n');
        const sut = status;

        // Act
        const result = (await sut(ctx)).changes.find((change) => change.path === 'sub');

        // Assert
        expect(result).toMatchObject({
          unstaged: 'modified',
          submodule: { commitChanged: false, trackedChanges: false, untrackedChanges: true },
        });
      });
    });
  });

  describe('Given an unmoved clean submodule', () => {
    describe('When status runs', () => {
      it('Then it adds no row', async () => {
        // Arrange
        const { ctx } = await withRealSubmodule();
        const sut = status;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.changes).toEqual([]);
      });
    });
  });

  describe('Given a submodule file rewritten with the same bytes', () => {
    const childIndexAfter = async (refresh: boolean | undefined): Promise<Uint8Array> => {
      const { ctx, child } = await withRealSubmodule();
      settle();
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/u`, 'u\n');
      await status(ctx, refresh === undefined ? {} : { refresh });
      return ctx.fs.read(`${child.layout.gitDir}/index`);
    };
    const childIndexBefore = async (): Promise<Uint8Array> => {
      const { ctx, child } = await withRealSubmodule();
      return ctx.fs.read(`${child.layout.gitDir}/index`);
    };

    describe('When status runs with refresh disabled', () => {
      it('Then the submodule index is left untouched', async () => {
        // Arrange
        const before = await childIndexBefore();
        const sut = childIndexAfter;

        // Act
        const result = await sut(false);

        // Assert
        expect(result).toEqual(before);
      });
    });

    describe('When status runs by default', () => {
      it('Then the submodule index is refreshed', async () => {
        // Arrange
        const before = await childIndexBefore();
        const sut = childIndexAfter;

        // Act
        const result = await sut(undefined);

        // Assert
        expect(result).not.toEqual(before);
      });
    });
  });

  describe('Given a submodule whose index is corrupt', () => {
    describe('When status runs', () => {
      it('Then it rejects with the submodule index error', async () => {
        // Arrange
        const { ctx, child } = await withRealSubmodule();
        await ctx.fs.writeUtf8(`${child.layout.gitDir}/index`, 'junk\n');
        const sut = status;

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toEqual({
          code: 'INVALID_INDEX_HEADER',
          reason: 'file is shorter than the hash trailer',
        });
      });
    });
  });

  describe('Given diff.ignoreSubmodules = all and a moved gitlink', () => {
    describe('When status runs', () => {
      it('Then the gitlink row is absent and the tree is clean', async () => {
        // Arrange
        const ctx = await movedWith({ config: '[diff]\n\tignoreSubmodules = all\n' });
        const sut = status;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.changes.find((change) => change.path === 'sub')).toBeUndefined();
        expect(result.clean).toBe(true);
      });
    });
  });

  describe('Given .gitmodules ignoring a moved gitlink with all', () => {
    describe('When status runs', () => {
      it('Then the gitlink row is absent', async () => {
        // Arrange
        const ctx = await movedWith({ gitmodules: gitmodulesIgnoring('all') });
        const sut = status;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.changes.find((change) => change.path === 'sub')).toBeUndefined();
      });
    });
  });

  describe('Given .gitmodules ignore = none and diff.ignoreSubmodules = all', () => {
    describe('When status runs', () => {
      it('Then the gitlink row is reported as moved', async () => {
        // Arrange
        const ctx = await movedWith({
          gitmodules: gitmodulesIgnoring('none'),
          config: '[diff]\n\tignoreSubmodules = all\n',
        });
        const sut = status;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.changes.find((change) => change.path === 'sub')).toMatchObject({
          unstaged: 'modified',
        });
      });
    });
  });

  describe('Given a .gitmodules section named apart from its path with ignore = all', () => {
    describe('When status runs', () => {
      it('Then the gitlink row is absent', async () => {
        // Arrange
        const ctx = await movedWith({ gitmodules: gitmodulesIgnoring('all', 'nm') });
        const sut = status;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.changes.find((change) => change.path === 'sub')).toBeUndefined();
      });
    });
  });

  describe('Given submodule.sub.ignore = none in config and .gitmodules ignore = all', () => {
    describe('When status runs', () => {
      it('Then the gitlink row is reported as moved', async () => {
        // Arrange
        const ctx = await movedWith({
          gitmodules: gitmodulesIgnoring('all'),
          config: '[submodule "sub"]\n\tignore = none\n',
        });
        const sut = status;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.changes.find((change) => change.path === 'sub')).toMatchObject({
          unstaged: 'modified',
        });
      });
    });
  });

  describe('Given submodule.sub.ignore = none in config and diff.ignoreSubmodules = all', () => {
    describe('When status runs', () => {
      it('Then the gitlink row is reported as moved', async () => {
        // Arrange
        const ctx = await movedWith({
          config: '[submodule "sub"]\n\tignore = none\n[diff]\n\tignoreSubmodules = all\n',
        });
        const sut = status;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.changes.find((change) => change.path === 'sub')).toMatchObject({
          unstaged: 'modified',
        });
      });
    });
  });

  describe('Given submodule.sub.ignore = all in config and no .gitmodules row', () => {
    describe('When status runs', () => {
      it('Then the gitlink row is absent', async () => {
        // Arrange
        const ctx = await movedWith({ config: '[submodule "sub"]\n\tignore = all\n' });
        const sut = status;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.changes.find((change) => change.path === 'sub')).toBeUndefined();
      });
    });
  });

  describe('Given .gitmodules ignore = bogus', () => {
    describe('When status runs', () => {
      it('Then the gitlink row is reported as moved', async () => {
        // Arrange
        const ctx = await movedWith({ gitmodules: gitmodulesIgnoring('bogus') });
        const sut = status;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.changes.find((change) => change.path === 'sub')).toMatchObject({
          unstaged: 'modified',
        });
      });
    });
  });

  describe('Given submodule.sub.ignore = bogus in config', () => {
    describe('When status runs', () => {
      it('Then it refuses with the invalid value, its source and its line', async () => {
        // Arrange
        const { ctx, child } = await withRealSubmodule();
        await advanceChild(ctx, child);
        const before = (await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`)).split('\n').length;
        await appendConfig(ctx, '[submodule "sub"]\n\tignore = bogus\n');
        const sut = status;

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toEqual({
          code: 'CONFIG_INVALID_ENUM_VALUE',
          key: 'submodule.sub.ignore',
          source: `${ctx.layout.gitDir}/config`,
          value: 'bogus',
          line: before + 1,
        });
      });
    });
  });

  describe('Given diff.ignoreSubmodules = bogus in config', () => {
    describe('When status runs', () => {
      it('Then it refuses with the invalid value, its source and its line', async () => {
        // Arrange
        const { ctx, child } = await withRealSubmodule();
        await advanceChild(ctx, child);
        const before = (await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`)).split('\n').length;
        await appendConfig(ctx, '[diff]\n\tignoreSubmodules = bogus\n');
        const sut = status;

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toEqual({
          code: 'CONFIG_INVALID_ENUM_VALUE',
          key: 'diff.ignoreSubmodules'.toLowerCase(),
          source: `${ctx.layout.gitDir}/config`,
          value: 'bogus',
          line: before + 1,
        });
      });
    });
  });

  describe('Given submodule.sub.ignore without a value in config', () => {
    describe('When status runs', () => {
      it('Then it refuses with the missing value, its source and its line', async () => {
        // Arrange
        const { ctx, child } = await withRealSubmodule();
        await advanceChild(ctx, child);
        const before = (await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`)).split('\n').length;
        await appendConfig(ctx, '[submodule "sub"]\n\tignore\n');
        const sut = status;

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toEqual({
          code: 'CONFIG_MISSING_VALUE',
          key: 'submodule.sub.ignore',
          source: `${ctx.layout.gitDir}/config`,
          line: before + 1,
        });
      });
    });
  });

  describe('Given diff.ignoreSubmodules without a value in config', () => {
    describe('When status runs', () => {
      it('Then it refuses with the missing value', async () => {
        // Arrange
        const ctx = await movedWith({ config: '[diff]\n\tignoreSubmodules\n' });
        const sut = status;

        // Act
        const result = (await refusalOf(() => sut(ctx))) as { code: string; key: string };

        // Assert
        expect(result.code).toBe('CONFIG_MISSING_VALUE');
        expect(result.key).toBe('diff.ignoreSubmodules'.toLowerCase());
      });
    });
  });

  describe('Given an unmoved gitlink and submodule.sub.ignore = bogus', () => {
    describe('When status runs', () => {
      it('Then it still refuses with the invalid value', async () => {
        // Arrange
        const ctx = await committed();
        await appendConfig(ctx, '[submodule "sub"]\n\tignore = bogus\n');
        const sut = status;

        // Act
        const result = (await refusalOf(() => sut(ctx))) as { code: string; value: string };

        // Assert
        expect(result.code).toBe('CONFIG_INVALID_ENUM_VALUE');
        expect(result.value).toBe('bogus');
      });
    });
  });

  describe('Given no gitlink in the index and diff.ignoreSubmodules = bogus', () => {
    describe('When status runs', () => {
      it('Then it reads no ignore setting and reports a clean tree', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/k`, 'k\n');
        await seedIndex(ctx, [{ path: 'k', text: 'k\n' }]);
        await commit(ctx, { message: 'first', author });
        await appendConfig(ctx, '[diff]\n\tignoreSubmodules = bogus\n');
        const exists = vi.spyOn(ctx.fs, 'exists');
        const sut = status;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.clean).toBe(true);
        expect(exists).not.toHaveBeenCalledWith(`${ctx.layout.workDir}/.gitmodules`);
      });
    });
  });

  describe('Given a moved gitlink staged in the index under ignore = all', () => {
    describe('When status runs', () => {
      it('Then the staged row stays and the working-tree column is empty', async () => {
        // Arrange
        const { ctx, child } = await withRealSubmodule();
        await recordGitlinkId(ctx, await advanceChild(ctx, child));
        await writeGitmodules(ctx, gitmodulesIgnoring('all'));
        const sut = rowOf;

        // Act
        const result = await sut(ctx, 'sub');

        // Assert
        expect(result?.staged).toBe('modified');
        expect(result?.unstaged).toBeUndefined();
        expect(result?.submodule).toEqual(NO_SUBMODULE_CHANGE);
      });
    });
  });

  describe('Given a file in place of the gitlink under ignore = all', () => {
    describe('When status runs', () => {
      it('Then the type change is hidden', async () => {
        // Arrange
        const ctx = await committed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub`, 'plain\n');
        await writeGitmodules(ctx, gitmodulesIgnoring('all'));
        const sut = rowOf;

        // Act
        const result = await sut(ctx, 'sub');

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a removed gitlink under ignore = all', () => {
    describe('When status runs', () => {
      it('Then the deletion is hidden', async () => {
        // Arrange
        const ctx = await committed();
        await writeGitmodules(ctx, gitmodulesIgnoring('all'));
        const sut = rowOf;

        // Act
        const result = await sut(ctx, 'sub');

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a .gitmodules past the size git reads and a gitlink in the index', () => {
    describe('When status runs', () => {
      it('Then it refuses with the file, its size and the limit', async () => {
        // Arrange
        const ctx = await committed();
        await writeGitmodules(ctx, 'x'.repeat(OVERSIZED_BYTES));
        const sut = status;

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toEqual({
          code: 'WORKING_TREE_FILE_TOO_LARGE',
          path: `${ctx.layout.workDir}/.gitmodules`,
          size: OVERSIZED_BYTES,
          limit: OVERSIZED_BYTES - 1,
        });
      });
    });
  });
});
