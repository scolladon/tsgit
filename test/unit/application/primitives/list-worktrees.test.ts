import { describe, expect, it } from 'vitest';
import { listWorktrees } from '../../../../src/application/primitives/list-worktrees.js';
import { TsgitError } from '../../../../src/domain/error.js';
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

  describe('Given a bare repository whose gitDir has no /.git suffix (bare.git)', () => {
    describe('When listWorktrees runs', () => {
      it('Then the main entry path is the gitdir itself and bare stays true', async () => {
        // Arrange — the `bare.git` shape: nothing to strip, so the derived
        // main path is the gitdir; the bare flag is layout-driven, unchanged.
        const base = await buildSeededContext();
        const gitDir = `${base.layout.workDir}/bare.git`;
        const ctx: Context = { ...base, layout: { ...base.layout, gitDir, bare: true } };
        await ctx.fs.writeUtf8(`${gitDir}/HEAD`, 'ref: refs/heads/main\n');

        // Act
        const result = await listWorktrees(ctx);

        // Assert
        expect(result).toEqual([
          {
            path: gitDir,
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
        // A real non-bare repo's config always carries an explicit
        // `core.bare = false` (git init writes it) — mainEntry's bareness
        // check reads it directly rather than trusting the opened (linked
        // worktree) Context's own already-resolved `layout.bare`.
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tbare = false\n');
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

  describe('Given a Context opened at a linked worktree of a bare main repo', () => {
    describe('When listWorktrees runs', () => {
      it('Then the main entry reports bare:true even though this worktree itself is not bare', async () => {
        // Arrange — the linked worktree's OWN resolved `layout.bare` is
        // false (a linked worktree always has a work tree, regardless of
        // the shared config); the main entry must still reflect the shared
        // `core.bare = true` it reads directly, not this Context's own
        // (necessarily different) resolved bareness.
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: OID_MAIN }],
        });
        await seedMainHead(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tbare = true\n');
        const adminGitDir = `${ctx.layout.workDir}/wts/self/.git`;
        const sut: Context = {
          ...ctx,
          layout: {
            ...ctx.layout,
            workDir: '/repo/wts/self',
            gitDir: adminGitDir,
            commonDir: ctx.layout.gitDir,
            bare: false,
          },
        };
        await ctx.fs.writeUtf8(`${adminGitDir}/HEAD`, 'ref: refs/heads/main\n');

        // Act
        const result = await listWorktrees(sut);

        // Assert
        expect(result).toEqual([
          {
            path: ctx.layout.workDir,
            detached: false,
            bare: true,
            main: true,
          },
        ]);
      });
    });
  });

  describe('Given the calling Context is itself opened at a different admin dir with its own HEAD', () => {
    describe('When listWorktrees runs', () => {
      it("Then a registered linked worktree resolves its OWN HEAD, not the calling Context's", async () => {
        // Arrange — the calling Context's own gitDir (`callerAdminDir`) is
        // deliberately kept OUTSIDE `<common>/worktrees/` so it is never
        // itself enumerated, and is seeded with a DIFFERENT HEAD than `wt`'s
        // own admin dir. If `wt`'s entry resolved against the calling
        // Context instead of a Context derived for `wt`'s own admin dir, it
        // would report `main`'s branch/oid here instead of `wt`'s.
        const ctx = await buildSeededContext({
          refs: [
            { name: 'refs/heads/main' as RefName, id: OID_MAIN },
            { name: 'refs/heads/wt' as RefName, id: OID_WT },
          ],
        });
        await seedMainHead(ctx);
        await seedAdmin(ctx, { id: 'wt', path: '/repo/wts/wt', head: 'ref: refs/heads/wt' });
        const callerAdminDir = `${ctx.layout.workDir}/wts/caller/.git`;
        await ctx.fs.writeUtf8(`${callerAdminDir}/HEAD`, 'ref: refs/heads/main\n');
        const sut: Context = {
          ...ctx,
          layout: {
            ...ctx.layout,
            workDir: '/repo/wts/caller',
            gitDir: callerAdminDir,
            commonDir: ctx.layout.gitDir,
          },
        };

        // Act
        const result = await listWorktrees(sut);

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

  describe('Given a linked worktree whose admin gitdir pointer is relative', () => {
    describe('When listWorktrees runs', () => {
      it('Then the entry path matches the one an absolute pointer produces', async () => {
        // Arrange — the admin dir sits 3 levels below the repo root
        // (`.git/worktrees/rel`), so `../../../wts/rel/.git` is the correctly
        // computed relative pointer back up to the worktree's real location —
        // the same shape `git worktree add --relative-paths` writes.
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: OID_MAIN }],
        });
        await seedMainHead(ctx);
        const admin = `${ctx.layout.gitDir}/worktrees/rel`;
        await ctx.fs.writeUtf8(`${admin}/HEAD`, `${OID_WT}\n`);
        await ctx.fs.writeUtf8(`${admin}/gitdir`, '../../../wts/rel/.git\n');

        // Act
        const result = await listWorktrees(ctx);

        // Assert — the reported path is the resolved absolute location, the
        // same value an absolute pointer at that location would produce.
        expect(result[1]?.path).toBe('/repo/wts/rel');
      });
    });
  });

  describe('Given a linked worktree whose relative admin gitdir pointer targets an existing directory', () => {
    describe('When listWorktrees runs', () => {
      it('Then it is NOT prunable — the exists probe checks the RESOLVED path, not the raw pointer', async () => {
        // Arrange — a separate consumer of the same pointer value from the
        // path-reporting test above: the exists probe that decides
        // `prunable` must ALSO see the resolved path.
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: OID_MAIN }],
        });
        await seedMainHead(ctx);
        const admin = `${ctx.layout.gitDir}/worktrees/rel`;
        await ctx.fs.writeUtf8(`${admin}/HEAD`, `${OID_WT}\n`);
        await ctx.fs.writeUtf8(`${admin}/gitdir`, '../../../wts/rel/.git\n');
        // The worktree directory the pointer resolves to actually exists.
        await ctx.fs.writeUtf8('/repo/wts/rel/.git', 'gitdir: x\n');

        // Act
        const result = await listWorktrees(ctx);

        // Assert
        expect(result[1]?.prunable).toBeUndefined();
      });
    });
  });

  describe('Given a relative admin gitdir pointer that still escapes the repository after resolution', () => {
    describe('When listWorktrees runs', () => {
      it('Then it continues to refuse, checking the RESOLVED path rather than the raw pointer', async () => {
        // Arrange — enough `..` segments to walk past the repo root
        // entirely; resolving must not become a containment bypass.
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: OID_MAIN }],
        });
        await seedMainHead(ctx);
        const admin = `${ctx.layout.gitDir}/worktrees/escaped`;
        await ctx.fs.writeUtf8(`${admin}/HEAD`, `${OID_WT}\n`);
        await ctx.fs.writeUtf8(`${admin}/gitdir`, '../../../../etc/evil/.git\n');

        // Act
        let caught: unknown;
        try {
          await listWorktrees(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert — the containment refusal names the RESOLVED path
        // ('/etc/evil/.git'), not the raw '../../../../etc/evil/.git'
        // pointer — proof the escape is checked post-resolution, not skipped.
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as { code: string; path: string };
        expect(data.code).toBe('PERMISSION_DENIED');
        expect(data.path).toBe('/etc/evil/.git');
      });
    });
  });

  describe('Given a linked worktree whose admin gitdir pointer is absolute', () => {
    describe('When listWorktrees runs', () => {
      it('Then the entry is unchanged — resolving an absolute pointer is a no-op', async () => {
        // Arrange — the idempotence arm: an absolute pointer must resolve to
        // itself, so this regresses to today's behaviour unchanged.
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: OID_MAIN }],
        });
        await seedMainHead(ctx);
        await seedAdmin(ctx, { id: 'abs', path: '/repo/wts/abs', head: OID_WT });

        // Act
        const result = await listWorktrees(ctx);

        // Assert
        expect(result[1]?.path).toBe('/repo/wts/abs');
        expect(result[1]?.prunable).toBeUndefined();
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
