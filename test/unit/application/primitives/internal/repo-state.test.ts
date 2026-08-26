import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../../src/application/commands/init.js';
import * as configReadMod from '../../../../../src/application/primitives/config-read.js';
import {
  __resetConfigCacheForTests,
  invalidateConfigCache,
} from '../../../../../src/application/primitives/config-read.js';
import {
  assertOperationalRepository,
  assertRepository,
} from '../../../../../src/application/primitives/internal/repo-state.js';
import { updateCoreConfig } from '../../../../../src/application/primitives/update-config.js';
import { permissionDenied, TsgitError } from '../../../../../src/domain/error.js';
import type { Context } from '../../../../../src/ports/context.js';
import type { FileStat } from '../../../../../src/ports/file-system.js';

const headPath = (ctx: Context): string => `${ctx.layout.gitDir}/HEAD`;

/**
 * Count of `readlink`/`readUtf8` calls made against `path` specifically —
 * `assertRepository` also reads `.git/config` (via `assertDiscoveryBooleansValid`)
 * through the very same `readUtf8` method, so a bare total call count would
 * conflate the two files.
 */
const headReadCount = (
  path: string,
  readlinkSpy: { readonly mock: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  readUtf8Spy: { readonly mock: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> } },
): number =>
  [...readlinkSpy.mock.calls, ...readUtf8Spy.mock.calls].filter(([called]) => called === path)
    .length;

/** A seeded, memory-backed repository — `init` gives it a regular-file HEAD with valid content. */
const seededCtx = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  return ctx;
};

/** Runs `thunk`, capturing its rejection as a `TsgitError` so it can be asserted on. */
const catchTsgitError = async (thunk: () => Promise<unknown>): Promise<TsgitError> => {
  try {
    await thunk();
  } catch (err) {
    return err as TsgitError;
  }
  throw new Error('expected thunk to throw');
};

describe('primitives/internal/repo-state', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
  });

  describe('Given two commands on one Context', () => {
    describe('When both run assertOperationalRepository', () => {
      it('Then the eager config finders run once, not twice', async () => {
        // Arrange
        const ctx = await seededCtx();
        const spy = vi.spyOn(configReadMod, 'findFirstInvalidCompression');

        // Act
        await assertOperationalRepository(ctx);
        await assertOperationalRepository(ctx);

        // Assert
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
      });
    });
  });

  describe('Given a config write between two commands', () => {
    describe('When the second command runs assertOperationalRepository', () => {
      it('Then it still refuses on the newly-written bad boolean value', async () => {
        // Arrange
        const ctx = await seededCtx();
        await assertOperationalRepository(ctx);
        await updateCoreConfig(ctx, { sparseCheckout: 'bogus' });

        // Act
        const caught = await catchTsgitError(() => assertOperationalRepository(ctx));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect(caught.data).toMatchObject({
          code: 'CONFIG_BAD_BOOLEAN_VALUE',
          key: 'core.sparsecheckout',
          value: 'bogus',
        });
      });
    });
  });

  describe('Given invalidateConfigCache is called directly (not through a primitives writer)', () => {
    describe('When the second command runs assertOperationalRepository', () => {
      it('Then the eager config finders run again — the gate-verdict memo dropped too', async () => {
        // Arrange — mirrors how the max-tree-depth/config-boolean interop
        // suites poison the config file directly and invalidate by hand.
        const ctx = await seededCtx();
        const spy = vi.spyOn(configReadMod, 'findFirstInvalidCompression');
        await assertOperationalRepository(ctx);
        invalidateConfigCache(ctx);

        // Act
        await assertOperationalRepository(ctx);

        // Assert
        expect(spy).toHaveBeenCalledTimes(2);
        spy.mockRestore();
      });
    });
  });

  describe('Given HEAD is deleted between two commands', () => {
    describe('When the second command runs assertOperationalRepository', () => {
      it('Then it refuses NOT_A_REPOSITORY', async () => {
        // Arrange
        const ctx = await seededCtx();
        await assertOperationalRepository(ctx);
        await ctx.fs.rm(headPath(ctx));

        // Act
        const caught = await catchTsgitError(() => assertOperationalRepository(ctx));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect(caught.data.code).toBe('NOT_A_REPOSITORY');
      });
    });
  });

  describe('hasUsableHead behaviour matrix (observed through assertRepository)', () => {
    describe('Given a symlinked HEAD pointing at refs/heads/main', () => {
      describe('When assertRepository runs', () => {
        it('Then it resolves, using exactly one of readlink/readUtf8', async () => {
          // Arrange
          const ctx = await seededCtx();
          await ctx.fs.rm(headPath(ctx));
          await ctx.fs.symlink('refs/heads/main', headPath(ctx));
          const readlinkSpy = vi.spyOn(ctx.fs, 'readlink');
          const readUtf8Spy = vi.spyOn(ctx.fs, 'readUtf8');

          // Act
          const result = await assertRepository(ctx);

          // Assert
          expect(result).toBe(ctx.layout.workDir);
          expect(headReadCount(headPath(ctx), readlinkSpy, readUtf8Spy)).toBe(1);
        });
      });
    });

    describe('Given a symlinked HEAD pointing elsewhere', () => {
      describe('When assertRepository runs', () => {
        it('Then it refuses NOT_A_REPOSITORY', async () => {
          // Arrange
          const ctx = await seededCtx();
          await ctx.fs.rm(headPath(ctx));
          await ctx.fs.symlink('/etc/passwd', headPath(ctx));

          // Act
          const caught = await catchTsgitError(() => assertRepository(ctx));

          // Assert
          expect(caught.data.code).toBe('NOT_A_REPOSITORY');
        });
      });
    });

    describe('Given a dangling symlinked HEAD pointing at refs/heads/ghost', () => {
      describe('When assertRepository runs', () => {
        it('Then it resolves — judged by link text, not target existence', async () => {
          // Arrange
          const ctx = await seededCtx();
          await ctx.fs.rm(headPath(ctx));
          await ctx.fs.symlink('refs/heads/ghost', headPath(ctx));

          // Act
          const result = await assertRepository(ctx);

          // Assert
          expect(result).toBe(ctx.layout.workDir);
        });
      });
    });

    describe('Given a regular-file HEAD with valid content', () => {
      describe('When assertRepository runs', () => {
        it('Then it resolves, using exactly one of readlink/readUtf8', async () => {
          // Arrange
          const ctx = await seededCtx();
          const readlinkSpy = vi.spyOn(ctx.fs, 'readlink');
          const readUtf8Spy = vi.spyOn(ctx.fs, 'readUtf8');

          // Act
          const result = await assertRepository(ctx);

          // Assert
          expect(result).toBe(ctx.layout.workDir);
          expect(headReadCount(headPath(ctx), readlinkSpy, readUtf8Spy)).toBe(1);
        });
      });
    });

    describe('Given a regular-file HEAD with invalid content', () => {
      describe('When assertRepository runs', () => {
        it('Then it refuses NOT_A_REPOSITORY', async () => {
          // Arrange
          const ctx = await seededCtx();
          await ctx.fs.writeUtf8(headPath(ctx), 'not a valid head\n');

          // Act
          const caught = await catchTsgitError(() => assertRepository(ctx));

          // Assert
          expect(caught.data.code).toBe('NOT_A_REPOSITORY');
        });
      });
    });

    describe('Given an absent HEAD', () => {
      describe('When assertRepository runs', () => {
        it('Then it refuses NOT_A_REPOSITORY', async () => {
          // Arrange
          const ctx = await seededCtx();
          await ctx.fs.rm(headPath(ctx));

          // Act
          const caught = await catchTsgitError(() => assertRepository(ctx));

          // Assert
          expect(caught.data.code).toBe('NOT_A_REPOSITORY');
        });
      });
    });

    describe('Given HEAD is unreadable (EACCES-equivalent, at the lstat probe)', () => {
      describe('When assertRepository runs', () => {
        it('Then it refuses NOT_A_REPOSITORY', async () => {
          // Arrange
          const base = await seededCtx();
          const target = headPath(base);
          const lstat = async (path: string): Promise<FileStat> => {
            if (path === target) throw permissionDenied(path);
            return base.fs.lstat(path);
          };
          const ctx: Context = { ...base, fs: { ...base.fs, lstat } };

          // Act
          const caught = await catchTsgitError(() => assertRepository(ctx));

          // Assert
          expect(caught.data.code).toBe('NOT_A_REPOSITORY');
        });
      });
    });

    describe('Given HEAD is a directory (EISDIR-equivalent)', () => {
      describe('When assertRepository runs', () => {
        it('Then it refuses NOT_A_REPOSITORY', async () => {
          // Arrange
          const ctx = await seededCtx();
          await ctx.fs.rm(headPath(ctx));
          await ctx.fs.mkdir(headPath(ctx));

          // Act
          const caught = await catchTsgitError(() => assertRepository(ctx));

          // Assert
          expect(caught.data.code).toBe('NOT_A_REPOSITORY');
        });
      });
    });
  });
});
