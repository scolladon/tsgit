import { describe, expect, it } from 'vitest';
import { atomicWriteRef } from '../../../../src/application/primitives/atomic-write.js';
import { TsgitError } from '../../../../src/domain/error.js';
import { buildSeededContext } from './fixtures.js';

describe('atomicWriteRef', () => {
  it('Given refPath and content, When atomicWriteRef succeeds, Then refPath contains content and lockPath is gone', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const refPath = '/repo/.git/refs/heads/feature';
    const bytes = new TextEncoder().encode(`${'a'.repeat(40)}\n`);

    // Act
    await atomicWriteRef(ctx, 'refs/heads/feature' as never, refPath, bytes);

    // Assert
    expect(await ctx.fs.exists(refPath)).toBe(true);
    expect(await ctx.fs.exists(`${refPath}.lock`)).toBe(false);
  });

  it('Given a pre-existing lock file, When atomicWriteRef is called, Then throws REF_LOCKED', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const refPath = '/repo/.git/refs/heads/busy';
    await ctx.fs.write(`${refPath}.lock`, new Uint8Array([0]));

    // Act / Assert
    try {
      await atomicWriteRef(ctx, 'refs/heads/busy' as never, refPath, new Uint8Array([1]));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TsgitError);
      expect((error as TsgitError).data.code).toBe('REF_LOCKED');
    }
  });

  it('Given writeExclusive throws a non-FILE_EXISTS TsgitError, When atomicWriteRef is called, Then propagates the original error (not REF_LOCKED)', async () => {
    // Kills the `error instanceof TsgitError && code === FILE_EXISTS` mutants:
    // under a `true` mutation, ANY error becomes REF_LOCKED.
    const ctx = await buildSeededContext();
    const wrapped = {
      ...ctx,
      fs: {
        ...ctx.fs,
        writeExclusive: async () => {
          throw new TsgitError({ code: 'PERMISSION_DENIED', path: '/x' });
        },
      },
    };
    try {
      await atomicWriteRef(
        wrapped,
        'refs/heads/x' as never,
        '/repo/.git/refs/heads/x',
        new Uint8Array([1]),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TsgitError);
      expect((error as TsgitError).data.code).toBe('PERMISSION_DENIED');
    }
  });

  it('Given writeExclusive throws a plain Error (not TsgitError), When atomicWriteRef is called, Then propagates the plain Error (not REF_LOCKED)', async () => {
    // Kills the `error instanceof TsgitError` mutant: under a `true` mutation,
    // a plain Error would be misclassified as REF_LOCKED.
    const ctx = await buildSeededContext();
    const wrapped = {
      ...ctx,
      fs: {
        ...ctx.fs,
        writeExclusive: async () => {
          throw new Error('disk full');
        },
      },
    };
    try {
      await atomicWriteRef(
        wrapped,
        'refs/heads/y' as never,
        '/repo/.git/refs/heads/y',
        new Uint8Array([1]),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).not.toBeInstanceOf(TsgitError);
      expect((error as Error).message).toBe('disk full');
    }
  });

  it('Given rename fails and lock cleanup (rm) succeeds, When atomicWriteRef is called, Then propagates the rename error after removing the lock', async () => {
    // Arrange — rename throws; rm succeeds so the catch falls through to
    // `throw error`. Kills the L28/L32 BlockStatement mutants (emptying the
    // catch body / inner try body would lose the rethrow and the rm call).
    const ctx = await buildSeededContext();
    const renameError = new TsgitError({ code: 'PERMISSION_DENIED', path: '/repo' });
    let rmCalled = false;
    const wrapped = {
      ...ctx,
      fs: {
        ...ctx.fs,
        rename: async () => {
          throw renameError;
        },
        rm: async (p: string) => {
          rmCalled = true;
          return ctx.fs.rm(p);
        },
      },
    };

    // Act
    let caught: unknown;
    try {
      await atomicWriteRef(
        wrapped,
        'refs/heads/r' as never,
        '/repo/.git/refs/heads/r',
        new Uint8Array([1]),
      );
      expect.unreachable();
    } catch (error) {
      caught = error;
    }

    // Assert — the lock was cleaned up and the original rename error surfaced.
    expect(rmCalled).toBe(true);
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
    expect(await wrapped.fs.exists('/repo/.git/refs/heads/r.lock')).toBe(false);
  });

  it('Given rename fails and rm throws FILE_NOT_FOUND, When atomicWriteRef is called, Then swallows the rm error and propagates the rename error', async () => {
    // Arrange — rm throws FILE_NOT_FOUND: the `!isFileNotFound` guard must
    // NOT rethrow rmError, so the original rename error propagates instead.
    // Kills L35 BooleanLiteral/ConditionalExpression and the L46 `===`/`&&`
    // mutants on the FILE_NOT_FOUND-true branch.
    const ctx = await buildSeededContext();
    const renameError = new TsgitError({ code: 'PERMISSION_DENIED', path: '/repo' });
    const rmError = new TsgitError({ code: 'FILE_NOT_FOUND', path: '/repo/x.lock' });
    const wrapped = {
      ...ctx,
      fs: {
        ...ctx.fs,
        rename: async () => {
          throw renameError;
        },
        rm: async () => {
          throw rmError;
        },
      },
    };

    // Act
    let caught: unknown;
    try {
      await atomicWriteRef(
        wrapped,
        'refs/heads/s' as never,
        '/repo/.git/refs/heads/s',
        new Uint8Array([1]),
      );
      expect.unreachable();
    } catch (error) {
      caught = error;
    }

    // Assert — the rename error wins; the swallowed FILE_NOT_FOUND is gone.
    expect(caught).toBe(renameError);
    expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
  });

  it('Given rename fails and rm throws a non-FILE_NOT_FOUND TsgitError, When atomicWriteRef is called, Then propagates the rm error', async () => {
    // Arrange — rm throws PERMISSION_DENIED: `isFileNotFound` returns false
    // (instanceof true, code !== FILE_NOT_FOUND), so `!isFileNotFound` is
    // true and rmError is rethrown. Kills the L35 ConditionalExpression
    // `false` mutant and the L46 EqualityOperator `!==` mutant.
    const ctx = await buildSeededContext();
    const rmError = new TsgitError({ code: 'PERMISSION_DENIED', path: '/repo/t.lock' });
    const wrapped = {
      ...ctx,
      fs: {
        ...ctx.fs,
        rename: async () => {
          throw new TsgitError({ code: 'NOT_A_DIRECTORY', path: '/repo/t' });
        },
        rm: async () => {
          throw rmError;
        },
      },
    };

    // Act
    let caught: unknown;
    try {
      await atomicWriteRef(
        wrapped,
        'refs/heads/t' as never,
        '/repo/.git/refs/heads/t',
        new Uint8Array([1]),
      );
      expect.unreachable();
    } catch (error) {
      caught = error;
    }

    // Assert — the rm error propagates, not the rename error.
    expect(caught).toBe(rmError);
    expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
  });

  it('Given rename fails and rm throws a plain Error (not TsgitError), When atomicWriteRef is called, Then propagates the plain rm error', async () => {
    // Arrange — rm throws a plain Error: `isFileNotFound` returns false via
    // the `instanceof TsgitError` operand, so `!isFileNotFound` rethrows it.
    // Kills the L46 `&&` ConditionalExpression mutants on the instanceof side.
    const ctx = await buildSeededContext();
    const rmError = new Error('rm exploded');
    const wrapped = {
      ...ctx,
      fs: {
        ...ctx.fs,
        rename: async () => {
          throw new TsgitError({ code: 'NOT_A_DIRECTORY', path: '/repo/u' });
        },
        rm: async () => {
          throw rmError;
        },
      },
    };

    // Act
    let caught: unknown;
    try {
      await atomicWriteRef(
        wrapped,
        'refs/heads/u' as never,
        '/repo/.git/refs/heads/u',
        new Uint8Array([1]),
      );
      expect.unreachable();
    } catch (error) {
      caught = error;
    }

    // Assert — the plain rm error propagates.
    expect(caught).toBe(rmError);
    expect((caught as Error).message).toBe('rm exploded');
  });
});
