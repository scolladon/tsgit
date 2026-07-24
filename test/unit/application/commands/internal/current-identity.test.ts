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

  describe('Given a config that leaves the identity incomplete without a missing-value error', () => {
    describe('When resolveCurrentIdentity', () => {
      it.each([
        {
          configBody: undefined,
          label: 'no [user] configuration at all throws AUTHOR_UNCONFIGURED',
        },
        {
          configBody: '[user]\n\tname = Ada\n\tsigningkey = KEY\n',
          label:
            'a valued user.name and a signingKey but no user.email throws AUTHOR_UNCONFIGURED (a name without an email is not a complete identity)',
        },
        {
          configBody: '[user]\n\temail = a@x\n\tsigningkey = KEY\n',
          label:
            'a valued user.email and a signingKey but no user.name throws AUTHOR_UNCONFIGURED (an email without a name is not a complete identity)',
        },
      ])('Then $label', async ({ configBody }) => {
        // Arrange
        const ctx = await seed();
        if (configBody !== undefined) {
          await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, configBody);
          __resetConfigCacheForTests();
        }

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

  describe('Given a config with a valueless user.name or user.email', () => {
    describe('When resolveCurrentIdentity', () => {
      it.each([
        {
          configBody: '[user]\n\tname\n\temail = a@x\n',
          expectedKey: 'user.name',
          expectedLine: 2,
          label: 'valueless user.name and valued user.email throws for user.name at line 2',
        },
        {
          configBody: '[user]\n\tname = Ada\n\temail\n',
          expectedKey: 'user.email',
          expectedLine: 3,
          label: 'valued user.name and valueless user.email throws for user.email at line 3',
        },
        {
          configBody: '[user]\n\tname\n\temail\n',
          expectedKey: 'user.name',
          expectedLine: 2,
          label:
            'both valueless, name earlier, throws for user.name at line 2 (file-position order)',
        },
        {
          configBody: '[user]\n\temail\n\tname\n',
          expectedKey: 'user.email',
          expectedLine: 2,
          label:
            'both valueless, email earlier, throws for user.email at line 2 (file-position order)',
        },
        {
          configBody: '[user]\n\tname = Ada\n\temail\n\tsigningkey = KEY\n',
          expectedKey: 'user.email',
          expectedLine: 3,
          label:
            'a valued user.name, valueless user.email, and a signingKey throws for user.email at line 3',
        },
        {
          configBody: '[user]\n\tname\n\temail = a@x\n\tsigningkey = KEY\n',
          expectedKey: 'user.name',
          expectedLine: 2,
          label:
            'a valueless user.name, valued user.email, and a signingKey throws for user.name at line 2',
        },
        {
          configBody: '[user]\n\tname\n\tname = Ada\n\temail = a@x\n',
          expectedKey: 'user.name',
          expectedLine: 2,
          label:
            'a valueless user.name preceding a valued user.name and a valued user.email throws for user.name (git dies before the valued override)',
        },
        {
          configBody: '[user]\n\tname = Ada\n\tname\n\temail = a@x\n',
          expectedKey: 'user.name',
          expectedLine: 3,
          label:
            'a valued user.name followed by a valueless user.name and a valued user.email throws for user.name at the valueless line (a valued value does not mask it)',
        },
        {
          configBody: '[user]\n\tname = Ada\n\temail = a@x\n\temail\n',
          expectedKey: 'user.email',
          expectedLine: 4,
          label:
            'a valued user.name, a valued user.email, and a trailing valueless user.email throws for user.email at the valueless line (a valued value does not mask it)',
        },
      ])('Then $label', async ({ configBody, expectedKey, expectedLine }) => {
        // Arrange
        const ctx = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, configBody);
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
        expect((caught.data as { key: string }).key).toBe(expectedKey);
        expect((caught.data as { line: number }).line).toBe(expectedLine);
        expect((caught.data as { source: string }).source).toMatch(/\/config$/);
      });
    });
  });
});
