import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { buildAttributeProvider } from '../../../../src/application/primitives/internal/read-gitattributes.js';
import { resolveMergeDriver } from '../../../../src/application/primitives/resolve-merge-driver.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../src/ports/context.js';

const choose = async (ctx: Context, path: string) => {
  const provider = await buildAttributeProvider(ctx);
  return resolveMergeDriver(ctx, provider, path as FilePath);
};

const seed = (ctx: Context, attrs?: string, config?: string): Promise<void[]> =>
  Promise.all([
    attrs === undefined
      ? Promise.resolve()
      : ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, attrs),
    config === undefined
      ? Promise.resolve()
      : ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config),
  ]);

describe('resolveMergeDriver', () => {
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

  describe('Given merge=union (deferred built-in)', () => {
    describe('When resolving', () => {
      it('Then it falls back to the text driver', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '* merge=union\n');

        // Act
        const sut = await choose(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ kind: 'text' });
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
