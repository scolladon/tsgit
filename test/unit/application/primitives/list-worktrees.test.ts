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
});
