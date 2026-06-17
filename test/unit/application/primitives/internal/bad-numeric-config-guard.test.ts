import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { assertNoBadNumericConfig } from '../../../../../src/application/primitives/internal/bad-numeric-config-guard.js';
import { TsgitError } from '../../../../../src/domain/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const seedRepo = async (ctx: Context, head = 'ref: refs/heads/main\n'): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, head);
};

const seedConfig = async (ctx: Context, config: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
};

interface BadNumericData {
  readonly code: string;
  readonly key: string;
  readonly value: string;
  readonly reason: string;
  readonly source: string;
}

describe('internal/bad-numeric-config-guard', () => {
  describe('assertNoBadNumericConfig', () => {
    describe('Given a valueless core.loosecompression entry', () => {
      describe('When assertNoBadNumericConfig is called for the core int keys', () => {
        it('Then throws CONFIG_BAD_NUMERIC_VALUE with key, empty value, and invalid unit reason', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tloosecompression\n');

          // Act
          let caught: unknown;
          try {
            await assertNoBadNumericConfig(ctx, 'core', undefined, [
              'loosecompression',
              'compression',
            ]);
          } catch (err) {
            caught = err;
          }

          // Assert — each field individually (mutation-resistant)
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.loosecompression');
          expect(data.value).toBe('');
          expect(data.reason).toBe('invalid unit');
          expect(data.source).toMatch(/\/config$/);
        });
      });
    });

    describe('Given a valueless core.compression entry', () => {
      describe('When assertNoBadNumericConfig is called for the core int keys', () => {
        it('Then throws CONFIG_BAD_NUMERIC_VALUE for core.compression', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tcompression\n');

          // Act
          let caught: unknown;
          try {
            await assertNoBadNumericConfig(ctx, 'core', undefined, [
              'loosecompression',
              'compression',
            ]);
          } catch (err) {
            caught = err;
          }

          // Assert — each field individually (mutation-resistant)
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.compression');
          expect(data.value).toBe('');
          expect(data.reason).toBe('invalid unit');
          expect(data.source).toMatch(/\/config$/);
        });
      });
    });

    describe('Given a valued core.loosecompression entry', () => {
      describe('When assertNoBadNumericConfig is called', () => {
        it('Then resolves without throw (valued entry is not refused)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tloosecompression = 9\n');

          // Act + Assert — must not throw
          await assertNoBadNumericConfig(ctx, 'core', undefined, [
            'loosecompression',
            'compression',
          ]);
        });
      });
    });

    describe('Given no core int keys in config', () => {
      describe('When assertNoBadNumericConfig is called', () => {
        it('Then resolves without throw (absent keys are not refused)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\trepositoryformatversion = 0\n');

          // Act + Assert — must not throw
          await assertNoBadNumericConfig(ctx, 'core', undefined, [
            'loosecompression',
            'compression',
          ]);
        });
      });
    });
  });
});
