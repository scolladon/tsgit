/**
 * A symbolic ref whose chain read faults with a permission error is a broken ref, reported
 * with a zero pointer; any other fault of the read is a fault of the run and propagates.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { fsck } from '../../../../src/application/commands/fsck.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import { permissionDenied } from '../../../../src/domain/error.js';
import type { Context } from '../../../../src/ports/context.js';

vi.mock('../../../../src/application/primitives/resolve-ref.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../src/application/primitives/resolve-ref.js')>();
  return { ...actual, resolveRef: vi.fn(actual.resolveRef) };
});

const EXIT_MISSING = 2;
const ZERO_POINTER = '0'.repeat(40);

const repositoryWithRemoteHead = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(
    `${ctx.layout.gitDir}/refs/remotes/origin/HEAD`,
    'ref: refs/remotes/origin/main\n',
  );
  return ctx;
};

describe('Given a symbolic ref whose first chain read faults with a permission error', () => {
  describe('When fsck runs', () => {
    it('Then the ref gets a zero pointer and the run exits with the missing bit', async () => {
      // Arrange
      const ctx = await repositoryWithRemoteHead();
      const fault = permissionDenied(`${ctx.layout.gitDir}/refs/remotes/origin/main`);
      vi.mocked(resolveRef).mockRejectedValueOnce(fault);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result.findings.filter((finding) => finding.type === 'bad-ref')).toEqual([
        {
          type: 'bad-ref',
          ref: 'refs/remotes/origin/HEAD',
          msgId: 'badRefOid',
          severity: 'error',
          target: ZERO_POINTER,
        },
      ]);
      expect(result.exitCode & EXIT_MISSING).toBe(EXIT_MISSING);
    });
  });
});

describe('Given a symbolic ref whose first chain read faults with an unclassified error', () => {
  describe('When fsck runs', () => {
    it('Then the fault propagates', async () => {
      // Arrange
      const ctx = await repositoryWithRemoteHead();
      const fault = new Error('EIO: i/o error');
      vi.mocked(resolveRef).mockRejectedValueOnce(fault);
      const sut = fsck;

      // Act
      const result = sut(ctx);

      // Assert
      await expect(result).rejects.toBe(fault);
    });
  });
});
