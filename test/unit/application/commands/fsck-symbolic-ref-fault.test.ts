/**
 * A symbolic ref's chain read that fails for a reason other than a broken
 * ref is a fault of the run, not a ref that names nothing: it propagates.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { fsck } from '../../../../src/application/commands/fsck.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { permissionDenied, type TsgitError } from '../../../../src/domain/error.js';

vi.mock('../../../../src/application/primitives/resolve-ref.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../src/application/primitives/resolve-ref.js')>();
  return { ...actual, resolveRef: vi.fn(actual.resolveRef) };
});

describe('Given a symbolic ref whose first chain read faults with a permission error', () => {
  describe('When fsck runs', () => {
    it('Then the fault propagates instead of the ref naming nothing', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
      await ctx.fs.writeUtf8(
        `${ctx.layout.gitDir}/refs/remotes/origin/HEAD`,
        'ref: refs/remotes/origin/main\n',
      );
      const fault = permissionDenied(`${ctx.layout.gitDir}/refs/remotes/origin/main`);
      vi.mocked(resolveRef).mockRejectedValueOnce(fault);
      const sut = fsck;

      // Act
      let caught: unknown;
      try {
        await sut(ctx);
      } catch (error) {
        caught = error;
      }

      // Assert
      expect((caught as TsgitError).data).toEqual(fault.data);
    });
  });
});
