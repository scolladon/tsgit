import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  deriveSubmoduleCloneContext,
  deriveSubmoduleContext,
} from '../../../../../src/application/primitives/internal/submodule-context.js';
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

  describe('When no child Context can be derived', () => {
    it.each([
      {
        label: 'the submodule is not checked out',
        arrange: async (): Promise<{
          name: string | undefined;
          path: FilePath;
          visited: ReadonlySet<string> | undefined;
        }> => ({ name: 'absent', path: 'absent' as FilePath, visited: undefined }),
      },
      {
        label: 'the name is undefined',
        arrange: async (): Promise<{
          name: string | undefined;
          path: FilePath;
          visited: ReadonlySet<string> | undefined;
        }> => ({ name: undefined, path: 'x' as FilePath, visited: undefined }),
      },
      {
        label: 'the child gitdir is already visited (cycle)',
        arrange: async (
          ctx: ReturnType<typeof createMemoryContext>,
        ): Promise<{
          name: string | undefined;
          path: FilePath;
          visited: ReadonlySet<string> | undefined;
        }> => {
          await seedHead(ctx, 'm');
          return {
            name: 'm',
            path: 'm' as FilePath,
            visited: new Set([`${ctx.layout.gitDir}/modules/m`]),
          };
        },
      },
    ])('Then no child Context is returned ($label)', async ({ arrange }) => {
      // Arrange
      const ctx = createMemoryContext();
      const { name, path, visited } = await arrange(ctx);

      // Act
      const sut = await deriveSubmoduleContext(ctx, name, path, visited);

      // Assert
      expect(sut).toBeUndefined();
    });
  });
});

describe('Given a superproject Context and a not-yet-cloned submodule', () => {
  describe('When deriving the clone-target Context (no HEAD guard)', () => {
    it('Then a child Context targeting modules/<name> is returned even though the gitdir is absent', () => {
      // Arrange
      const ctx = createMemoryContext();
      // Act — no HEAD seeded: the gitdir is about to be created by clone
      const sut = deriveSubmoduleCloneContext(ctx, 'libs/a', 'libs/a' as FilePath);
      // Assert
      expect(sut.layout.gitDir).toBe(`${ctx.layout.gitDir}/modules/libs/a`);
      expect(sut.layout.workDir).toBe(`${ctx.layout.workDir}/libs/a`);
      expect(sut.cwd).toBe(`${ctx.layout.workDir}/libs/a`);
      expect(sut.layout.bare).toBe(false);
    });

    it('Then promisor and hooks are dropped while transport and config are inherited', () => {
      // Arrange
      const ctx = createMemoryContext();
      // Act
      const sut = deriveSubmoduleCloneContext(ctx, 'm', 'm' as FilePath);
      // Assert
      expect(sut.promisor).toBeUndefined();
      expect(sut.hooks).toBeUndefined();
      expect(sut.transport).toBe(ctx.transport);
      expect(sut.config).toBe(ctx.config);
    });

    it('Then a configured homeDir propagates to the child layout', () => {
      // Arrange
      const ctx = createMemoryContext({ homeDir: '/home/u' });
      // Act
      const sut = deriveSubmoduleCloneContext(ctx, 'm', 'm' as FilePath);
      // Assert
      expect(sut.layout.homeDir).toBe('/home/u');
    });
  });
});
