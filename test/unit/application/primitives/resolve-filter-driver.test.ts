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
  describe('Given a filter attribute value that is false, true, or unspecified', () => {
    describe('When resolving the filter driver', () => {
      it.each([
        { label: 'no attribute at all (unspecified) maps to identity', attrs: undefined },
        { label: '-filter (false) maps to identity', attrs: 'a.y -filter\n' },
        { label: 'filter (bare true) maps to identity', attrs: 'a.y filter\n' },
      ])('Then $label', async ({ attrs }) => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, attrs);

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
        expect(sut).toEqual({
          kind: 'external',
          name: 'myf',
          clean: 'up',
          smudge: 'down',
          required: false,
        });
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
        expect(sut).toEqual({
          kind: 'external',
          name: 'myf',
          clean: 'up',
          smudge: 'down',
          required: false,
        });
      });
    });
  });

  describe('Given a [filter "<name>"] section configured with clean (no smudge)', () => {
    describe('When resolving the filter driver', () => {
      it.each([
        {
          label: 'clean only is chosen with required=false (smudge identity)',
          attrs: 'a.y filter=c\n',
          config: '[filter "c"]\n\tclean = up\n',
          expected: { kind: 'external', name: 'c', clean: 'up', required: false },
        },
        {
          label: 'required=true is carried on the external arm',
          attrs: 'a.y filter=f\n',
          config: '[filter "f"]\n\tclean = false\n\trequired = true\n',
          expected: { kind: 'external', name: 'f', clean: 'false', required: true },
        },
        {
          // name must be present so CLEAN_FILTER_FAILED can carry it.
          label: 'the driver name is carried on the external arm',
          attrs: '*.y filter=myf\n',
          config: '[filter "myf"]\n\tclean = up\n',
          expected: { kind: 'external', name: 'myf', clean: 'up', required: false },
        },
      ])('Then $label', async ({ attrs, config, expected }) => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, attrs, config);

        // Act
        const sut = await choose(ctx, 'a.y');

        // Assert
        expect(sut).toEqual(expected);
      });
    });
  });
});
