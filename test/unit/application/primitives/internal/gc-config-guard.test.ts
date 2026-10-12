import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  assertValidLeadingGcConfig,
  assertValidTrailingGcConfig,
  readGcExpiryCutoff,
} from '../../../../../src/application/primitives/internal/gc-config-guard.js';
import { TsgitError } from '../../../../../src/domain/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const seedConfig = async (ctx: Context, config: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
};

const captureError = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('readGcExpiryCutoff', () => {
  describe('Given the key is absent', () => {
    describe('When called with a fallback', () => {
      it('Then resolves the fallback, as git applies its default', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[core]\n\tbare = false\n');
        const sut = readGcExpiryCutoff;

        // Act
        const result = await sut(ctx, 'pruneExpire', 'now');

        // Assert
        expect(result).toBe(Number.POSITIVE_INFINITY);
      });
    });
  });

  describe('Given a valid entry followed by a valueless one', () => {
    describe('When called', () => {
      it('Then refuses the last entry as a missing value at its line', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[gc]\n\tpruneExpire = now\n\tPRUNEEXPIRE\n');
        const sut = readGcExpiryCutoff;

        // Act
        const caught = await captureError(() => sut(ctx, 'pruneExpire', 'now'));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'CONFIG_MISSING_VALUE',
          key: 'gc.pruneexpire',
          source: `${ctx.layout.gitDir}/config`,
          line: 3,
        });
      });
    });
  });

  describe('Given a valueless entry under a later [gc "<sub>"] or another section', () => {
    describe('When called', () => {
      it('Then ignores it, as git reads only the subsectionless key', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(
          ctx,
          '[gc]\n\tpruneExpire = now\n[gc "x"]\n\tpruneExpire\n[core]\n\tpruneExpire\n',
        );
        const sut = readGcExpiryCutoff;

        // Act
        const result = await sut(ctx, 'pruneExpire', '2.weeks.ago');

        // Assert
        expect(result).toBe(Number.POSITIVE_INFINITY);
      });
    });
  });
});

describe('assertValidLeadingGcConfig', () => {
  describe.each([
    { config: 'autoPackLimit = 2147483648', value: '2147483648', reason: 'out of range' },
    { config: 'autoPackLimit', value: '', reason: 'invalid unit' },
  ])('Given [gc] $config', ({ config, value, reason }) => {
    describe('When called', () => {
      it('Then refuses it as git_config_int does', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, `[gc]\n\t${config}\n`);
        const sut = assertValidLeadingGcConfig;

        // Act
        const caught = await captureError(() => sut(ctx));

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'CONFIG_BAD_NUMERIC_VALUE',
          key: 'gc.autopacklimit',
          source: `${ctx.layout.gitDir}/config`,
          value,
          reason,
        });
      });
    });
  });

  describe('Given [gc] cruftPacks = true followed by cruftPacks = maybe', () => {
    describe('When called', () => {
      it('Then refuses the last entry with its value', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[gc]\n\tcruftPacks = true\n\tcruftPacks = maybe\n');
        const sut = assertValidLeadingGcConfig;

        // Act
        const caught = await captureError(() => sut(ctx));

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'CONFIG_BAD_BOOLEAN_VALUE',
          key: 'gc.cruftpacks',
          source: `${ctx.layout.gitDir}/config`,
          value: 'maybe',
        });
      });
    });
  });

  describe('Given [gc] autoPackLimit = -2147483648 and a valueless cruftPacks', () => {
    describe('When called', () => {
      it('Then accepts both, as git does', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[gc]\n\tautoPackLimit = -2147483648\n\tcruftPacks\n');
        const sut = assertValidLeadingGcConfig;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});

describe('assertValidTrailingGcConfig', () => {
  describe.each([
    { config: 'bigPackThreshold = -0', value: '-0', reason: 'invalid unit' },
    { config: 'bigPackThreshold', value: '', reason: 'invalid unit' },
    {
      config: 'bigPackThreshold = 18446744073709551616',
      value: '18446744073709551616',
      reason: 'out of range',
    },
  ])('Given [gc] $config', ({ config, value, reason }) => {
    describe('When called', () => {
      it('Then refuses it as git_config_ulong does', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, `[gc]\n\t${config}\n`);
        const sut = assertValidTrailingGcConfig;

        // Act
        const caught = await captureError(() => sut(ctx));

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'CONFIG_BAD_NUMERIC_VALUE',
          key: 'gc.bigpackthreshold',
          source: `${ctx.layout.gitDir}/config`,
          value,
          reason,
        });
      });
    });
  });

  describe('Given [gc] bigPackThreshold = 18446744073709551615 and logExpiry = now', () => {
    describe('When called', () => {
      it('Then accepts both, as git does', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(
          ctx,
          '[gc]\n\tbigPackThreshold = 18446744073709551615\n\tlogExpiry = now\n',
        );
        const sut = assertValidTrailingGcConfig;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given [gc] logExpiry = all', () => {
    describe('When called', () => {
      it('Then refuses it as an expiry that is not before now', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[gc]\n\tlogExpiry = all\n');
        const sut = assertValidTrailingGcConfig;

        // Act
        const caught = await captureError(() => sut(ctx));

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'CONFIG_BAD_DATE_VALUE',
          value: 'all',
        });
      });
    });
  });
});
