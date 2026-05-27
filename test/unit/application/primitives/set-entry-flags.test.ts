import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { setEntryFlags } from '../../../../src/application/primitives/set-entry-flags.js';
import { stageEntry } from '../../../../src/application/primitives/stage-entry.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';

afterEach(() => __resetConfigCacheForTests());

const path = (p: string): FilePath => p as FilePath;

const seedRepo = async (opts?: { signal?: AbortSignal; bare?: boolean }) => {
  const ctx =
    opts?.signal === undefined
      ? createMemoryContext()
      : createMemoryContext({ signal: opts.signal });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  if (opts?.bare === true) {
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  bare = true\n');
  }
  return ctx;
};

describe('setEntryFlags', () => {
  describe('Given a staged entry with default flags', () => {
    describe('When assumeValid is flipped true', () => {
      it('Then the on-disk entry reflects the change', async () => {
        // Arrange
        const ctx = await seedRepo();
        await stageEntry(ctx, path('a.txt'), { content: new Uint8Array([1]) });

        // Act
        const sut = await setEntryFlags(ctx, path('a.txt'), { assumeValid: true });

        // Assert
        expect(sut.flags.assumeValid).toBe(true);
        const reread = await readIndex(ctx);
        expect(reread.entries[0]?.flags.assumeValid).toBe(true);
      });
    });
  });

  describe('Given a staged entry', () => {
    describe('When skipWorktree is flipped true then back to false', () => {
      it('Then both transitions persist (v3 → v2 round-trip)', async () => {
        // Arrange
        const ctx = await seedRepo();
        await stageEntry(ctx, path('a.txt'), { content: new Uint8Array([1]) });

        // Act
        await setEntryFlags(ctx, path('a.txt'), { skipWorktree: true });
        const sut = await setEntryFlags(ctx, path('a.txt'), { skipWorktree: false });

        // Assert
        expect(sut.flags.skipWorktree).toBe(false);
        const reread = await readIndex(ctx);
        expect(reread.entries[0]?.flags.skipWorktree).toBe(false);
      });
    });
  });

  describe('Given a staged entry', () => {
    describe('When intentToAdd is flipped true', () => {
      it('Then the entry round-trips with intentToAdd set', async () => {
        // Arrange
        const ctx = await seedRepo();
        await stageEntry(ctx, path('a.txt'), { content: new Uint8Array([1]) });

        // Act
        const sut = await setEntryFlags(ctx, path('a.txt'), { intentToAdd: true });

        // Assert
        expect(sut.flags.intentToAdd).toBe(true);
        const reread = await readIndex(ctx);
        expect(reread.entries[0]?.flags.intentToAdd).toBe(true);
      });
    });
  });

  describe('Given an absent path', () => {
    describe('When setEntryFlags is called', () => {
      it('Then it throws PATHSPEC_NO_MATCH carrying the requested path', async () => {
        // Arrange
        const ctx = await seedRepo();

        // Act
        let caught: unknown;
        try {
          await setEntryFlags(ctx, path('absent.txt'), { assumeValid: true });
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PATHSPEC_NO_MATCH');
        const data = (caught as TsgitError).data;
        if (data.code === 'PATHSPEC_NO_MATCH') {
          expect(data.pattern).toBe('absent.txt');
        }
      });
    });
  });

  describe('Given an absolute path', () => {
    describe('When setEntryFlags is called', () => {
      it('Then it throws INVALID_INDEX_ENTRY before the lock is taken', async () => {
        // Arrange
        const ctx = await seedRepo();

        // Act
        let caught: unknown;
        try {
          await setEntryFlags(ctx, path('/abs'), { assumeValid: true });
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('INVALID_INDEX_ENTRY');
      });
    });
  });

  describe('Given a bare repository', () => {
    describe('When setEntryFlags is called', () => {
      it('Then it throws BARE_REPOSITORY', async () => {
        // Arrange
        const ctx = await seedRepo({ bare: true });

        // Act
        let caught: unknown;
        try {
          await setEntryFlags(ctx, path('a.txt'), { assumeValid: true });
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('BARE_REPOSITORY');
      });
    });
  });

  describe('Given an aborted signal', () => {
    describe('When setEntryFlags is called', () => {
      it('Then it throws OPERATION_ABORTED', async () => {
        // Arrange
        const controller = new AbortController();
        controller.abort();
        const ctx = await seedRepo({ signal: controller.signal });

        // Act
        let caught: unknown;
        try {
          await setEntryFlags(ctx, path('a.txt'), { assumeValid: true });
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
      });
    });
  });
});
