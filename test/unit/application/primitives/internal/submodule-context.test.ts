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
      const result = await deriveSubmoduleContext(ctx, 'libs/a', 'libs/a' as FilePath);
      // Assert
      expect(result?.layout.gitDir).toBe(`${ctx.layout.gitDir}/modules/libs/a`);
      expect(result?.layout.workDir).toBe(`${ctx.layout.workDir}/libs/a`);
      expect(result?.cwd).toBe(`${ctx.layout.workDir}/libs/a`);
    });

    it('Then promisor and hooks are dropped from the child', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedHead(ctx, 'm');
      // Act
      const result = await deriveSubmoduleContext(ctx, 'm', 'm' as FilePath);
      // Assert
      expect(result?.promisor).toBeUndefined();
      expect(result?.hooks).toBeUndefined();
    });

    it('Then a configured homeDir propagates to the child layout', async () => {
      // Arrange
      const ctx = createMemoryContext({ homeDir: '/home/u' });
      await seedHead(ctx, 'm');
      // Act
      const result = await deriveSubmoduleContext(ctx, 'm', 'm' as FilePath);
      // Assert
      expect(result?.layout.homeDir).toBe('/home/u');
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
      const result = await deriveSubmoduleContext(ctx, name, path, visited);

      // Assert
      expect(result).toBeUndefined();
    });
  });
});

describe('Given a superproject Context and a not-yet-cloned submodule', () => {
  describe('When deriving the clone-target Context (no HEAD guard)', () => {
    it('Then a child Context targeting modules/<name> is returned even though the gitdir is absent', () => {
      // Arrange
      const ctx = createMemoryContext();
      // Act — no HEAD seeded: the gitdir is about to be created by clone
      const result = deriveSubmoduleCloneContext(ctx, 'libs/a', 'libs/a' as FilePath);
      // Assert
      expect(result.layout.gitDir).toBe(`${ctx.layout.gitDir}/modules/libs/a`);
      expect(result.layout.workDir).toBe(`${ctx.layout.workDir}/libs/a`);
      expect(result.cwd).toBe(`${ctx.layout.workDir}/libs/a`);
      expect(result.layout.bare).toBe(false);
    });

    it('Then promisor and hooks are dropped while transport and config are inherited', () => {
      // Arrange
      const ctx = createMemoryContext();
      // Act
      const result = deriveSubmoduleCloneContext(ctx, 'm', 'm' as FilePath);
      // Assert
      expect(result.promisor).toBeUndefined();
      expect(result.hooks).toBeUndefined();
      expect(result.transport).toBe(ctx.transport);
      expect(result.config).toBe(ctx.config);
    });

    it('Then a configured homeDir propagates to the child layout', () => {
      // Arrange
      const ctx = createMemoryContext({ homeDir: '/home/u' });
      // Act
      const result = deriveSubmoduleCloneContext(ctx, 'm', 'm' as FilePath);
      // Assert
      expect(result.layout.homeDir).toBe('/home/u');
    });
  });
});

describe('deriveSubmoduleContext — the acceptance verdicts', () => {
  describe('Given a superproject layout the acceptance tier refused', () => {
    describe('When the submodule context is derived', () => {
      it('Then all four verdict fields survive the derivation', async () => {
        // Arrange — a submodule of a refused superproject must not read as
        // accepted; it shares the superproject's common dir, so it is the very
        // config the gate declined to open.
        const base = createMemoryContext();
        await seedHead(base, 'libs/a');
        const parent = {
          ...base,
          layout: {
            ...base.layout,
            untrusted: true as const,
            implicitBare: true as const,
            foreignPath: '/foreign/gitdir',
            formatRefusal: { kind: 'version' as const, version: 99 },
          },
        };

        // Act
        const result = await deriveSubmoduleContext(parent, 'libs/a', 'libs/a' as FilePath);

        // Assert
        expect(result?.layout.untrusted).toBe(true);
        expect(result?.layout.implicitBare).toBe(true);
        expect(result?.layout.foreignPath).toBe('/foreign/gitdir');
        expect(result?.layout.formatRefusal).toStrictEqual({ kind: 'version', version: 99 });
      });
    });
  });

  describe('Given a superproject layout the acceptance tier accepted', () => {
    describe('When the submodule context is derived', () => {
      it('Then no verdict key is present at all, not merely undefined', async () => {
        // Arrange
        const parent = createMemoryContext();
        await seedHead(parent, 'libs/a');

        // Act
        const result = await deriveSubmoduleContext(parent, 'libs/a', 'libs/a' as FilePath);

        // Assert
        expect(result).toBeDefined();
        expect('untrusted' in (result?.layout ?? {})).toBe(false);
        expect('formatRefusal' in (result?.layout ?? {})).toBe(false);
      });
    });
  });
});
