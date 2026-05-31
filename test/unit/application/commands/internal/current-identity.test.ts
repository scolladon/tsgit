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

        // Assert
        expect(caught?.data.code).toBe('AUTHOR_UNCONFIGURED');
      });
    });
  });
});
