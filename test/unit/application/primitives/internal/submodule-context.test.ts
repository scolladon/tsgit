import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { deriveSubmoduleContext } from '../../../../../src/application/primitives/internal/submodule-context.js';
import type { FilePath } from '../../../../../src/domain/objects/index.js';

const seedHead = async (
  ctx: ReturnType<typeof createMemoryContext>,
  name: string,
): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/modules/${name}/HEAD`, 'ref: refs/heads/main\n');
};

describe('Given a superproject Context and a submodule name', () => {
  describe('When the absorbed gitdir is present', () => {
    it('Then a child Context targeting modules/<name> is returned', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedHead(ctx, 'libs/a');
      // Act
      const sut = await deriveSubmoduleContext(ctx, 'libs/a', 'libs/a' as FilePath);
      // Assert
      expect(sut?.layout.gitDir).toBe(`${ctx.layout.gitDir}/modules/libs/a`);
      expect(sut?.layout.workDir).toBe(`${ctx.layout.workDir}/libs/a`);
      expect(sut?.cwd).toBe(`${ctx.layout.workDir}/libs/a`);
    });

    it('Then promisor and hooks are dropped from the child', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedHead(ctx, 'm');
      // Act
      const sut = await deriveSubmoduleContext(ctx, 'm', 'm' as FilePath);
      // Assert
      expect(sut?.promisor).toBeUndefined();
      expect(sut?.hooks).toBeUndefined();
    });

    it('Then a configured homeDir propagates to the child layout', async () => {
      // Arrange
      const ctx = createMemoryContext({ homeDir: '/home/u' });
      await seedHead(ctx, 'm');
      // Act
      const sut = await deriveSubmoduleContext(ctx, 'm', 'm' as FilePath);
      // Assert
      expect(sut?.layout.homeDir).toBe('/home/u');
    });
  });

  describe('When the submodule is not checked out', () => {
    it('Then no child Context is returned', async () => {
      // Arrange
      const ctx = createMemoryContext();
      // Act
      const sut = await deriveSubmoduleContext(ctx, 'absent', 'absent' as FilePath);
      // Assert
      expect(sut).toBeUndefined();
    });
  });

  describe('When the name is undefined', () => {
    it('Then no child Context is returned', async () => {
      // Arrange
      const ctx = createMemoryContext();
      // Act
      const sut = await deriveSubmoduleContext(ctx, undefined, 'x' as FilePath);
      // Assert
      expect(sut).toBeUndefined();
    });
  });

  describe('When the child gitdir is already visited (cycle)', () => {
    it('Then no child Context is returned', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedHead(ctx, 'm');
      const visited = new Set([`${ctx.layout.gitDir}/modules/m`]);
      // Act
      const sut = await deriveSubmoduleContext(ctx, 'm', 'm' as FilePath, visited);
      // Assert
      expect(sut).toBeUndefined();
    });
  });
});
