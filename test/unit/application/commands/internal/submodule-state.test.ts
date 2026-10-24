import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../../src/application/commands/init.js';
import {
  configuredSubmoduleIgnore,
  readGitmodulesRows,
  submoduleState,
} from '../../../../../src/application/commands/internal/submodule-state.js';
import type {
  ChangedPath,
  StatusResult,
  UnmergedEntry,
} from '../../../../../src/application/commands/status.js';
import type { WorkingTreeDelta } from '../../../../../src/application/primitives/compare-working-tree-entry.js';
import { createCommit } from '../../../../../src/application/primitives/create-commit.js';
import { MAX_GITMODULES_BYTES } from '../../../../../src/application/primitives/types.js';
import { updateRef } from '../../../../../src/application/primitives/update-ref.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import { type IndexEntry, STAGE0_FLAGS } from '../../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../../src/domain/objects/index.js';
import type { FilePath, ObjectId, RefName } from '../../../../../src/domain/objects/object-id.js';
import { treeEntry } from '../../../../../src/domain/objects/tree.js';
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
  ignore: 'none' as const,
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

    describe('When its only row is a nested gitlink with tracked and untracked changes of its own', () => {
      it('Then both are flagged: only an untracked-only row is spared', async () => {
        // Arrange
        const ctx = await checkedOut();
        const nested = nestedGitlink({ ...NO_FLAGS, trackedChanges: true, untrackedChanges: true });
        const sut = submoduleState;

        // Act
        const result = await sut(
          ctx,
          gitlinkEntry,
          directory,
          childReporting({ changes: [nested] }),
        );

        // Assert
        expect(result).toEqual({ ...NO_FLAGS, trackedChanges: true, untrackedChanges: true });
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
          ignore: 'none',
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
          ignore: 'none',
        });

        // Assert
        expect(received.map((child) => child.layout.workDir)).toEqual([
          `${ctx.layout.workDir}/sub`,
        ]);
      });
    });
  });
});

describe('readGitmodulesRows', () => {
  const AUTHOR = { name: 'T', email: 't@t', timestamp: 1_700_000_000, timezoneOffset: '+0000' };
  const GITMODULES = '[submodule "sub"]\n\tpath = sub\n\turl = ../up\n\tignore = all\n';

  /** HEAD recording `.gitmodules` as `entry`, with no working or staged `.gitmodules`. */
  const headRecording = async (
    ctx: Context,
    entry: (gitmodulesBlob: ObjectId) => ReturnType<typeof treeEntry>,
    text = GITMODULES,
  ): Promise<void> => {
    const blob = (await writeObject(ctx, {
      type: 'blob',
      id: '' as ObjectId,
      content: new TextEncoder().encode(text),
    })) as ObjectId;
    const commit = await createCommit(ctx, {
      tree: await writeTree(ctx, [entry(blob)]),
      parents: [],
      author: AUTHOR,
      committer: AUTHOR,
      message: 'head\n',
      extraHeaders: [],
    });
    await updateRef(ctx, 'refs/heads/main' as RefName, commit, { reflogMessage: 'seed' });
  };

  describe('Given HEAD recording .gitmodules as a directory, nothing staged or in the work tree', () => {
    describe('When the rows are read', () => {
      it('Then none is answered: git reads only a blob there', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await headRecording(ctx, (blob) => treeEntry(FILE_MODE.DIRECTORY, '.gitmodules', blob));
        const sut = readGitmodulesRows;

        // Act
        const result = await sut(ctx, { workDir: ctx.layout.workDir as string, entries: [] });

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given HEAD recording .gitmodules as a gitlink, nothing staged or in the work tree', () => {
    describe('When the rows are read', () => {
      it('Then none is answered: git reads only a blob there', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await headRecording(ctx, (blob) => treeEntry(FILE_MODE.GITLINK, '.gitmodules', blob));
        const sut = readGitmodulesRows;

        // Act
        const result = await sut(ctx, { workDir: ctx.layout.workDir as string, entries: [] });

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given HEAD recording .gitmodules as a blob, nothing staged or in the work tree', () => {
    describe('When the rows are read', () => {
      it('Then the HEAD blob is read', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await headRecording(ctx, (blob) => treeEntry(FILE_MODE.REGULAR, '.gitmodules', blob));
        const sut = readGitmodulesRows;

        // Act
        const result = await sut(ctx, { workDir: ctx.layout.workDir as string, entries: [] });

        // Assert
        expect(result).toEqual([{ name: 'sub', path: 'sub', url: '../up', ignore: 'all' }]);
      });
    });
  });

  describe('Given HEAD recording a .gitmodules blob past the bound git reads, nothing staged or in the work tree', () => {
    describe('When the rows are read', () => {
      it('Then OBJECT_TOO_LARGE refuses with the blob size and the bound', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await headRecording(
          ctx,
          (blob) => treeEntry(FILE_MODE.REGULAR, '.gitmodules', blob),
          '#'.repeat(MAX_GITMODULES_BYTES + 1),
        );
        const sut = readGitmodulesRows;

        // Act
        const result = await refusalOf(() =>
          sut(ctx, { workDir: ctx.layout.workDir as string, entries: [] }),
        );

        // Assert
        expect(result).toMatchObject({
          code: 'OBJECT_TOO_LARGE',
          actualSize: MAX_GITMODULES_BYTES + 1,
          limit: MAX_GITMODULES_BYTES,
        });
      });
    });
  });

  describe('Given a working .gitmodules of exactly the bound git reads', () => {
    describe('When the rows are read', () => {
      it('Then it is read: only a larger file refuses', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(
          `${ctx.layout.workDir}/.gitmodules`,
          '#'.repeat(MAX_GITMODULES_BYTES),
        );
        const sut = readGitmodulesRows;

        // Act
        const result = await sut(ctx, { workDir: ctx.layout.workDir as string, entries: [] });

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given an unmerged entry at another path and a clean working .gitmodules', () => {
    describe('When the rows are read', () => {
      it('Then the working rows are read: git skips them only for an unmerged .gitmodules', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitmodules`, GITMODULES);
        const unmerged: IndexEntry = {
          ...gitlinkEntry,
          mode: FILE_MODE.REGULAR,
          path: 'other' as FilePath,
          flags: { ...STAGE0_FLAGS, stage: 2 },
        };
        const sut = readGitmodulesRows;

        // Act
        const result = await sut(ctx, {
          workDir: ctx.layout.workDir as string,
          entries: [unmerged],
        });

        // Assert
        expect(result).toEqual([{ name: 'sub', path: 'sub', url: '../up', ignore: 'all' }]);
      });
    });
  });
});

describe('configuredSubmoduleIgnore', () => {
  describe('Given rows where the first names another path', () => {
    describe('When the ignore mode of the second path is asked', () => {
      it('Then it is the mode of its own row', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const rows = [
          { name: 'other', path: 'other' as FilePath, url: '../up', ignore: 'all' },
          { name: 'sub', path: 'sub' as FilePath, url: '../up', ignore: 'dirty' },
        ];
        const sut = configuredSubmoduleIgnore;

        // Act
        const result = await sut(ctx, 'sub' as FilePath, rows);

        // Assert
        expect(result).toBe('dirty');
      });
    });
  });
});
