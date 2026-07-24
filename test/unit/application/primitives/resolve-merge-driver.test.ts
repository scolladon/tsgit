import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { buildAttributeProvider } from '../../../../src/application/primitives/internal/read-gitattributes.js';
import { resolvePathMergeSpec } from '../../../../src/application/primitives/resolve-merge-driver.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../src/ports/context.js';

const spec = async (ctx: Context, path: string) => {
  const provider = await buildAttributeProvider(ctx);
  return resolvePathMergeSpec(ctx, provider, path as FilePath);
};

const choose = async (ctx: Context, path: string) => (await spec(ctx, path)).driver;

const seed = (ctx: Context, attrs?: string, config?: string): Promise<void[]> =>
  Promise.all([
    attrs === undefined
      ? Promise.resolve()
      : ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, attrs),
    config === undefined
      ? Promise.resolve()
      : ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config),
  ]);

describe('resolvePathMergeSpec — driver resolution', () => {
  describe('Given a merge attribute/config combination that has no external driver', () => {
    describe('When resolving', () => {
      it.each([
        { label: 'no merge attribute at all', attrs: undefined, config: undefined },
        {
          label: 'the merge attribute set without a value',
          attrs: '* merge\n',
          config: undefined,
        },
        { label: 'merge=text', attrs: '* merge=text\n', config: undefined },
        {
          label: 'merge=text with only an unknown-key config section (empty record)',
          attrs: '* merge=text\n',
          config: '[merge "text"]\n\tfoo = bar\n',
        },
        {
          label: 'merge=custom with no matching config section',
          attrs: '* merge=custom\n',
          config: undefined,
        },
      ])('Then the built-in text driver is chosen ($label)', async ({ attrs, config }) => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, attrs, config);

        // Act
        const sut = await choose(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ kind: 'text' });
      });
    });
  });

  describe('Given a merge attribute value that resolves to the built-in binary driver', () => {
    describe('When resolving', () => {
      it.each([
        { label: 'the merge attribute unset (`-merge`)', attrs: '* -merge\n' },
        { label: 'merge=binary', attrs: '* merge=binary\n' },
        { label: 'the binary macro', attrs: '* binary\n' },
      ])('Then the built-in binary driver is chosen ($label)', async ({ attrs }) => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, attrs);

        // Act
        const sut = await choose(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ kind: 'binary' });
      });
    });
  });

  describe('Given merge=union', () => {
    describe('When resolving', () => {
      it('Then the built-in union driver is chosen', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '* merge=union\n');

        // Act
        const sut = await choose(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ kind: 'union' });
      });
    });
  });

  describe('Given merge=custom with a configured driver and name', () => {
    describe('When resolving', () => {
      it('Then the external command is chosen with its name', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(
          ctx,
          '* merge=custom\n',
          '[merge "custom"]\n  name = My Driver\n  driver = run %O %A %B\n',
        );

        // Act
        const sut = await choose(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ kind: 'external', command: 'run %O %A %B', name: 'My Driver' });
      });
    });
  });

  describe('Given a named driver section configured with a driver command but no name', () => {
    describe('When resolving', () => {
      it.each([
        {
          label: 'merge=custom with a configured driver but no name',
          attrs: '* merge=custom\n',
          config: '[merge "custom"]\n  driver = run %A\n',
        },
        {
          label: 'merge=text overrides the built-in text driver',
          attrs: '* merge=text\n',
          config: '[merge "text"]\n\tdriver = run %A\n',
        },
        {
          label: 'merge=binary overrides the built-in binary driver',
          attrs: '* merge=binary\n',
          config: '[merge "binary"]\n\tdriver = run %A\n',
        },
        {
          label: 'merge=union overrides the built-in union driver',
          attrs: '* merge=union\n',
          config: '[merge "union"]\n\tdriver = run %A\n',
        },
      ])(
        'Then the external command is chosen without a name ($label)',
        async ({ attrs, config }) => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, attrs, config);

          // Act
          const sut = await choose(ctx, 'a.txt');

          // Assert
          expect(sut).toEqual({ kind: 'external', command: 'run %A' });
        },
      );
    });
  });

  describe('Given a named driver section with no driver command', () => {
    describe('When resolving', () => {
      it.each([
        {
          label: 'merge=custom whose configured driver has no driver command',
          attrs: '* merge=custom\n',
          config: '[merge "custom"]\n  name = My Driver\n',
          name: 'custom',
        },
        {
          label: 'merge=text registered with only a name and no driver command',
          attrs: '* merge=text\n',
          config: '[merge "text"]\n\tname = X\n',
          name: 'text',
        },
        {
          label: 'merge=text registered with only recursive and no driver command',
          attrs: '* merge=text\n',
          config: '[merge "text"]\n\trecursive = text\n',
          name: 'text',
        },
      ])(
        'Then the missing-command choice is returned, naming the driver ($label)',
        async ({ attrs, config, name }) => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, attrs, config);

          // Act
          const sut = await choose(ctx, 'a.txt');

          // Assert
          expect(sut).toEqual({ kind: 'missing-command', name });
        },
      );
    });
  });

  describe('Given merge=text with a configured driver and name on the built-in name', () => {
    describe('When resolving', () => {
      it('Then the configured driver overrides the built-in text driver with its name', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '* merge=text\n', '[merge "text"]\n\tname = X\n\tdriver = run %A\n');

        // Act
        const sut = await choose(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ kind: 'external', command: 'run %A', name: 'X' });
      });
    });
  });

  describe('Given the merge attribute unset (`-merge`) with a configured driver on merge=binary', () => {
    describe('When resolving', () => {
      it('Then the binary driver is chosen without consulting config', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '* -merge\n', '[merge "binary"]\n\tdriver = run %A\n');

        // Act
        const sut = await choose(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ kind: 'binary' });
      });
    });
  });
});

describe('resolvePathMergeSpec — valueless merge driver config is not guarded here', () => {
  describe('Given a valueless merge driver configuration', () => {
    describe('When resolving', () => {
      it.each([
        {
          label: 'merge=mydriver with no matching config section',
          attrs: '* merge=mydriver\n',
          config: undefined,
        },
        {
          label:
            'a valueless driver under a [merge "mydriver"] section (guard lives at the chokepoint)',
          attrs: '* merge=mydriver\n',
          config: '[merge "mydriver"]\n\tdriver\n',
        },
        {
          label:
            'merge=text built-in name with a valueless driver under a same-named section (empty record falls back by name)',
          attrs: '* merge=text\n',
          config: '[merge "text"]\n\tdriver\n',
        },
      ])(
        'Then it falls back to the text driver and does not throw ($label)',
        async ({ attrs, config }) => {
          // Arrange
          const ctx = createMemoryContext();
          await seed(ctx, attrs, config);

          // Act
          const result = await choose(ctx, 'a.txt');

          // Assert
          expect(result).toEqual({ kind: 'text' });
        },
      );
    });
  });

  describe('Given merge=mydriver with a valued driver and name', () => {
    describe('When resolving', () => {
      it('Then the external command is chosen with its name and no throw', async () => {
        // Arrange — both keys valued.
        const ctx = createMemoryContext();
        await seed(
          ctx,
          '* merge=mydriver\n',
          '[merge "mydriver"]\n\tdriver = mycmd\n\tname = My Driver\n',
        );

        // Act
        const result = await choose(ctx, 'a.txt');

        // Assert
        expect(result).toEqual({ kind: 'external', command: 'mycmd', name: 'My Driver' });
      });
    });
  });
});

describe('resolvePathMergeSpec', () => {
  describe('Given no attributes', () => {
    describe('When resolving the spec', () => {
      it('Then the driver is text and the marker size defaults to 7', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const sut = await spec(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ driver: { kind: 'text' }, markerSize: 7 });
      });
    });
  });

  describe('Given conflict-marker-size=15', () => {
    describe('When resolving the spec', () => {
      it('Then the marker size is 15', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '* conflict-marker-size=15\n');

        // Act
        const sut = await spec(ctx, 'a.txt');

        // Assert
        expect(sut.markerSize).toBe(15);
      });
    });
  });

  describe('Given merge=custom and conflict-marker-size=12 together', () => {
    describe('When resolving the spec', () => {
      it('Then both the external driver and the marker size are resolved in one pass', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(
          ctx,
          '* merge=custom conflict-marker-size=12\n',
          '[merge "custom"]\n  driver = run %A\n',
        );

        // Act
        const sut = await spec(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({
          driver: { kind: 'external', command: 'run %A' },
          markerSize: 12,
        });
      });
    });
  });

  describe('Given a deeper .gitattributes overriding conflict-marker-size', () => {
    describe('When resolving the spec for a nested path', () => {
      it('Then the nearest directory rule wins', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8(
          `${ctx.layout.workDir}/.gitattributes`,
          '* conflict-marker-size=7\n',
        );
        await ctx.fs.writeUtf8(
          `${ctx.layout.workDir}/sub/.gitattributes`,
          '* conflict-marker-size=9\n',
        );

        // Act
        const sut = await spec(ctx, 'sub/a.txt');

        // Assert
        expect(sut.markerSize).toBe(9);
      });
    });
  });
});
