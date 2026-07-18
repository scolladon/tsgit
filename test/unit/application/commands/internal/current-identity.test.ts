import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../../src/application/commands/init.js';
import { resolveCurrentIdentity } from '../../../../../src/application/commands/internal/current-identity.js';
import { __resetConfigCacheForTests } from '../../../../../src/application/primitives/config-read.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { Context } from '../../../../../src/ports/context.js';

const seed = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  __resetConfigCacheForTests();
  return ctx;
};

describe('resolveCurrentIdentity', () => {
  describe('Given `[user]` is configured', () => {
    describe('When resolved', () => {
      it('Then returns the config name/email with a current timestamp', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.appendUtf8(
          `${ctx.layout.gitDir}/config`,
          '\n[user]\n\tname = Ada\n\temail = a@x\n',
        );
        __resetConfigCacheForTests();

        // Act
        const sut = await resolveCurrentIdentity(ctx);

        // Assert
        expect(sut.name).toBe('Ada');
        expect(sut.email).toBe('a@x');
        expect(sut.timezoneOffset).toBe('+0000');
        expect(typeof sut.timestamp).toBe('number');
      });
    });
  });

  describe('Given no `[user]` configuration', () => {
    describe('When resolved', () => {
      it('Then throws AUTHOR_UNCONFIGURED', async () => {
        // Arrange
        const ctx = await seed();

        // Act
        let caught: TsgitError | undefined;
        try {
          await resolveCurrentIdentity(ctx);
        } catch (err) {
          caught = err as TsgitError;
        }

        if (caught === undefined) {
          throw new Error('expected the operation to throw');
        }

        // Assert
        expect(caught.data.code).toBe('AUTHOR_UNCONFIGURED');
        expect(caught.data.code).not.toBe('CONFIG_MISSING_VALUE');
      });
    });
  });

  describe('Given a config with valueless user.name and valued user.email', () => {
    describe('When resolveCurrentIdentity', () => {
      it('Then throws CONFIG_MISSING_VALUE with key user.name at line 2', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[user]\n\tname\n\temail = a@x\n');
        __resetConfigCacheForTests();

        // Act
        let caught: TsgitError | undefined;
        try {
          await resolveCurrentIdentity(ctx);
        } catch (err) {
          caught = err as TsgitError;
        }

        if (caught === undefined) {
          throw new Error('expected the operation to throw');
        }

        // Assert
        expect(caught.data.code).toBe('CONFIG_MISSING_VALUE');
        expect((caught.data as { key: string }).key).toBe('user.name');
        expect((caught.data as { line: number }).line).toBe(2);
        expect((caught.data as { source: string }).source).toMatch(/\/config$/);
      });
    });
  });

  describe('Given a config with valued user.name and valueless user.email', () => {
    describe('When resolveCurrentIdentity', () => {
      it('Then throws CONFIG_MISSING_VALUE with key user.email at line 3', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[user]\n\tname = Ada\n\temail\n');
        __resetConfigCacheForTests();

        // Act
        let caught: TsgitError | undefined;
        try {
          await resolveCurrentIdentity(ctx);
        } catch (err) {
          caught = err as TsgitError;
        }

        if (caught === undefined) {
          throw new Error('expected the operation to throw');
        }

        // Assert
        expect(caught.data.code).toBe('CONFIG_MISSING_VALUE');
        expect((caught.data as { key: string }).key).toBe('user.email');
        expect((caught.data as { line: number }).line).toBe(3);
        expect((caught.data as { source: string }).source).toMatch(/\/config$/);
      });
    });
  });

  describe('Given a config with both valueless, name earlier', () => {
    describe('When resolveCurrentIdentity', () => {
      it('Then throws CONFIG_MISSING_VALUE with key user.name at line 2 (file-position order)', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[user]\n\tname\n\temail\n');
        __resetConfigCacheForTests();

        // Act
        let caught: TsgitError | undefined;
        try {
          await resolveCurrentIdentity(ctx);
        } catch (err) {
          caught = err as TsgitError;
        }

        if (caught === undefined) {
          throw new Error('expected the operation to throw');
        }

        // Assert
        expect(caught.data.code).toBe('CONFIG_MISSING_VALUE');
        expect((caught.data as { key: string }).key).toBe('user.name');
        expect((caught.data as { line: number }).line).toBe(2);
        expect((caught.data as { source: string }).source).toMatch(/\/config$/);
      });
    });
  });

  describe('Given a config with both valueless, email earlier', () => {
    describe('When resolveCurrentIdentity', () => {
      it('Then throws CONFIG_MISSING_VALUE with key user.email at line 2 (file-position order)', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[user]\n\temail\n\tname\n');
        __resetConfigCacheForTests();

        // Act
        let caught: TsgitError | undefined;
        try {
          await resolveCurrentIdentity(ctx);
        } catch (err) {
          caught = err as TsgitError;
        }

        if (caught === undefined) {
          throw new Error('expected the operation to throw');
        }

        // Assert
        expect(caught.data.code).toBe('CONFIG_MISSING_VALUE');
        expect((caught.data as { key: string }).key).toBe('user.email');
        expect((caught.data as { line: number }).line).toBe(2);
        expect((caught.data as { source: string }).source).toMatch(/\/config$/);
      });
    });
  });

  describe('Given a config with valued user.name, valueless user.email, and a signingKey', () => {
    describe('When resolveCurrentIdentity', () => {
      it('Then throws CONFIG_MISSING_VALUE with key user.email at line 3', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[user]\n\tname = Ada\n\temail\n\tsigningkey = KEY\n',
        );
        __resetConfigCacheForTests();

        // Act
        let caught: TsgitError | undefined;
        try {
          await resolveCurrentIdentity(ctx);
        } catch (err) {
          caught = err as TsgitError;
        }

        if (caught === undefined) {
          throw new Error('expected the operation to throw');
        }

        // Assert
        expect(caught.data.code).toBe('CONFIG_MISSING_VALUE');
        expect((caught.data as { key: string }).key).toBe('user.email');
        expect((caught.data as { line: number }).line).toBe(3);
        expect((caught.data as { source: string }).source).toMatch(/\/config$/);
      });
    });
  });

  describe('Given a config with valueless user.name, valued user.email, and a signingKey', () => {
    describe('When resolveCurrentIdentity', () => {
      it('Then throws CONFIG_MISSING_VALUE with key user.name at line 2', async () => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[user]\n\tname\n\temail = a@x\n\tsigningkey = KEY\n',
        );
        __resetConfigCacheForTests();

        // Act
        let caught: TsgitError | undefined;
        try {
          await resolveCurrentIdentity(ctx);
        } catch (err) {
          caught = err as TsgitError;
        }

        if (caught === undefined) {
          throw new Error('expected the operation to throw');
        }

        // Assert
        expect(caught.data.code).toBe('CONFIG_MISSING_VALUE');
        expect((caught.data as { key: string }).key).toBe('user.name');
        expect((caught.data as { line: number }).line).toBe(2);
        expect((caught.data as { source: string }).source).toMatch(/\/config$/);
      });
    });
  });
});
