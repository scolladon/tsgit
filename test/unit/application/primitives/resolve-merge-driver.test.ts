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
  describe('Given no merge attribute', () => {
    describe('When resolving', () => {
      it('Then the built-in text driver is chosen', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const sut = await choose(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ kind: 'text' });
      });
    });
  });

  describe('Given the merge attribute set without a value', () => {
    describe('When resolving', () => {
      it('Then the text driver is chosen', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '* merge\n');

        // Act
        const sut = await choose(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ kind: 'text' });
      });
    });
  });

  describe('Given merge=text', () => {
    describe('When resolving', () => {
      it('Then the text driver is chosen', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '* merge=text\n');

        // Act
        const sut = await choose(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ kind: 'text' });
      });
    });
  });

  describe('Given the merge attribute unset (`-merge`)', () => {
    describe('When resolving', () => {
      it('Then the binary driver is chosen', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '* -merge\n');

        // Act
        const sut = await choose(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ kind: 'binary' });
      });
    });
  });

  describe('Given merge=binary', () => {
    describe('When resolving', () => {
      it('Then the binary driver is chosen', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '* merge=binary\n');

        // Act
        const sut = await choose(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ kind: 'binary' });
      });
    });
  });

  describe('Given the binary macro', () => {
    describe('When resolving', () => {
      it('Then the binary driver is chosen', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '* binary\n');

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

  describe('Given merge=custom with a configured driver but no name', () => {
    describe('When resolving', () => {
      it('Then the external command is chosen without a name', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '* merge=custom\n', '[merge "custom"]\n  driver = run %A\n');

        // Act
        const sut = await choose(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ kind: 'external', command: 'run %A' });
      });
    });
  });

  describe('Given merge=custom whose configured driver has no driver command', () => {
    describe('When resolving', () => {
      it('Then it falls back to the text driver', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '* merge=custom\n', '[merge "custom"]\n  name = My Driver\n');

        // Act
        const sut = await choose(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ kind: 'text' });
      });
    });
  });

  describe('Given merge=custom with no matching config section', () => {
    describe('When resolving', () => {
      it('Then it falls back to the text driver', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '* merge=custom\n');

        // Act
        const sut = await choose(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ kind: 'text' });
      });
    });
  });
});

describe('resolvePathMergeSpec — valueless merge driver config', () => {
  const chooseData = async (
    ctx: Context,
    path: string,
  ): Promise<{ code?: string; key?: string; line?: number; source?: string }> => {
    try {
      await choose(ctx, path);
    } catch (err) {
      return (err as { data?: { code?: string; key?: string; line?: number; source?: string } })
        .data as { code?: string; key?: string; line?: number; source?: string };
    }
    return {};
  };

  describe('Given merge=mydriver with a present-but-valueless driver', () => {
    describe('When resolving', () => {
      it('Then throws CONFIG_MISSING_VALUE for merge.mydriver.driver at its line', async () => {
        // Arrange — driver valueless at line 2.
        const ctx = createMemoryContext();
        await seed(ctx, '* merge=mydriver\n', '[merge "mydriver"]\n\tdriver\n');

        // Act
        const sut = await chooseData(ctx, 'a.txt');

        // Assert
        expect(sut.code).toBe('CONFIG_MISSING_VALUE');
        expect(sut.key).toBe('merge.mydriver.driver');
        expect(sut.line).toBe(2);
        expect(sut.source).toMatch(/\/config$/);
      });
    });
  });

  describe('Given merge=mydriver with a valued driver but a valueless name', () => {
    describe('When resolving', () => {
      it('Then throws CONFIG_MISSING_VALUE for merge.mydriver.name at its line', async () => {
        // Arrange — driver valued at line 2; name valueless at line 3.
        const ctx = createMemoryContext();
        await seed(ctx, '* merge=mydriver\n', '[merge "mydriver"]\n\tdriver = mycmd\n\tname\n');

        // Act
        const sut = await chooseData(ctx, 'a.txt');

        // Assert
        expect(sut.code).toBe('CONFIG_MISSING_VALUE');
        expect(sut.key).toBe('merge.mydriver.name');
        expect(sut.line).toBe(3);
      });
    });
  });

  describe('Given both driver and name valueless with driver earlier', () => {
    describe('When resolving', () => {
      it('Then reports the earlier-by-line key merge.mydriver.driver', async () => {
        // Arrange — driver valueless at line 2, name valueless at line 3.
        const ctx = createMemoryContext();
        await seed(ctx, '* merge=mydriver\n', '[merge "mydriver"]\n\tdriver\n\tname\n');

        // Act
        const sut = await chooseData(ctx, 'a.txt');

        // Assert
        expect(sut.code).toBe('CONFIG_MISSING_VALUE');
        expect(sut.key).toBe('merge.mydriver.driver');
        expect(sut.line).toBe(2);
      });
    });
  });

  describe('Given both driver and name valueless with name earlier', () => {
    describe('When resolving', () => {
      it('Then reports the earlier-by-line key merge.mydriver.name', async () => {
        // Arrange — name valueless at line 2, driver valueless at line 3.
        const ctx = createMemoryContext();
        await seed(ctx, '* merge=mydriver\n', '[merge "mydriver"]\n\tname\n\tdriver\n');

        // Act
        const sut = await chooseData(ctx, 'a.txt');

        // Assert
        expect(sut.code).toBe('CONFIG_MISSING_VALUE');
        expect(sut.key).toBe('merge.mydriver.name');
        expect(sut.line).toBe(2);
      });
    });
  });

  describe('Given merge=mydriver with no matching config section', () => {
    describe('When resolving', () => {
      it('Then it falls back to the text driver and does not throw', async () => {
        // Arrange — driver selected but no [merge "mydriver"] section.
        const ctx = createMemoryContext();
        await seed(ctx, '* merge=mydriver\n');

        // Act
        const sut = await choose(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ kind: 'text' });
      });
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
        const sut = await choose(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ kind: 'external', command: 'mycmd', name: 'My Driver' });
      });
    });
  });

  describe('Given merge=text built-in name with a valueless driver under a same-named section', () => {
    describe('When resolving', () => {
      it('Then the built-in text driver is chosen without consulting config', async () => {
        // Arrange — built-in name returns before the guard, so the valueless
        // [merge "text"] section is never read.
        const ctx = createMemoryContext();
        await seed(ctx, '* merge=text\n', '[merge "text"]\n\tdriver\n');

        // Act
        const sut = await choose(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ kind: 'text' });
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
