import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { invalidateConfigCache } from '../../../../../src/application/primitives/config-read.js';
import {
  buildSimilarityContentKindResolver,
  resolveSimilarityOverride,
} from '../../../../../src/application/primitives/internal/resolve-similarity-content-kind.js';
import type { FilePath } from '../../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../../src/ports/context.js';

const seed = async (ctx: Context, path: string, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(path, content);
};

const seedConfig = async (ctx: Context, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);
  invalidateConfigCache(ctx);
};

describe('resolveSimilarityOverride', () => {
  describe('Given the diff attribute is false (-diff)', () => {
    describe('When resolveSimilarityOverride is called', () => {
      it('Then returns binary regardless of driverBinary', () => {
        // Arrange + Act
        const result = resolveSimilarityOverride(false, undefined);

        // Assert
        expect(result).toBe('binary');
      });
    });
  });

  describe('Given the diff attribute is true (bare diff)', () => {
    describe('When resolveSimilarityOverride is called', () => {
      it('Then returns text regardless of driverBinary', () => {
        // Arrange + Act
        const result = resolveSimilarityOverride(true, true);

        // Assert
        expect(result).toBe('text');
      });
    });
  });

  describe('Given the diff attribute is unspecified', () => {
    describe('When resolveSimilarityOverride is called', () => {
      it('Then returns undefined (content sniff decides)', () => {
        // Arrange + Act
        const result = resolveSimilarityOverride('unspecified', true);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given the diff attribute names a driver', () => {
    describe('When the driver config sets binary=true', () => {
      it('Then returns binary', () => {
        // Arrange + Act
        const result = resolveSimilarityOverride({ set: 'drv' }, true);

        // Assert
        expect(result).toBe('binary');
      });
    });

    describe('When the driver config sets binary=false', () => {
      it('Then returns text', () => {
        // Arrange + Act
        const result = resolveSimilarityOverride({ set: 'drv' }, false);

        // Assert
        expect(result).toBe('text');
      });
    });

    describe('When the driver has no binary config', () => {
      it('Then returns undefined (content sniff decides)', () => {
        // Arrange + Act
        const result = resolveSimilarityOverride({ set: 'drv' }, undefined);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});

describe('buildSimilarityContentKindResolver', () => {
  describe('Given a repository with no gitattributes at all', () => {
    describe('When overrideFor is called for any path', () => {
      it('Then resolves undefined (content sniff decides)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = buildSimilarityContentKindResolver(ctx);

        // Act
        const result = await sut.overrideFor('file.txt' as FilePath);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a path matched by -diff in .gitattributes', () => {
    describe('When overrideFor is called', () => {
      it('Then resolves binary', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, `${ctx.layout.workDir}/.gitattributes`, '*.bin -diff\n');
        const sut = buildSimilarityContentKindResolver(ctx);

        // Act
        const result = await sut.overrideFor('file.bin' as FilePath);

        // Assert
        expect(result).toBe('binary');
      });
    });
  });

  describe('Given a path matched by bare diff in .gitattributes', () => {
    describe('When overrideFor is called', () => {
      it('Then resolves text', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, `${ctx.layout.workDir}/.gitattributes`, '*.txt diff\n');
        const sut = buildSimilarityContentKindResolver(ctx);

        // Act
        const result = await sut.overrideFor('file.txt' as FilePath);

        // Assert
        expect(result).toBe('text');
      });
    });
  });

  describe('Given a path with diff=<name> and [diff "<name>"] binary=true', () => {
    describe('When overrideFor is called', () => {
      it('Then resolves binary', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, `${ctx.layout.workDir}/.gitattributes`, '*.drv diff=custom\n');
        await seedConfig(ctx, '[diff "custom"]\n\tbinary = true\n');
        const sut = buildSimilarityContentKindResolver(ctx);

        // Act
        const result = await sut.overrideFor('file.drv' as FilePath);

        // Assert
        expect(result).toBe('binary');
      });
    });
  });

  describe('Given a path with diff=<name> and no [diff "<name>"] section at all', () => {
    describe('When overrideFor is called', () => {
      it('Then resolves undefined (content sniff decides)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, `${ctx.layout.workDir}/.gitattributes`, '*.drv diff=ghost\n');
        const sut = buildSimilarityContentKindResolver(ctx);

        // Act
        const result = await sut.overrideFor('file.drv' as FilePath);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given the same path is resolved twice', () => {
    describe('When overrideFor is called twice without awaiting between calls', () => {
      it('Then the second call reuses the first call in-flight promise', () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = buildSimilarityContentKindResolver(ctx);

        // Act
        const first = sut.overrideFor('file.txt' as FilePath);
        const second = sut.overrideFor('file.txt' as FilePath);

        // Assert
        expect(second).toBe(first);
      });
    });
  });
});
