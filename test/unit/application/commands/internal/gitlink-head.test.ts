import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { gitlinkHeadOf } from '../../../../../src/application/commands/internal/gitlink-head.js';
import { permissionDenied, TsgitError } from '../../../../../src/domain/error.js';
import type { FilePath } from '../../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../../src/ports/context.js';
import type { FileSystem } from '../../../../../src/ports/file-system.js';

const HEAD_COMMIT = 'c'.repeat(40);
const SUB = 'sub' as FilePath;

const guarded = (fs: FileSystem, allows: (path: string) => boolean): FileSystem =>
  new Proxy(fs, {
    get(target, property) {
      const member = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        const [first] = args;
        if (typeof first === 'string' && !allows(first)) {
          return Promise.reject(permissionDenied(first));
        }
        return member.apply(target, args);
      };
    },
  });

/** As a confining adapter: the parent's filesystem cannot reach `outside`, only a worktree filesystem granted its roots can. */
const confiningOutside = (ctx: Context, outside: string): Context => {
  const rootsOf = (granted: string | ReadonlyArray<string>) => [granted].flat();
  return {
    ...ctx,
    fs: guarded(ctx.fs, (path) => !path.startsWith(outside)),
    worktreeFs: (granted) =>
      guarded(
        ctx.fs,
        (path) =>
          !path.startsWith(outside) || rootsOf(granted).some((root) => path.startsWith(root)),
      ),
  };
};

const layOutRepository = async (ctx: Context, gitDir: string, head: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.mkdir(`${gitDir}/objects`);
  await ctx.fs.mkdir(`${gitDir}/refs`);
  await ctx.fs.writeUtf8(`${gitDir}/refs/heads/main`, `${head}\n`);
};

const failingLstatOfDotGit = (failure: unknown): Context => {
  const base = createMemoryContext();
  const lstat = async (path: string) => {
    if (path.endsWith('/sub/.git')) throw failure;
    return base.fs.lstat(path);
  };
  return { ...base, fs: Object.assign(Object.create(base.fs), { lstat }) } as Context;
};

describe('gitlinkHeadOf', () => {
  describe('Given a context without a work tree', () => {
    describe('When a gitlink head is asked', () => {
      it('Then the work tree is required by add', async () => {
        // Arrange
        const base = createMemoryContext();
        const ctx = {
          ...base,
          layout: { ...base.layout, workDir: undefined },
        } as unknown as Context;
        const sut = gitlinkHeadOf;

        // Act
        const outcome = sut(ctx, SUB);

        // Assert
        const err = await outcome.catch((e: unknown) => e);
        expect(err).toBeInstanceOf(TsgitError);
        expect((err as TsgitError).data).toEqual({ code: 'WORK_TREE_REQUIRED', operation: 'add' });
      });
    });
  });

  describe('Given a gitfile leading to a repository the parent filesystem cannot reach', () => {
    describe('When the gitlink head is asked', () => {
      it('Then the head is read through the filesystem granted for that repository', async () => {
        // Arrange
        const base = createMemoryContext();
        const away = `${base.layout.workDir}/away`;
        await layOutRepository(base, `${away}/module`, HEAD_COMMIT);
        await base.fs.writeUtf8(`${base.layout.workDir}/sub/.git`, `gitdir: ${away}/module\n`);
        const ctx = confiningOutside(base, away);
        const sut = gitlinkHeadOf;

        // Act
        const head = await sut(ctx, SUB);

        // Assert
        expect(head).toBe(HEAD_COMMIT);
      });
    });
  });

  describe('Given a linked worktree whose common dir the parent filesystem cannot reach', () => {
    describe('When the gitlink head is asked', () => {
      it('Then the common dir is read through the filesystem granted for it', async () => {
        // Arrange
        const base = createMemoryContext();
        const { gitDir, workDir } = base.layout;
        await base.fs.writeUtf8(`${workDir}/sub/.git`, 'gitdir: ../.git/admin\n');
        await base.fs.writeUtf8(`${gitDir}/admin/HEAD`, 'ref: refs/heads/main\n');
        await base.fs.writeUtf8(`${gitDir}/admin/commondir`, '../common\n');
        await layOutRepository(base, `${gitDir}/common`, HEAD_COMMIT);
        const ctx = confiningOutside(base, `${gitDir}/common`);
        const sut = gitlinkHeadOf;

        // Act
        const head = await sut(ctx, SUB);

        // Assert
        expect(head).toBe(HEAD_COMMIT);
      });
    });
  });

  describe('Given a .git symlink to a gitfile', () => {
    describe('When the gitlink head is asked', () => {
      it('Then the gitfile is followed to its repository', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { gitDir, workDir } = ctx.layout;
        await layOutRepository(ctx, `${gitDir}/modules/sub`, HEAD_COMMIT);
        await ctx.fs.writeUtf8(`${workDir}/sub/gitfile`, 'gitdir: ../.git/modules/sub\n');
        await ctx.fs.symlink('gitfile', `${workDir}/sub/.git`);
        const sut = gitlinkHeadOf;

        // Act
        const head = await sut(ctx, SUB);

        // Assert
        expect(head).toBe(HEAD_COMMIT);
      });
    });
  });

  describe('Given the probe of .git ending in a refusal that is not a missing file', () => {
    describe('When the gitlink head is asked', () => {
      it('Then the refusal surfaces', async () => {
        // Arrange
        const ctx = failingLstatOfDotGit(permissionDenied('sub/.git'));
        const sut = gitlinkHeadOf;

        // Act
        const err = await sut(ctx, SUB).catch((e: unknown) => e);

        // Assert
        expect(err).toBeInstanceOf(TsgitError);
        expect((err as TsgitError).data).toEqual({ code: 'PERMISSION_DENIED', path: 'sub/.git' });
      });
    });
  });

  describe('Given the probe of .git ending in a failure that is no tsgit error', () => {
    describe('When the gitlink head is asked', () => {
      it('Then the failure surfaces', async () => {
        // Arrange
        const ctx = failingLstatOfDotGit(new Error('disk on fire'));
        const sut = gitlinkHeadOf;

        // Act
        const err = await sut(ctx, SUB).catch((e: unknown) => e);

        // Assert
        expect((err as Error).message).toBe('disk on fire');
      });
    });
  });
});
