import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { submoduleState } from '../../../../../src/application/commands/internal/submodule-state.js';
import type {
  ChangedPath,
  StatusResult,
  UnmergedEntry,
} from '../../../../../src/application/commands/status.js';
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

const CLEAN_CHILD: StatusResult = {
  branch: undefined,
  detached: false,
  changes: [],
  untracked: [],
  unmerged: [],
  clean: true,
};
const childReporting = (report: Partial<StatusResult>) => ({
  childStatus: async (_child: Context): Promise<StatusResult> => ({ ...CLEAN_CHILD, ...report }),
});
const deps = childReporting({});
const modifiedFile = { path: 'f', unstaged: 'modified' } as ChangedPath;
const nestedGitlink = (submodule: ChangedPath['submodule'], staged?: ChangedPath['staged']) =>
  ({ path: 'in', ...(staged && { staged }), submodule }) as ChangedPath;
const conflict = { kind: 'both-modified', path: 'c' } as UnmergedEntry;

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
        const result = await refusalOf(() => sut(ctx, gitlinkEntry, directory, deps));

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
        const result = await refusalOf(() => sut(ctx, gitlinkEntry, directory, deps));

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
        const result = await refusalOf(() => sut(ctx, gitlinkEntry, directory, deps));

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
        const result = await refusalOf(() => sut(ctx, gitlinkEntry, directory, deps));

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
        const result = await sut(ctx, gitlinkEntry, { status: 'type-changed' }, deps);

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
        const result = await sut(ctx, gitlinkEntry, directory, deps);

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
        const result = await sut(ctx, gitlinkEntry, { status: 'modified' }, deps);

        // Assert
        expect(result).toEqual({ ...NO_FLAGS, commitChanged: true });
      });
    });
  });
  describe('Given a checked-out submodule', () => {
    const checkedOut = async (): Promise<Context> => {
      const ctx = createMemoryContext();
      const gitDir = `${ctx.layout.workDir}/sub/.git`;
      await ctx.fs.writeUtf8(`${gitDir}/HEAD`, 'ref: refs/heads/main\n');
      await ctx.fs.mkdir(`${gitDir}/objects`);
      await ctx.fs.mkdir(`${gitDir}/refs`);
      return ctx;
    };

    describe('When its own status reports a modified file', () => {
      it('Then tracked changes are flagged', async () => {
        // Arrange
        const ctx = await checkedOut();
        const sut = submoduleState;

        // Act
        const result = await sut(
          ctx,
          gitlinkEntry,
          directory,
          childReporting({ changes: [modifiedFile] }),
        );

        // Assert
        expect(result).toEqual({ ...NO_FLAGS, trackedChanges: true });
      });
    });

    describe('When its own status reports an untracked path', () => {
      it('Then untracked changes are flagged', async () => {
        // Arrange
        const ctx = await checkedOut();
        const sut = submoduleState;

        // Act
        const result = await sut(
          ctx,
          gitlinkEntry,
          directory,
          childReporting({ untracked: ['n' as never] }),
        );

        // Assert
        expect(result).toEqual({ ...NO_FLAGS, untrackedChanges: true });
      });
    });

    describe('When its own status reports one unmerged entry', () => {
      it('Then tracked changes are flagged', async () => {
        // Arrange
        const ctx = await checkedOut();
        const sut = submoduleState;

        // Act
        const result = await sut(
          ctx,
          gitlinkEntry,
          directory,
          childReporting({ unmerged: [conflict] }),
        );

        // Assert
        expect(result).toEqual({ ...NO_FLAGS, trackedChanges: true });
      });
    });

    describe('When its only row is a nested gitlink with untracked files', () => {
      it('Then only untracked changes are flagged whatever the staged column says', async () => {
        // Arrange
        const ctx = await checkedOut();
        const nested = nestedGitlink({ ...NO_FLAGS, untrackedChanges: true }, 'modified');
        const sut = submoduleState;

        // Act
        const result = await sut(
          ctx,
          gitlinkEntry,
          directory,
          childReporting({ changes: [nested] }),
        );

        // Assert
        expect(result).toEqual({ ...NO_FLAGS, untrackedChanges: true });
      });
    });

    describe('When its only row is a nested gitlink whose commit moved', () => {
      it('Then tracked changes are flagged', async () => {
        // Arrange
        const ctx = await checkedOut();
        const nested = nestedGitlink({ ...NO_FLAGS, commitChanged: true });
        const sut = submoduleState;

        // Act
        const result = await sut(
          ctx,
          gitlinkEntry,
          directory,
          childReporting({ changes: [nested] }),
        );

        // Assert
        expect(result).toEqual({ ...NO_FLAGS, trackedChanges: true });
      });
    });

    describe('When its only row is a nested gitlink with its own tracked changes', () => {
      it('Then tracked changes are flagged', async () => {
        // Arrange
        const ctx = await checkedOut();
        const nested = nestedGitlink({ ...NO_FLAGS, trackedChanges: true });
        const sut = submoduleState;

        // Act
        const result = await sut(
          ctx,
          gitlinkEntry,
          directory,
          childReporting({ changes: [nested] }),
        );

        // Assert
        expect(result).toEqual({ ...NO_FLAGS, trackedChanges: true });
      });
    });

    describe('When a nested gitlink has untracked files beside a modified file', () => {
      it('Then both are flagged', async () => {
        // Arrange
        const ctx = await checkedOut();
        const nested = nestedGitlink({ ...NO_FLAGS, untrackedChanges: true });
        const sut = submoduleState;

        // Act
        const result = await sut(
          ctx,
          gitlinkEntry,
          directory,
          childReporting({ changes: [nested, modifiedFile] }),
        );

        // Assert
        expect(result).toEqual({ ...NO_FLAGS, trackedChanges: true, untrackedChanges: true });
      });
    });

    describe('When the submodule is clean', () => {
      it('Then no flag is set', async () => {
        // Arrange
        const ctx = await checkedOut();
        const sut = submoduleState;

        // Act
        const result = await sut(ctx, gitlinkEntry, directory, deps);

        // Assert
        expect(result).toEqual(NO_FLAGS);
      });
    });

    describe('When its own status refuses', () => {
      it('Then the refusal propagates unchanged', async () => {
        // Arrange
        const ctx = await checkedOut();
        const failure = new Error('child refused');
        const sut = submoduleState;

        // Act
        const attempt = sut(ctx, gitlinkEntry, directory, {
          childStatus: () => Promise.reject(failure),
        });

        // Assert
        await expect(attempt).rejects.toBe(failure);
      });
    });

    describe('When the child status is asked', () => {
      it('Then it receives a context rooted at the submodule', async () => {
        // Arrange
        const ctx = await checkedOut();
        const received: Context[] = [];
        const sut = submoduleState;

        // Act
        await sut(ctx, gitlinkEntry, directory, {
          childStatus: async (child) => {
            received.push(child);
            return CLEAN_CHILD;
          },
        });

        // Assert
        expect(received.map((child) => child.layout.workDir)).toEqual([
          `${ctx.layout.workDir}/sub`,
        ]);
      });
    });
  });
});
