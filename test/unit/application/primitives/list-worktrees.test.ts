import { describe, expect, it } from 'vitest';
import { listWorktrees } from '../../../../src/application/primitives/list-worktrees.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from './fixtures.js';

const OID_MAIN = 'a'.repeat(40) as ObjectId;
const OID_WT = 'b'.repeat(40) as ObjectId;

const seedMainHead = async (ctx: Context): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
};

interface AdminSpec {
  readonly id: string;
  readonly path: string;
  readonly head: string; // raw HEAD content (without newline)
  readonly locked?: string; // present ⇒ locked with this reason
  readonly gitdirTarget?: string; // override the gitdir pointer (for prunable)
}

const seedAdmin = async (ctx: Context, spec: AdminSpec): Promise<void> => {
  const admin = `${ctx.layout.gitDir}/worktrees/${spec.id}`;
  await ctx.fs.writeUtf8(`${admin}/HEAD`, `${spec.head}\n`);
  await ctx.fs.writeUtf8(`${admin}/gitdir`, `${spec.gitdirTarget ?? `${spec.path}/.git`}\n`);
  if (spec.locked !== undefined) await ctx.fs.writeUtf8(`${admin}/locked`, spec.locked);
  // A present worktree dir so the entry is not prunable (unless overridden).
  if (spec.gitdirTarget === undefined) await ctx.fs.writeUtf8(`${spec.path}/.git`, 'gitdir: x\n');
};

describe('listWorktrees', () => {
  describe('Given a repository with only the main worktree', () => {
    describe('When listWorktrees runs', () => {
      it('Then it returns the single main entry', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: OID_MAIN }],
        });
        await seedMainHead(ctx);

        // Act
        const result = await listWorktrees(ctx);

        // Assert
        expect(result).toEqual([
          {
            path: ctx.layout.workDir,
            head: OID_MAIN,
            branch: 'refs/heads/main',
            detached: false,
            bare: false,
            main: true,
          },
        ]);
      });
    });
  });

  describe('Given a bare repository', () => {
    describe('When listWorktrees runs', () => {
      it('Then it returns a single bare main entry with no head or branch', async () => {
        // Arrange
        const base = await buildSeededContext();
        const ctx: Context = { ...base, layout: { ...base.layout, bare: true } };

        // Act
        const result = await listWorktrees(ctx);

        // Assert
        expect(result).toEqual([
          {
            path: base.layout.workDir,
            detached: false,
            bare: true,
            main: true,
          },
        ]);
      });
    });
  });

  describe('Given a repository with a separate git dir (no /.git suffix, no commonDir override)', () => {
    describe('When listWorktrees runs', () => {
      it('Then the main entry path is the gitdir itself, not workDir — the divergence fix', async () => {
        // Arrange — gitDir named `sep.git` (no `/.git` suffix to strip) and no
        // `commonDir` override, matching a real `--separate-git-dir` main
        // worktree. Kept under the memory adapter's sandboxed root.
        const base = await buildSeededContext();
        const gitDir = `${base.layout.workDir}/sep.git`;
        const ctx: Context = { ...base, layout: { ...base.layout, gitDir } };
        await ctx.fs.writeUtf8(`${gitDir}/HEAD`, 'ref: refs/heads/main\n');
        await ctx.fs.writeUtf8(`${gitDir}/refs/heads/main`, `${OID_MAIN}\n`);

        // Act
        const result = await listWorktrees(ctx);

        // Assert
        expect(result).toEqual([
          {
            path: gitDir,
            head: OID_MAIN,
            branch: 'refs/heads/main',
            detached: false,
            bare: false,
            main: true,
          },
        ]);
      });
    });
  });

  describe('Given a Context opened at a linked worktree', () => {
    describe('When listWorktrees runs', () => {
      it('Then the main entry path is derived from the common dir, not the opened workDir', async () => {
        // Arrange — the child's own admin gitdir is deliberately kept OUTSIDE
        // `<common>/worktrees/` so listWorktrees' linked-entry scan (which is
        // empty here) never sees it; this test targets only the main entry's
        // path derivation, not full worktree registration.
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: OID_MAIN }],
        });
        await seedMainHead(ctx);
        const adminGitDir = `${ctx.layout.workDir}/wts/self/.git`;
        const sut: Context = {
          ...ctx,
          layout: {
            ...ctx.layout,
            workDir: '/repo/wts/self',
            gitDir: adminGitDir,
            commonDir: ctx.layout.gitDir,
          },
        };
        await ctx.fs.writeUtf8(`${adminGitDir}/HEAD`, 'ref: refs/heads/main\n');

        // Act
        const result = await listWorktrees(sut);

        // Assert — derived from the common dir (strips its `/.git` suffix),
        // NOT `sut.layout.workDir` (the opened linked worktree's own path).
        expect(result).toEqual([
          {
            path: ctx.layout.workDir,
            head: OID_MAIN,
            branch: 'refs/heads/main',
            detached: false,
            bare: false,
            main: true,
          },
        ]);
      });
    });
  });

  describe('Given a linked branch worktree', () => {
    describe('When listWorktrees runs', () => {
      it('Then it reports the branch and resolved head', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [
            { name: 'refs/heads/main' as RefName, id: OID_MAIN },
            { name: 'refs/heads/wt' as RefName, id: OID_WT },
          ],
        });
        await seedMainHead(ctx);
        await seedAdmin(ctx, { id: 'wt', path: '/repo/wts/wt', head: 'ref: refs/heads/wt' });

        // Act
        const result = await listWorktrees(ctx);

        // Assert
        expect(result[1]).toEqual({
          id: 'wt',
          path: '/repo/wts/wt',
          head: OID_WT,
          branch: 'refs/heads/wt',
          detached: false,
          bare: false,
          main: false,
        });
      });
    });
  });

  describe('Given a detached linked worktree', () => {
    describe('When listWorktrees runs', () => {
      it('Then it reports a detached head with no branch', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: OID_MAIN }],
        });
        await seedMainHead(ctx);
        await seedAdmin(ctx, { id: 'det', path: '/repo/wts/det', head: OID_WT });

        // Act
        const result = await listWorktrees(ctx);

        // Assert
        expect(result[1]).toEqual({
          id: 'det',
          path: '/repo/wts/det',
          head: OID_WT,
          detached: true,
          bare: false,
          main: false,
        });
      });
    });
  });

  describe('Given a locked linked worktree', () => {
    describe('When listWorktrees runs', () => {
      it('Then it reports the lock reason', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: OID_MAIN }],
        });
        await seedMainHead(ctx);
        await seedAdmin(ctx, { id: 'lk', path: '/repo/wts/lk', head: OID_WT, locked: 'in use\n' });

        // Act
        const result = await listWorktrees(ctx);

        // Assert
        expect(result[1]?.locked).toEqual({ reason: 'in use' });
      });
    });
  });

  describe('Given a linked worktree whose directory is gone', () => {
    describe('When listWorktrees runs', () => {
      it('Then it is flagged prunable', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: OID_MAIN }],
        });
        await seedMainHead(ctx);
        await seedAdmin(ctx, {
          id: 'gone',
          path: '/repo/wts/gone',
          head: OID_WT,
          gitdirTarget: '/repo/wts/gone/.git',
        });

        // Act
        const result = await listWorktrees(ctx);

        // Assert
        expect(result[1]?.prunable).toBeDefined();
      });
    });
  });

  describe('Given a stray non-directory entry under the worktrees admin root', () => {
    describe('When listWorktrees runs', () => {
      it('Then the stray file is skipped and only the real worktree is listed', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: OID_MAIN }],
        });
        await seedMainHead(ctx);
        await seedAdmin(ctx, { id: 'wt', path: '/repo/wts/wt', head: OID_WT });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/worktrees/stray`, 'not a worktree dir\n');

        // Act
        const result = await listWorktrees(ctx);

        // Assert
        expect(result.map((e) => e.id)).toEqual([undefined, 'wt']);
      });
    });
  });

  describe('Given two linked worktrees out of path order', () => {
    describe('When listWorktrees runs', () => {
      it('Then linked entries are sorted by path after the main', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: OID_MAIN }],
        });
        await seedMainHead(ctx);
        await seedAdmin(ctx, { id: 'zebra', path: '/repo/wts/zebra', head: OID_WT });
        await seedAdmin(ctx, { id: 'alpha', path: '/repo/wts/alpha', head: OID_WT });

        // Act
        const result = await listWorktrees(ctx);

        // Assert
        expect(result.map((e) => e.path)).toEqual([
          ctx.layout.workDir,
          '/repo/wts/alpha',
          '/repo/wts/zebra',
        ]);
      });
    });
  });

  describe('Given two linked worktrees already in ascending path order', () => {
    describe('When listWorktrees runs', () => {
      it('Then the sort preserves ascending order after the main', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: OID_MAIN }],
        });
        await seedMainHead(ctx);
        await seedAdmin(ctx, { id: 'alpha', path: '/repo/wts/alpha', head: OID_WT });
        await seedAdmin(ctx, { id: 'zebra', path: '/repo/wts/zebra', head: OID_WT });

        // Act
        const result = await listWorktrees(ctx);

        // Assert
        expect(result.map((e) => e.path)).toEqual([
          ctx.layout.workDir,
          '/repo/wts/alpha',
          '/repo/wts/zebra',
        ]);
      });
    });
  });
});
