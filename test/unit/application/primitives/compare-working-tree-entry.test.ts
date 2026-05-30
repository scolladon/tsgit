import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { init } from '../../../../src/application/commands/init.js';
import { compareWorkingTreeEntry } from '../../../../src/application/primitives/compare-working-tree-entry.js';
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

  describe('Given a staged file whose mode differs from the working file', () => {
    describe('When comparing an executable-mode entry to a regular working file', () => {
      it("Then returns 'modified' on the mode mismatch alone (content identical)", async () => {
        // Arrange
        const { ctx, entry } = await seedFile('a.txt', 'hello\n');
        const executableEntry: IndexEntry = { ...entry, mode: '100755' };

        // Act
        const sut = await compareWorkingTreeEntry(ctx, executableEntry);

        // Assert
        expect(sut).toBe('modified');
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
});
