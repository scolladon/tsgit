import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { buildAttributeProvider } from '../../../../src/application/primitives/internal/read-gitattributes.js';
import { resolveTextconvDriver } from '../../../../src/application/primitives/resolve-textconv-driver.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../src/ports/context.js';

const choose = async (ctx: Context, path: string) => {
  const provider = await buildAttributeProvider(ctx);
  return resolveTextconvDriver(ctx, provider, path as FilePath);
};

const seed = (ctx: Context, attrs?: string, config?: string) =>
  Promise.all([
    attrs === undefined
      ? Promise.resolve()
      : ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, attrs),
    config === undefined
      ? Promise.resolve()
      : ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config),
  ]);

describe('resolveTextconvDriver', () => {
  describe('Given no diff attribute', () => {
    describe('When resolving the diff driver', () => {
      it('Then none is chosen (raw diff)', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const sut = await choose(ctx, 'a.x');

        // Assert
        expect(sut).toEqual({ kind: 'none' });
      });
    });
  });

  describe('Given a.x diff=upper with [diff "upper"] textconv = up configured', () => {
    describe('When resolving the diff driver', () => {
      it('Then external textconv with command "up" is chosen', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, 'a.x diff=upper\n', '[diff "upper"]\n\ttextconv = up\n');

        // Act
        const sut = await choose(ctx, 'a.x');

        // Assert
        expect(sut).toEqual({ kind: 'external', command: 'up' });
      });
    });
  });

  describe('Given a.x diff=upper with no [diff "upper"] section (T2)', () => {
    describe('When resolving the diff driver', () => {
      it('Then none is chosen (named-but-unconfigured falls back to raw diff)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, 'a.x diff=upper\n');

        // Act
        const sut = await choose(ctx, 'a.x');

        // Assert
        expect(sut).toEqual({ kind: 'none' });
      });
    });
  });

  describe('Given a.x diff=upper with [diff "upper"] textconv = (empty string) (T2e)', () => {
    describe('When resolving the diff driver', () => {
      it('Then none is chosen (empty textconv folds to fallback, not fatal)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, 'a.x diff=upper\n', '[diff "upper"]\n\ttextconv =\n');

        // Act
        const sut = await choose(ctx, 'a.x');

        // Assert
        expect(sut).toEqual({ kind: 'none' });
      });
    });
  });

  describe('Given a.x -diff (diff attribute unset)', () => {
    describe('When resolving the diff driver', () => {
      it('Then none is chosen (binary-for-diff, no textconv)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, 'a.x -diff\n');

        // Act
        const sut = await choose(ctx, 'a.x');

        // Assert
        expect(sut).toEqual({ kind: 'none' });
      });
    });
  });

  describe('Given a.x binary (macro expands to -diff -merge -text)', () => {
    describe('When resolving the diff driver', () => {
      it('Then none is chosen (binary macro sets -diff, no textconv)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, 'a.x binary\n');

        // Act
        const sut = await choose(ctx, 'a.x');

        // Assert
        expect(sut).toEqual({ kind: 'none' });
      });
    });
  });

  describe('Given a.x diff (bare true, default text diff)', () => {
    describe('When resolving the diff driver', () => {
      it('Then none is chosen (true means default text diff, not textconv)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, 'a.x diff\n');

        // Act
        const sut = await choose(ctx, 'a.x');

        // Assert
        expect(sut).toEqual({ kind: 'none' });
      });
    });
  });
});
