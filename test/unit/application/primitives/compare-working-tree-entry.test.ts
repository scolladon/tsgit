import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { init } from '../../../../src/application/commands/init.js';
import {
  compareWorkingTreeEntry,
  isWorkingTreeModified,
  type WorkingTreeComparison,
} from '../../../../src/application/primitives/compare-working-tree-entry.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import type { IndexEntry } from '../../../../src/domain/git-index/index-entry.js';
import type { Context } from '../../../../src/ports/context.js';

const work = (ctx: Context, name: string): string => `${ctx.layout.workDir}/${name}`;

const seedFile = async (
  name: string,
  content: string,
): Promise<{ ctx: Context; entry: IndexEntry }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(work(ctx, name), content);
  await add(ctx, [name]);
  const index = await readIndex(ctx);
  const entry = index.entries.find((e) => e.path === name);
  if (entry === undefined) throw new Error(`seed failed: ${name} not staged`);
  return { ctx, entry };
};

const seedSymlink = async (
  name: string,
  target: string,
): Promise<{ ctx: Context; entry: IndexEntry }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.symlink(target, work(ctx, name));
  await add(ctx, [name]);
  const index = await readIndex(ctx);
  const entry = index.entries.find((e) => e.path === name);
  if (entry === undefined) throw new Error(`seed failed: ${name} not staged`);
  return { ctx, entry };
};

describe('compareWorkingTreeEntry', () => {
  describe('Given a staged file whose working copy was deleted', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then returns 'absent'", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.rm(work(ctx, 'a.txt'));

        // Act
        const sut = await compareWorkingTreeEntry(ctx, entry);

        // Assert
        expect(sut).toBe('absent');
      });
    });
  });

  describe('Given a staged file whose working copy is untouched', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then returns 'unchanged'", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');

        // Act
        const sut = await compareWorkingTreeEntry(ctx, entry);

        // Assert
        expect(sut).toBe('unchanged');
      });
    });
  });

  describe('Given a staged file whose working content changed', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then returns 'modified'", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.writeUtf8(work(ctx, 'a.txt'), 'changed\n');

        // Act
        const sut = await compareWorkingTreeEntry(ctx, entry);

        // Assert
        expect(sut).toBe('modified');
      });
    });
  });

  describe('Given an executable-mode entry whose working file is a same-content regular file', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then returns 'mode-changed' (same blob, exec bit differs)", async () => {
        // Arrange — index says 100755, working file is the seeded regular file
        // with identical content.
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        const executableEntry: IndexEntry = { ...entry, mode: '100755' };

        // Act
        const sut = await compareWorkingTreeEntry(ctx, executableEntry);

        // Assert
        expect(sut).toBe('mode-changed');
      });
    });
  });

  describe('Given an executable-mode entry whose working file changed content too', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then returns 'modified' (content change dominates the mode change)", async () => {
        // Arrange — both the blob and the mode differ; git renders M (content),
        // not a mode-only change.
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.writeUtf8(work(ctx, 'a.txt'), 'changed\n');
        const executableEntry: IndexEntry = { ...entry, mode: '100755' };

        // Act
        const sut = await compareWorkingTreeEntry(ctx, executableEntry);

        // Assert
        expect(sut).toBe('modified');
      });
    });
  });

  describe('Given an entry whose working file is a different kind (regular vs symlink)', () => {
    describe('When the index says symlink but the working file is a regular file', () => {
      it("Then returns 'type-changed'", async () => {
        // Arrange — regular working file, entry mode forced to symlink kind.
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        const symlinkEntry: IndexEntry = { ...entry, mode: '120000' };

        // Act
        const sut = await compareWorkingTreeEntry(ctx, symlinkEntry);

        // Assert
        expect(sut).toBe('type-changed');
      });
    });

    describe('When the index says regular file but the working file is a symlink', () => {
      it("Then returns 'type-changed'", async () => {
        // Arrange — symlink working file, entry mode forced to regular-file kind.
        const { ctx, entry } = await seedSymlink('link', 'target-a');
        const regularEntry: IndexEntry = { ...entry, mode: '100644' };

        // Act
        const sut = await compareWorkingTreeEntry(ctx, regularEntry);

        // Assert
        expect(sut).toBe('type-changed');
      });
    });
  });

  describe('isWorkingTreeModified', () => {
    describe('Given each working-tree comparison value', () => {
      describe('When asking whether it is a modified variant', () => {
        it("Then 'modified', 'type-changed', and 'mode-changed' are modified; 'unchanged' and 'absent' are not", () => {
          // Arrange
          const modifiedVariants: ReadonlyArray<WorkingTreeComparison> = [
            'modified',
            'type-changed',
            'mode-changed',
          ];
          const cleanVariants: ReadonlyArray<WorkingTreeComparison> = ['unchanged', 'absent'];

          // Act / Assert
          for (const variant of modifiedVariants) {
            expect(isWorkingTreeModified(variant)).toBe(true);
          }
          for (const variant of cleanVariants) {
            expect(isWorkingTreeModified(variant)).toBe(false);
          }
        });
      });
    });
  });

  describe('Given a staged file that exists but cannot be read', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then returns 'modified' (an unverifiable file is never reported unchanged)", async () => {
        // Arrange — lstat succeeds (mode matches) but read throws, so the content
        // hash cannot be computed.
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        const failingReadCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async (path: string) => {
              if (path === work(ctx, 'a.txt')) throw new Error('simulated read failure');
              return ctx.fs.read(path);
            },
          },
        };

        // Act
        const sut = await compareWorkingTreeEntry(failingReadCtx, entry);

        // Assert
        expect(sut).toBe('modified');
      });
    });
  });

  describe('Given a staged symlink whose target is untouched', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then returns 'unchanged'", async () => {
        // Arrange
        const { ctx, entry } = await seedSymlink('link', 'target-a');

        // Act
        const sut = await compareWorkingTreeEntry(ctx, entry);

        // Assert
        expect(sut).toBe('unchanged');
      });
    });
  });

  describe('Given a staged symlink whose target changed', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then returns 'modified' (link content read via readlink, not followed)", async () => {
        // Arrange
        const { ctx, entry } = await seedSymlink('link', 'target-a');
        await ctx.fs.rm(work(ctx, 'link'));
        await ctx.fs.symlink('target-b', work(ctx, 'link'));

        // Act
        const sut = await compareWorkingTreeEntry(ctx, entry);

        // Assert
        expect(sut).toBe('modified');
      });
    });
  });

  describe('Given a gitlink (submodule) entry over a working directory', () => {
    describe('When comparing the entry to the working tree', () => {
      it("Then returns 'modified', not 'type-changed' (git reports a submodule as M)", async () => {
        // Arrange — a 160000 entry whose working path is a directory. The kind
        // derived from the directory is a file kind, but a gitlink must NOT read
        // as a type change; the unreadable directory degrades to `modified`.
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        await ctx.fs.mkdir(work(ctx, 'sub'));
        const gitlinkEntry: IndexEntry = {
          ...entry,
          path: 'sub' as typeof entry.path,
          mode: '160000',
        };

        // Act
        const sut = await compareWorkingTreeEntry(ctx, gitlinkEntry);

        // Assert
        expect(sut).toBe('modified');
      });
    });
  });
});
