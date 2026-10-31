import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../../src/application/commands/init.js';
import { pruneWorktrees } from '../../../../../src/application/commands/internal/prune-worktrees.js';
import { commonGitDir } from '../../../../../src/application/primitives/path-layout.js';
import { permissionDenied } from '../../../../../src/domain/error.js';
import type { Context } from '../../../../../src/ports/context.js';

const NOW_SECONDS = 2_000_000_000;
const OLD_SECONDS = 1_000_000_000;
const KEEP_EVERYTHING = Number.NEGATIVE_INFINITY;
const PRUNE_EVERYTHING = Number.POSITIVE_INFINITY;
const CUTOFF = 1_500_000_000;
const HALF_SECOND = 0.5;

const seed = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  return ctx;
};

const rootOf = (ctx: Context): string => `${commonGitDir(ctx)}/worktrees`;
const adminOf = (ctx: Context, id: string): string => `${rootOf(ctx)}/${id}`;

/** An admin dir whose `gitdir` holds `pointer` and whose `index` exists. */
const writeAdmin = async (ctx: Context, id: string, pointer: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${adminOf(ctx, id)}/gitdir`, pointer);
  await ctx.fs.writeUtf8(`${adminOf(ctx, id)}/index`, 'index');
};

/** A live worktree: its `.git` gitfile exists where the admin `gitdir` points. */
const writeLive = async (ctx: Context, id: string, worktree: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${worktree}/.git`, `gitdir: ${adminOf(ctx, id)}\n`);
  await writeAdmin(ctx, id, `${worktree}/.git\n`);
};

/** Every `stat` of `path` reports `mtimeSeconds`. */
const forceMtime = (ctx: Context, path: string, mtimeSeconds: number): void => {
  const original = ctx.fs.stat.bind(ctx.fs);
  vi.spyOn(ctx.fs, 'stat').mockImplementation(async (target: string) => {
    const stat = await original(target);
    return target === path ? { ...stat, mtimeMs: mtimeSeconds * 1000 } : stat;
  });
};

const entriesOf = async (ctx: Context): Promise<ReadonlyArray<string>> =>
  (await ctx.fs.readdir(rootOf(ctx))).map((entry) => entry.name).sort();

const OPTIONS = { cutoff: CUTOFF, ignoreCase: false };

describe('pruneWorktrees', () => {
  describe('Given an admin dir whose gitdir file is empty', () => {
    describe('When worktrees are pruned', () => {
      it('Then the admin dir is removed regardless of expiry', async () => {
        // Arrange
        const ctx = await seed();
        await writeLive(ctx, 'live', '/repo/wts/live');
        await writeAdmin(ctx, 'empty', '');
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, { cutoff: KEEP_EVERYTHING, ignoreCase: false });

        // Assert
        expect(await entriesOf(ctx)).toEqual(['live']);
      });
    });
  });

  describe('Given an admin dir whose gitdir file holds only line ends', () => {
    describe('When worktrees are pruned', () => {
      it('Then the admin dir is removed as an invalid gitdir file', async () => {
        // Arrange
        const ctx = await seed();
        await writeLive(ctx, 'live', '/repo/wts/live');
        await writeAdmin(ctx, 'blank', '\r\n\n');
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, { cutoff: KEEP_EVERYTHING, ignoreCase: false });

        // Assert
        expect(await entriesOf(ctx)).toEqual(['live']);
      });
    });
  });

  describe('Given an admin dir with no gitdir file', () => {
    describe('When worktrees are pruned', () => {
      it('Then the admin dir is removed regardless of expiry', async () => {
        // Arrange
        const ctx = await seed();
        await writeLive(ctx, 'live', '/repo/wts/live');
        await ctx.fs.writeUtf8(`${adminOf(ctx, 'missing')}/index`, 'index');
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, { cutoff: KEEP_EVERYTHING, ignoreCase: false });

        // Assert
        expect(await entriesOf(ctx)).toEqual(['live']);
      });
    });
  });

  describe('Given an admin dir whose gitdir file cannot be opened', () => {
    describe('When worktrees are pruned', () => {
      it('Then the admin dir is removed regardless of expiry', async () => {
        // Arrange
        const ctx = await seed();
        await writeLive(ctx, 'live', '/repo/wts/live');
        await writeAdmin(ctx, 'denied', '/repo/wts/denied/.git\n');
        const denied = `${adminOf(ctx, 'denied')}/gitdir`;
        const original = ctx.fs.readUtf8.bind(ctx.fs);
        vi.spyOn(ctx.fs, 'readUtf8').mockImplementation(async (path: string) => {
          if (path === denied) throw permissionDenied(path);
          return original(path);
        });
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, { cutoff: KEEP_EVERYTHING, ignoreCase: false });

        // Assert
        expect(await entriesOf(ctx)).toEqual(['live']);
      });
    });
  });

  describe('Given an admin dir whose gitdir read fails with an unclassified fault', () => {
    describe('When worktrees are pruned', () => {
      it('Then the fault propagates and nothing is removed', async () => {
        // Arrange
        const ctx = await seed();
        await writeAdmin(ctx, 'faulty', '/repo/wts/faulty/.git\n');
        const faulty = `${adminOf(ctx, 'faulty')}/gitdir`;
        const fault = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        const original = ctx.fs.readUtf8.bind(ctx.fs);
        vi.spyOn(ctx.fs, 'readUtf8').mockImplementation(async (path: string) => {
          if (path === faulty) throw fault;
          return original(path);
        });
        const sut = pruneWorktrees;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { cutoff: PRUNE_EVERYTHING, ignoreCase: false });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBe(fault);
        expect(await entriesOf(ctx)).toEqual(['faulty']);
      });
    });
  });

  describe('Given a non-directory entry in the worktrees registry', () => {
    describe('When worktrees are pruned', () => {
      it('Then the entry is removed regardless of expiry', async () => {
        // Arrange
        const ctx = await seed();
        await writeLive(ctx, 'live', '/repo/wts/live');
        await ctx.fs.writeUtf8(`${rootOf(ctx)}/stray`, 'junk');
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, { cutoff: KEEP_EVERYTHING, ignoreCase: false });

        // Assert
        expect(await entriesOf(ctx)).toEqual(['live']);
      });
    });
  });

  describe('Given admin entries that are symlinks', () => {
    const outsideOf = (ctx: Context): string => `${ctx.layout.workDir}/elsewhere`;

    /** A registry entry `id` linking to `target`. */
    const link = async (ctx: Context, id: string, target: string): Promise<void> => {
      await ctx.fs.mkdir(rootOf(ctx));
      await ctx.fs.symlink(target, adminOf(ctx, id));
    };

    describe('When one names the admin dir of a live worktree', () => {
      it('Then the link is kept, as git follows it', async () => {
        // Arrange
        const ctx = await seed();
        const OUTSIDE = outsideOf(ctx);
        await ctx.fs.writeUtf8(`${OUTSIDE}/live/.git`, 'gitdir: x\n');
        await ctx.fs.writeUtf8(`${OUTSIDE}/admin/gitdir`, `${OUTSIDE}/live/.git\n`);
        await link(ctx, 'wt', `${OUTSIDE}/admin`);
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, { cutoff: PRUNE_EVERYTHING, ignoreCase: false });

        // Assert
        expect(await entriesOf(ctx)).toEqual(['wt']);
      });
    });

    describe('When one names an admin dir whose relative gitdir is live beside the link target', () => {
      it('Then the pointer resolves against the target, as git realpaths the admin dir', async () => {
        // Arrange
        const ctx = await seed();
        const OUTSIDE = outsideOf(ctx);
        await ctx.fs.writeUtf8(`${OUTSIDE}/live/.git`, 'gitdir: x\n');
        await ctx.fs.writeUtf8(`${OUTSIDE}/admin/gitdir`, '../live/.git\n');
        await link(ctx, 'wt', `${OUTSIDE}/admin`);
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, { cutoff: PRUNE_EVERYTHING, ignoreCase: false });

        // Assert
        expect(await entriesOf(ctx)).toEqual(['wt']);
      });
    });

    describe('When one reaches its admin dir through a chain longer than the context’s hop limit', () => {
      it('Then the pointer resolves beside the link, the limit having reached the realpath', async () => {
        // Arrange
        const base = await seed();
        const OUTSIDE = outsideOf(base);
        await base.fs.writeUtf8(`${OUTSIDE}/live/.git`, 'gitdir: x\n');
        await base.fs.writeUtf8(`${OUTSIDE}/admin/gitdir`, '../live/.git\n');
        await base.fs.symlink(`${OUTSIDE}/admin`, `${OUTSIDE}/hop4`);
        for (const hop of [3, 2, 1]) {
          await base.fs.symlink(`${OUTSIDE}/hop${hop + 1}`, `${OUTSIDE}/hop${hop}`);
        }
        await link(base, 'wt', `${OUTSIDE}/hop1`);
        const ctx: Context = { ...base, symlinkHopLimit: 3 };
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, { cutoff: PRUNE_EVERYTHING, ignoreCase: false });

        // Assert
        expect(await ctx.fs.exists(rootOf(ctx))).toBe(false);
      });
    });

    describe('When one reaches its admin dir through that chain and the hop limit allows it', () => {
      it('Then the pointer resolves beside the target and the link is kept', async () => {
        // Arrange
        const ctx = await seed();
        const OUTSIDE = outsideOf(ctx);
        await ctx.fs.writeUtf8(`${OUTSIDE}/live/.git`, 'gitdir: x\n');
        await ctx.fs.writeUtf8(`${OUTSIDE}/admin/gitdir`, '../live/.git\n');
        await ctx.fs.symlink(`${OUTSIDE}/admin`, `${OUTSIDE}/hop4`);
        for (const hop of [3, 2, 1]) {
          await ctx.fs.symlink(`${OUTSIDE}/hop${hop + 1}`, `${OUTSIDE}/hop${hop}`);
        }
        await link(ctx, 'wt', `${OUTSIDE}/hop1`);
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, { cutoff: PRUNE_EVERYTHING, ignoreCase: false });

        // Assert
        expect(await entriesOf(ctx)).toEqual(['wt']);
      });
    });

    describe('When one names the admin dir of a vanished worktree past the cutoff', () => {
      it('Then the directory it names is emptied through it, nested links unlinked unfollowed, and the link goes', async () => {
        // Arrange
        const ctx = await seed();
        const OUTSIDE = outsideOf(ctx);
        await ctx.fs.writeUtf8(`${OUTSIDE}/admin/gitdir`, `${OUTSIDE}/gone/.git\n`);
        await ctx.fs.writeUtf8(`${OUTSIDE}/admin/logs/HEAD`, 'log');
        await ctx.fs.writeUtf8(`${OUTSIDE}/other/deep/f`, 'o');
        await ctx.fs.symlink(`${OUTSIDE}/other`, `${OUTSIDE}/admin/nested`);
        await link(ctx, 'wt', `${OUTSIDE}/admin`);
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, { cutoff: PRUNE_EVERYTHING, ignoreCase: false });

        // Assert
        expect(await ctx.fs.exists(rootOf(ctx))).toBe(false);
        expect(await ctx.fs.readdir(`${OUTSIDE}/admin`)).toEqual([]);
        expect(await ctx.fs.readUtf8(`${OUTSIDE}/other/deep/f`)).toBe('o');
      });
    });

    describe('When the context offers confined filesystems and one names a vanished worktree', () => {
      it('Then the target is emptied through the filesystem confined to it', async () => {
        // Arrange
        const base = await seed();
        const OUTSIDE = outsideOf(base);
        await base.fs.writeUtf8(`${OUTSIDE}/admin/gitdir`, `${OUTSIDE}/gone/.git\n`);
        await link(base, 'wt', `${OUTSIDE}/admin`);
        const removed: string[] = [];
        const confined = {
          ...base.fs,
          rmRecursive: async (path: string) => {
            removed.push(path);
            await base.fs.rmRecursive(path);
          },
        };
        const worktreeFs = vi.fn((_roots: string | ReadonlyArray<string>) => confined);
        const ctx: Context = { ...base, worktreeFs };
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, { cutoff: PRUNE_EVERYTHING, ignoreCase: false });

        // Assert
        expect(worktreeFs).toHaveBeenCalledWith(`${OUTSIDE}/admin`);
        expect(removed).toEqual([`${OUTSIDE}/admin/gitdir`]);
      });
    });

    describe('When one dangles', () => {
      it('Then the link is kept, as git finds nothing to open and nothing to unlink', async () => {
        // Arrange
        const ctx = await seed();
        const OUTSIDE = outsideOf(ctx);
        await link(ctx, 'wt', `${OUTSIDE}/nowhere`);
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, { cutoff: PRUNE_EVERYTHING, ignoreCase: false });

        // Assert
        expect(await entriesOf(ctx)).toEqual(['wt']);
      });
    });

    describe('When stat through one fails with an unclassified fault', () => {
      it('Then the fault propagates and the link stays', async () => {
        // Arrange
        const ctx = await seed();
        await link(ctx, 'wt', `${outsideOf(ctx)}/admin`);
        const fault = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        const original = ctx.fs.stat.bind(ctx.fs);
        vi.spyOn(ctx.fs, 'stat').mockImplementation(async (path: string) => {
          if (path === adminOf(ctx, 'wt')) throw fault;
          return original(path);
        });
        const sut = pruneWorktrees;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { cutoff: PRUNE_EVERYTHING, ignoreCase: false });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBe(fault);
        expect(await entriesOf(ctx)).toEqual(['wt']);
      });
    });

    describe('When the path probe cannot resolve the admin dir', () => {
      it('Then a relative gitdir resolves against the registry path', async () => {
        // Arrange
        const base = await seed();
        const OUTSIDE = outsideOf(base);
        await base.fs.writeUtf8(`${OUTSIDE}/live/.git`, 'gitdir: x\n');
        await base.fs.writeUtf8(`${OUTSIDE}/admin/gitdir`, '../live/.git\n');
        await link(base, 'wt', `${OUTSIDE}/admin`);
        const notADirectory = Object.assign(new Error('ENOTDIR'), {
          data: { code: 'NOT_A_DIRECTORY' },
        });
        const ctx: Context = {
          ...base,
          alternatePathProbe: () => ({
            lstat: () => Promise.reject(notADirectory),
            readlink: base.fs.readlink.bind(base.fs),
            stat: base.fs.stat.bind(base.fs),
          }),
        };
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, { cutoff: PRUNE_EVERYTHING, ignoreCase: false });

        // Assert — `<registry>/wt/../live/.git` names nothing, so the entry is pruned.
        expect(await ctx.fs.exists(rootOf(ctx))).toBe(false);
      });
    });

    describe('When one names a file', () => {
      it('Then the link goes and the file stays', async () => {
        // Arrange
        const ctx = await seed();
        const OUTSIDE = outsideOf(ctx);
        await ctx.fs.writeUtf8(`${OUTSIDE}/file`, 'x');
        await link(ctx, 'wt', `${OUTSIDE}/file`);
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, { cutoff: PRUNE_EVERYTHING, ignoreCase: false });

        // Assert
        expect(await ctx.fs.exists(rootOf(ctx))).toBe(false);
        expect(await ctx.fs.readUtf8(`${OUTSIDE}/file`)).toBe('x');
      });
    });
  });

  describe('Given a pruned admin entry that is a real directory', () => {
    describe('When worktrees are pruned', () => {
      it('Then the whole directory goes in one recursive removal, not child by child', async () => {
        // Arrange
        const base = await seed();
        await writeAdmin(base, 'gone', '/repo/wts/gone/.git\n');
        const removed: string[] = [];
        const fs = {
          ...base.fs,
          rmRecursive: async (path: string) => {
            removed.push(path);
            await base.fs.rmRecursive(path);
          },
        };
        const ctx: Context = { ...base, fs };
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, { cutoff: PRUNE_EVERYTHING, ignoreCase: false });

        // Assert
        expect(removed).toEqual([adminOf(ctx, 'gone')]);
        expect(await ctx.fs.exists(adminOf(ctx, 'gone'))).toBe(false);
      });
    });
  });

  describe('Given a locked admin dir whose gitdir is empty', () => {
    describe('When worktrees are pruned', () => {
      it('Then the locked admin dir is kept', async () => {
        // Arrange
        const ctx = await seed();
        await writeAdmin(ctx, 'locked', '');
        await ctx.fs.writeUtf8(`${adminOf(ctx, 'locked')}/locked`, '');
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, { cutoff: PRUNE_EVERYTHING, ignoreCase: false });

        // Assert
        expect(await entriesOf(ctx)).toEqual(['locked']);
      });
    });
  });

  describe('Given a gitdir pointing at a vanished worktree', () => {
    describe('When its index is older than the cutoff', () => {
      it('Then the admin dir is removed', async () => {
        // Arrange
        const ctx = await seed();
        await writeLive(ctx, 'live', '/repo/wts/live');
        await writeAdmin(ctx, 'gone', '/repo/wts/gone/.git\n');
        forceMtime(ctx, `${adminOf(ctx, 'gone')}/index`, OLD_SECONDS);
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, OPTIONS);

        // Assert
        expect(await entriesOf(ctx)).toEqual(['live']);
      });
    });

    describe('When its index mtime falls within the cutoff second', () => {
      it('Then the admin dir is removed', async () => {
        // Arrange
        const ctx = await seed();
        await writeLive(ctx, 'live', '/repo/wts/live');
        await writeAdmin(ctx, 'gone', '/repo/wts/gone/.git\n');
        forceMtime(ctx, `${adminOf(ctx, 'gone')}/index`, CUTOFF + HALF_SECOND);
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, OPTIONS);

        // Assert
        expect(await entriesOf(ctx)).toEqual(['live']);
      });
    });

    describe('When its index is newer than the cutoff', () => {
      it('Then the admin dir is kept', async () => {
        // Arrange
        const ctx = await seed();
        await writeAdmin(ctx, 'gone', '/repo/wts/gone/.git\n');
        forceMtime(ctx, `${adminOf(ctx, 'gone')}/index`, CUTOFF + 1);
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, OPTIONS);

        // Assert
        expect(await entriesOf(ctx)).toEqual(['gone']);
      });
    });

    describe('When its index is missing', () => {
      it('Then the admin dir is removed even under a keep-everything cutoff', async () => {
        // Arrange
        const ctx = await seed();
        await writeLive(ctx, 'live', '/repo/wts/live');
        await ctx.fs.writeUtf8(`${adminOf(ctx, 'gone')}/gitdir`, '/repo/wts/gone/.git\n');
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, { cutoff: KEEP_EVERYTHING, ignoreCase: false });

        // Assert
        expect(await entriesOf(ctx)).toEqual(['live']);
      });
    });

    describe('When its index stat fails with an unclassified fault', () => {
      it('Then the fault propagates', async () => {
        // Arrange
        const ctx = await seed();
        await writeAdmin(ctx, 'gone', '/repo/wts/gone/.git\n');
        const index = `${adminOf(ctx, 'gone')}/index`;
        const fault = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        const original = ctx.fs.stat.bind(ctx.fs);
        vi.spyOn(ctx.fs, 'stat').mockImplementation(async (path: string) => {
          if (path === index) throw fault;
          return original(path);
        });
        const sut = pruneWorktrees;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, OPTIONS);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBe(fault);
      });
    });
  });

  describe('Given a gitdir pointing where the filesystem refuses to look', () => {
    describe('When its index is older than the cutoff', () => {
      it('Then the worktree reads as vanished and the admin dir is removed', async () => {
        // Arrange
        const ctx = await seed();
        await writeLive(ctx, 'live', '/repo/wts/live');
        await writeAdmin(ctx, 'outside', '/outside/wt/.git\n');
        forceMtime(ctx, `${adminOf(ctx, 'outside')}/index`, OLD_SECONDS);
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, OPTIONS);

        // Assert
        expect(await entriesOf(ctx)).toEqual(['live']);
      });
    });

    describe('When the existence probe fails with an unclassified fault', () => {
      it('Then the fault propagates', async () => {
        // Arrange
        const ctx = await seed();
        await writeAdmin(ctx, 'gone', '/repo/wts/gone/.git\n');
        const fault = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
        vi.spyOn(ctx.fs, 'exists').mockImplementation(async (path: string) => {
          if (path === '/repo/wts/gone/.git') throw fault;
          return path.endsWith('/worktrees');
        });
        const sut = pruneWorktrees;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, OPTIONS);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBe(fault);
      });
    });
  });

  describe('Given a live worktree whose index is older than the cutoff', () => {
    describe('When worktrees are pruned', () => {
      it('Then the admin dir is kept', async () => {
        // Arrange
        const ctx = await seed();
        await writeLive(ctx, 'live', '/repo/wts/live');
        forceMtime(ctx, `${adminOf(ctx, 'live')}/index`, OLD_SECONDS);
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, { cutoff: NOW_SECONDS, ignoreCase: false });

        // Assert
        expect(await entriesOf(ctx)).toEqual(['live']);
      });
    });
  });

  describe('Given a relative gitdir pointer with a CRLF line end', () => {
    describe('When worktrees are pruned', () => {
      it('Then it resolves against the admin dir and the live worktree is kept', async () => {
        // Arrange
        const ctx = await seed();
        await writeLive(ctx, 'live', '/repo/wts/live');
        await ctx.fs.writeUtf8(`${adminOf(ctx, 'live')}/gitdir`, '../../../wts/live/.git\r\n');
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, { cutoff: PRUNE_EVERYTHING, ignoreCase: false });

        // Assert
        expect(await entriesOf(ctx)).toEqual(['live']);
      });
    });
  });

  describe('Given a gitdir pointer that starts with a line end', () => {
    describe('When worktrees are pruned', () => {
      it('Then only trailing line ends are stripped, so the pointer names nothing', async () => {
        // Arrange
        const ctx = await seed();
        await writeLive(ctx, 'live', '/repo/wts/live');
        await ctx.fs.writeUtf8(`${adminOf(ctx, 'live')}/gitdir`, '\n/repo/wts/live/.git');
        await writeLive(ctx, 'other', '/repo/wts/other');
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, { cutoff: PRUNE_EVERYTHING, ignoreCase: false });

        // Assert
        expect(await entriesOf(ctx)).toEqual(['other']);
      });
    });
  });

  describe('Given three admin dirs pointing at the same live worktree', () => {
    describe('When worktrees are pruned', () => {
      it('Then all but the first id are removed as duplicates', async () => {
        // Arrange
        const ctx = await seed();
        await writeLive(ctx, 'b', '/repo/wts/live');
        await writeAdmin(ctx, 'c', '/repo/wts/live/.git\n');
        await writeAdmin(ctx, 'a', '/repo/wts/live/.git\n');
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, OPTIONS);

        // Assert
        expect(await entriesOf(ctx)).toEqual(['a']);
      });
    });
  });

  describe('Given an admin dir pointing at the main repository', () => {
    describe('When worktrees are pruned', () => {
      it('Then it is removed as a duplicate of the main worktree', async () => {
        // Arrange
        const ctx = await seed();
        await writeLive(ctx, 'live', '/repo/wts/live');
        await writeAdmin(ctx, 'main', `${commonGitDir(ctx)}\n`);
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, OPTIONS);

        // Assert
        expect(await entriesOf(ctx)).toEqual(['live']);
      });
    });
  });

  describe('Given absolute gitdir pointers naming one worktree through ./ and // spellings', () => {
    describe('When worktrees are pruned', () => {
      it('Then every spelling is kept, as git compares an absolute pointer as written', async () => {
        // Arrange
        const ctx = await seed();
        await writeLive(ctx, 'a', '/repo/wts/live');
        await writeAdmin(ctx, 'b', '/repo/wts/live/./.git\n');
        await writeAdmin(ctx, 'c', '/repo/wts//live/.git\n');
        await writeAdmin(ctx, 'd', `${commonGitDir(ctx)}/.\n`);
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, OPTIONS);

        // Assert
        expect(await entriesOf(ctx)).toEqual(['a', 'b', 'c', 'd']);
      });
    });
  });

  describe('Given two admin dirs whose live paths differ only by case', () => {
    describe('When core.ignoreCase folds paths', () => {
      it('Then the later id is removed as a duplicate', async () => {
        // Arrange
        const ctx = await seed();
        await writeLive(ctx, 'a', '/repo/wts/live');
        await writeLive(ctx, 'b', '/repo/wts/LIVE');
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, { cutoff: CUTOFF, ignoreCase: true });

        // Assert
        expect(await entriesOf(ctx)).toEqual(['a']);
      });
    });

    describe('When core.ignoreCase is off', () => {
      it('Then both are kept', async () => {
        // Arrange
        const ctx = await seed();
        await writeLive(ctx, 'a', '/repo/wts/live');
        await writeLive(ctx, 'b', '/repo/wts/LIVE');
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, OPTIONS);

        // Assert
        expect(await entriesOf(ctx)).toEqual(['a', 'b']);
      });
    });
  });

  describe('Given every admin dir is pruned', () => {
    describe('When worktrees are pruned', () => {
      it('Then the emptied worktrees dir is removed too', async () => {
        // Arrange
        const ctx = await seed();
        await writeAdmin(ctx, 'empty', '');
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, OPTIONS);

        // Assert
        expect(await ctx.fs.exists(rootOf(ctx))).toBe(false);
      });
    });
  });

  describe('Given no worktrees dir', () => {
    describe('When worktrees are pruned', () => {
      it('Then nothing is created', async () => {
        // Arrange
        const ctx = await seed();
        const sut = pruneWorktrees;

        // Act
        await sut(ctx, OPTIONS);

        // Assert
        expect(await ctx.fs.exists(rootOf(ctx))).toBe(false);
      });
    });
  });
});
