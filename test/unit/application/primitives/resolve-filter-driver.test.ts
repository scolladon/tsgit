import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { buildAttributeProvider } from '../../../../src/application/primitives/internal/read-gitattributes.js';
import { resolveFilterDriver } from '../../../../src/application/primitives/resolve-filter-driver.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../src/ports/context.js';

const choose = async (ctx: Context, path: string) => {
  const provider = await buildAttributeProvider(ctx);
  return resolveFilterDriver(ctx, provider, path as FilePath);
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

describe('resolveFilterDriver', () => {
  describe('Given no filter attribute', () => {
    describe('When resolving the filter driver', () => {
      it('Then identity is chosen', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const sut = await choose(ctx, 'a.y');

        // Assert
        expect(sut).toEqual({ kind: 'identity' });
      });
    });
  });

  describe('Given a.y -filter (filter attribute unset)', () => {
    describe('When resolving the filter driver', () => {
      it('Then identity is chosen (false maps to identity)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, 'a.y -filter\n');

        // Act
        const sut = await choose(ctx, 'a.y');

        // Assert
        expect(sut).toEqual({ kind: 'identity' });
      });
    });
  });

  describe('Given a.y filter (bare true, unspecified)', () => {
    describe('When resolving the filter driver', () => {
      it('Then identity is chosen (true maps to identity)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, 'a.y filter\n');

        // Act
        const sut = await choose(ctx, 'a.y');

        // Assert
        expect(sut).toEqual({ kind: 'identity' });
      });
    });
  });

  describe('Given *.y filter=myf with [filter "myf"] clean and smudge configured', () => {
    describe('When resolving the filter driver', () => {
      it('Then external driver with clean, smudge, and required=false is chosen', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '*.y filter=myf\n', '[filter "myf"]\n\tclean = up\n\tsmudge = down\n');

        // Act
        const sut = await choose(ctx, 'a.y');

        // Assert
        expect(sut).toEqual({ kind: 'external', clean: 'up', smudge: 'down', required: false });
      });
    });
  });

  describe('Given [filter "c"] clean only (no smudge)', () => {
    describe('When resolving the filter driver', () => {
      it('Then external driver with only clean and required=false is chosen (smudge identity)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, 'a.y filter=c\n', '[filter "c"]\n\tclean = up\n');

        // Act
        const sut = await choose(ctx, 'a.y');

        // Assert
        expect(sut).toEqual({ kind: 'external', clean: 'up', required: false });
      });
    });
  });

  describe('Given [filter "f"] with required=true', () => {
    describe('When resolving the filter driver', () => {
      it('Then external driver with required=true is chosen', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, 'a.y filter=f\n', '[filter "f"]\n\tclean = false\n\trequired = true\n');

        // Act
        const sut = await choose(ctx, 'a.y');

        // Assert
        expect(sut).toEqual({ kind: 'external', clean: 'false', required: true });
      });
    });
  });

  describe('Given filter=myf with no matching [filter "myf"] section', () => {
    describe('When resolving the filter driver', () => {
      it('Then identity is chosen (unconfigured driver is inert)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, 'a.y filter=myf\n');

        // Act
        const sut = await choose(ctx, 'a.y');

        // Assert
        expect(sut).toEqual({ kind: 'identity' });
      });
    });
  });

  describe('Given a.y binary macro (expands to -diff -merge -text, NOT -filter)', () => {
    describe('When resolving the filter driver with filter=lfs in gitattributes', () => {
      it('Then external driver is chosen (binary macro does not clear filter)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(
          ctx,
          'a.y binary filter=myf\n',
          '[filter "myf"]\n\tclean = up\n\tsmudge = down\n',
        );

        // Act
        const sut = await choose(ctx, 'a.y');

        // Assert
        expect(sut).toEqual({ kind: 'external', clean: 'up', smudge: 'down', required: false });
      });
    });
  });
});
