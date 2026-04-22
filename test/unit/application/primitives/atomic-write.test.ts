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
});
