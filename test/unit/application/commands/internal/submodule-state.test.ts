import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { submoduleState } from '../../../../../src/application/commands/internal/submodule-state.js';
import type { WorkingTreeDelta } from '../../../../../src/application/primitives/compare-working-tree-entry.js';
import { type IndexEntry, STAGE0_FLAGS } from '../../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../../src/domain/objects/index.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../../src/ports/context.js';

const OVERSIZED_BYTES = (1 << 20) + 1;
const NO_FLAGS = { commitChanged: false, trackedChanges: false, untrackedChanges: false };

const gitlinkEntry: IndexEntry = {
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: FILE_MODE.GITLINK,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id: 'a'.repeat(40) as ObjectId,
  flags: STAGE0_FLAGS,
  path: 'sub' as FilePath,
};

const directory: WorkingTreeDelta = { status: 'unchanged', worktreeMode: FILE_MODE.GITLINK };

const dotGitOf = (ctx: Context): string => `${ctx.layout.workDir}/sub/.git`;

const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    return (err as { data: unknown }).data;
  }
  return undefined;
};

describe('submoduleState', () => {
  describe('Given a gitlink whose .git is a gitfile past the size git reads', () => {
    describe('When the state is asked', () => {
      it('Then it refuses with GITFILE_TOO_LARGE at the .git path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(dotGitOf(ctx), 'x'.repeat(OVERSIZED_BYTES));
        const sut = submoduleState;

        // Act
        const result = await refusalOf(() => sut(ctx, gitlinkEntry, directory));

        // Assert
        expect(result).toEqual({ code: 'GITFILE_TOO_LARGE', path: 'sub/.git' });
      });
    });
  });

  describe('Given a gitlink whose .git is an empty directory', () => {
    describe('When the state is asked', () => {
      it('Then it refuses with NOT_A_REPOSITORY at the .git path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir(dotGitOf(ctx));
        const sut = submoduleState;

        // Act
        const result = await refusalOf(() => sut(ctx, gitlinkEntry, directory));

        // Assert
        expect(result).toEqual({ code: 'NOT_A_REPOSITORY', path: 'sub/.git' });
      });
    });
  });

  describe('Given a gitlink whose .git is a gitfile that is not a pointer', () => {
    describe('When the state is asked', () => {
      it('Then it refuses with NOT_A_REPOSITORY at the .git path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(dotGitOf(ctx), 'garbage\n');
        const sut = submoduleState;

        // Act
        const result = await refusalOf(() => sut(ctx, gitlinkEntry, directory));

        // Assert
        expect(result).toEqual({ code: 'NOT_A_REPOSITORY', path: 'sub/.git' });
      });
    });
  });

  describe('Given a gitlink whose gitfile points at a missing module directory', () => {
    describe('When the state is asked', () => {
      it('Then it refuses with NOT_A_REPOSITORY at the pointed path as written', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(dotGitOf(ctx), 'gitdir: ../.git/modules/nowhere\n');
        const sut = submoduleState;

        // Act
        const result = await refusalOf(() => sut(ctx, gitlinkEntry, directory));

        // Assert
        expect(result).toEqual({
          code: 'NOT_A_REPOSITORY',
          path: 'sub/../.git/modules/nowhere',
        });
      });
    });
  });

  describe('Given a file in place of the gitlink', () => {
    describe('When the state is asked', () => {
      it('Then no flag is set and the checkout is never probed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.mkdir(dotGitOf(ctx));
        const sut = submoduleState;

        // Act
        const result = await sut(ctx, gitlinkEntry, { status: 'type-changed' });

        // Assert
        expect(result).toEqual(NO_FLAGS);
      });
    });
  });

  describe('Given a gitlink with nothing checked out', () => {
    describe('When the state is asked', () => {
      it('Then no flag is set', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = submoduleState;

        // Act
        const result = await sut(ctx, gitlinkEntry, directory);

        // Assert
        expect(result).toEqual(NO_FLAGS);
      });
    });
  });

  describe('Given a gitlink whose checkout moved', () => {
    describe('When the state is asked', () => {
      it('Then only the commit is reported changed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const gitDir = `${ctx.layout.workDir}/sub/.git`;
        await ctx.fs.writeUtf8(`${gitDir}/HEAD`, 'ref: refs/heads/main\n');
        await ctx.fs.mkdir(`${gitDir}/objects`);
        await ctx.fs.mkdir(`${gitDir}/refs`);
        const sut = submoduleState;

        // Act
        const result = await sut(ctx, gitlinkEntry, { status: 'modified' });

        // Assert
        expect(result).toEqual({ ...NO_FLAGS, commitChanged: true });
      });
    });
  });
});
