import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import {
  worktreeAdd,
  worktreeList,
  worktreeMove,
  worktreeRemove,
} from '../../../../src/application/commands/worktree.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from '../primitives/fixtures.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const seedWithCommit = async (): Promise<{ ctx: Context; commitId: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const c = await commit(ctx, { message: 'first', author });
  return { ctx, commitId: c.id };
};

const expectError = async (fn: () => Promise<unknown>, code: string): Promise<void> => {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  expect((caught as TsgitError).data.code).toBe(code);
};

const adminFile = (ctx: Context, id: string, name: string): string =>
  `${ctx.layout.gitDir}/worktrees/${id}/${name}`;

const reflogLineCount = async (ctx: Context, id: string): Promise<number> =>
  (await ctx.fs.readUtf8(adminFile(ctx, id, 'logs/HEAD'))).split('\n').filter((l) => l !== '')
    .length;

describe('worktreeList', () => {
  describe('Given a repository with only the main worktree', () => {
    describe('When worktreeList runs', () => {
      it('Then it returns the structured entries', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: 'a'.repeat(40) as ObjectId }],
        });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

        // Act
        const result = await worktreeList(ctx);

        // Assert
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]).toMatchObject({ branch: 'refs/heads/main', main: true });
      });
    });
  });

  describe('Given a path that is not a repository', () => {
    describe('When worktreeList runs', () => {
      it('Then it throws NOT_A_REPOSITORY', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act & Assert
        await expectError(() => worktreeList(ctx), 'NOT_A_REPOSITORY');
      });
    });
  });
});

describe('worktreeAdd', () => {
  describe('Given a repo and no commit-ish or branch', () => {
    describe('When worktreeAdd runs', () => {
      it('Then it creates a branch named after the path basename', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();

        // Act
        const result = await worktreeAdd(ctx, { path: 'wt' });

        // Assert
        expect(result).toMatchObject({
          path: '/repo/wt',
          branch: 'refs/heads/wt',
          detached: false,
          head: commitId,
        });
        expect(await ctx.fs.readUtf8(adminFile(ctx, result.id, 'HEAD'))).toBe(
          'ref: refs/heads/wt\n',
        );
        expect(await ctx.fs.readUtf8(adminFile(ctx, result.id, 'commondir'))).toBe('../..\n');
        expect(await ctx.fs.readUtf8(`/repo/wt/.git`)).toBe(
          `gitdir: ${ctx.layout.gitDir}/worktrees/${result.id}\n`,
        );
        expect(await ctx.fs.exists('/repo/wt/a.txt')).toBe(true);
        expect(await ctx.fs.exists(adminFile(ctx, result.id, 'index'))).toBe(true);
        expect(await reflogLineCount(ctx, result.id)).toBe(2);
      });
    });
  });

  describe('Given a repo and a -b branch option', () => {
    describe('When worktreeAdd runs', () => {
      it('Then it creates the named branch', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();

        // Act
        const result = await worktreeAdd(ctx, { path: 'wt2', branch: 'feat' });

        // Assert
        expect(result.branch).toBe('refs/heads/feat');
        expect(await ctx.fs.readUtf8(adminFile(ctx, result.id, 'HEAD'))).toBe(
          'ref: refs/heads/feat\n',
        );
      });
    });
  });

  describe('Given a repo and a commit-ish that names an existing branch', () => {
    describe('When worktreeAdd runs', () => {
      it('Then it checks out that branch without creating a new one', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'topic' });

        // Act
        const result = await worktreeAdd(ctx, { path: 'wt3', commitish: 'topic' });

        // Assert
        expect(result.branch).toBe('refs/heads/topic');
        expect(result.detached).toBe(false);
        expect(await reflogLineCount(ctx, result.id)).toBe(2);
      });
    });
  });

  describe('Given a repo and --detach', () => {
    describe('When worktreeAdd runs', () => {
      it('Then it creates a detached worktree with a single reflog entry', async () => {
        // Arrange
        const { ctx, commitId } = await seedWithCommit();

        // Act
        const result = await worktreeAdd(ctx, { path: 'wt4', detach: true });

        // Assert
        expect(result.detached).toBe(true);
        expect(result.branch).toBeUndefined();
        expect(await ctx.fs.readUtf8(adminFile(ctx, result.id, 'HEAD'))).toBe(`${commitId}\n`);
        expect(await reflogLineCount(ctx, result.id)).toBe(1);
      });
    });
  });

  describe('Given a non-empty target directory', () => {
    describe('When worktreeAdd runs', () => {
      it('Then it refuses with WORKTREE_PATH_EXISTS', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await ctx.fs.writeUtf8('/repo/taken/keep.txt', 'x');

        // Act & Assert
        await expectError(() => worktreeAdd(ctx, { path: 'taken' }), 'WORKTREE_PATH_EXISTS');
      });
    });
  });

  describe('Given a path that resolves to the filesystem root', () => {
    describe('When worktreeAdd runs', () => {
      it('Then it refuses with INVALID_OPTION', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();

        // Act & Assert
        await expectError(() => worktreeAdd(ctx, { path: '/' }), 'INVALID_OPTION');
      });
    });
  });

  describe('Given a -b branch that already exists', () => {
    describe('When worktreeAdd runs', () => {
      it('Then it refuses with BRANCH_EXISTS', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'dup' });

        // Act & Assert
        await expectError(() => worktreeAdd(ctx, { path: 'wt6', branch: 'dup' }), 'BRANCH_EXISTS');
      });
    });

    describe('When worktreeAdd runs with force', () => {
      it('Then it resets the branch and creates the worktree', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await branchCreate(ctx, { name: 'dup' });

        // Act
        const result = await worktreeAdd(ctx, { path: 'wt6b', branch: 'dup', force: true });

        // Assert
        expect(result.branch).toBe('refs/heads/dup');
      });
    });
  });

  describe('Given a commit-ish branch already checked out by the main worktree', () => {
    describe('When worktreeAdd runs', () => {
      it('Then it refuses with BRANCH_CHECKED_OUT', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();

        // Act & Assert
        await expectError(
          () => worktreeAdd(ctx, { path: 'wt7', commitish: 'main' }),
          'BRANCH_CHECKED_OUT',
        );
      });
    });
  });
});

describe('worktreeMove', () => {
  describe('Given a linked worktree', () => {
    describe('When worktreeMove runs', () => {
      it('Then it relocates the dir and re-points the admin gitdir', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        const added = await worktreeAdd(ctx, { path: 'wm' });

        // Act
        const result = await worktreeMove(ctx, 'wm', 'wm-moved');

        // Assert
        expect(result).toEqual({ from: '/repo/wm', to: '/repo/wm-moved', id: added.id });
        expect(await ctx.fs.readUtf8(adminFile(ctx, added.id, 'gitdir'))).toBe(
          '/repo/wm-moved/.git\n',
        );
        expect(await ctx.fs.exists('/repo/wm-moved/a.txt')).toBe(true);
        expect(await ctx.fs.exists('/repo/wm/.git')).toBe(false);
      });
    });
  });

  describe('Given the main worktree', () => {
    describe('When worktreeMove runs', () => {
      it('Then it refuses with INVALID_OPTION', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();

        // Act & Assert
        await expectError(() => worktreeMove(ctx, ctx.layout.workDir, 'x'), 'INVALID_OPTION');
      });
    });
  });

  describe('Given a path that is not a worktree', () => {
    describe('When worktreeMove runs', () => {
      it('Then it refuses with NOT_A_WORKTREE', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();

        // Act & Assert
        await expectError(() => worktreeMove(ctx, 'nope', 'x'), 'NOT_A_WORKTREE');
      });
    });
  });

  describe('Given a locked worktree', () => {
    describe('When worktreeMove runs without force', () => {
      it('Then it refuses with WORKTREE_LOCKED', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        const added = await worktreeAdd(ctx, { path: 'wm2' });
        await ctx.fs.writeUtf8(adminFile(ctx, added.id, 'locked'), '');

        // Act & Assert
        await expectError(() => worktreeMove(ctx, 'wm2', 'wm2-moved'), 'WORKTREE_LOCKED');
      });
    });
  });

  describe('Given a non-empty destination', () => {
    describe('When worktreeMove runs', () => {
      it('Then it refuses with WORKTREE_PATH_EXISTS', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await worktreeAdd(ctx, { path: 'wm3' });
        await ctx.fs.writeUtf8('/repo/dest/keep.txt', 'x');

        // Act & Assert
        await expectError(() => worktreeMove(ctx, 'wm3', 'dest'), 'WORKTREE_PATH_EXISTS');
      });
    });
  });

  describe('Given a locked worktree', () => {
    describe('When worktreeMove runs with force', () => {
      it('Then it relocates the worktree anyway', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        const added = await worktreeAdd(ctx, { path: 'wm4' });
        await ctx.fs.writeUtf8(adminFile(ctx, added.id, 'locked'), '');

        // Act
        const result = await worktreeMove(ctx, 'wm4', 'wm4-moved', { force: true });

        // Assert
        expect(result.to).toBe('/repo/wm4-moved');
        expect(await ctx.fs.exists('/repo/wm4-moved/a.txt')).toBe(true);
      });
    });
  });
});

describe('worktreeRemove', () => {
  describe('Given a clean linked worktree', () => {
    describe('When worktreeRemove runs', () => {
      it('Then it deletes the dir + admin dir and leaves the branch', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        const added = await worktreeAdd(ctx, { path: 'wr' });

        // Act
        const result = await worktreeRemove(ctx, 'wr');

        // Assert
        expect(result.id).toBe(added.id);
        expect(await ctx.fs.exists('/repo/wr')).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/worktrees/${added.id}`)).toBe(false);
        await expect(resolveRef(ctx, 'refs/heads/wr' as RefName)).resolves.toBeDefined();
      });
    });
  });

  describe('Given a worktree with an untracked file', () => {
    describe('When worktreeRemove runs without force', () => {
      it('Then it refuses with WORKTREE_DIRTY', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await worktreeAdd(ctx, { path: 'wr2' });
        await ctx.fs.writeUtf8('/repo/wr2/extra.txt', 'untracked');

        // Act & Assert
        await expectError(() => worktreeRemove(ctx, 'wr2'), 'WORKTREE_DIRTY');
      });
    });

    describe('When worktreeRemove runs with force', () => {
      it('Then it removes the worktree anyway', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();
        await worktreeAdd(ctx, { path: 'wr3' });
        await ctx.fs.writeUtf8('/repo/wr3/extra.txt', 'untracked');

        // Act
        await worktreeRemove(ctx, 'wr3', { force: true });

        // Assert
        expect(await ctx.fs.exists('/repo/wr3')).toBe(false);
      });
    });
  });

  describe('Given the main worktree', () => {
    describe('When worktreeRemove runs', () => {
      it('Then it refuses with INVALID_OPTION', async () => {
        // Arrange
        const { ctx } = await seedWithCommit();

        // Act & Assert
        await expectError(() => worktreeRemove(ctx, ctx.layout.workDir), 'INVALID_OPTION');
      });
    });
  });
});
