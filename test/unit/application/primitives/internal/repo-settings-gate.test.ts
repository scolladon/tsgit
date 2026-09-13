import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { invalidateConfigCache } from '../../../../../src/application/primitives/config-read.js';
import {
  assertRepoSettingsValid,
  repoSettingsVerdictSettled,
} from '../../../../../src/application/primitives/internal/repo-settings-gate.js';
import { assertOperationalRepository } from '../../../../../src/application/primitives/internal/repo-state.js';
import { TsgitError } from '../../../../../src/domain/error.js';
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
}

describe('internal/repo-settings-gate', () => {
  describe('assertRepoSettingsValid', () => {
    describe('Given core.maxTreeDepth = 2.5', () => {
      describe('When called', () => {
        it('Then throws CONFIG_BAD_NUMERIC_VALUE with reason invalid unit', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2.5\n');

          // Act
          let caught: unknown;
          try {
            await assertRepoSettingsValid(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert — the whole payload, each field individually (mutation-resistant)
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.maxtreedepth');
          expect(data.value).toBe('2.5');
          expect(data.reason).toBe('invalid unit');
        });
      });
    });

    describe('Given core.maxTreeDepth = 2147483648 (past the C int ceiling)', () => {
      describe('When called', () => {
        it('Then throws CONFIG_BAD_NUMERIC_VALUE with reason out of range', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2147483648\n');

          // Act
          let caught: unknown;
          try {
            await assertRepoSettingsValid(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.maxtreedepth');
          expect(data.value).toBe('2147483648');
          expect(data.reason).toBe('out of range');
        });
      });
    });

    describe('Given a config with no [core] maxTreeDepth entry', () => {
      describe('When called', () => {
        it('Then resolves without throwing', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tbare = false\n');

          // Act + Assert — must not throw
          await assertRepoSettingsValid(ctx);
        });
      });
    });

    describe('Given maxTreeDepth = 2.5 on line 2 then maxTreeDepth = 2048 on line 3 (invalid-then-valid)', () => {
      describe('When called', () => {
        it('Then resolves without throwing (the effective last-wins value reaches the gate)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2.5\n\tmaxTreeDepth = 2048\n');

          // Act + Assert — must not throw
          await assertRepoSettingsValid(ctx);
        });
      });
    });

    describe('Given maxTreeDepth = 2048 on line 2 then maxTreeDepth = 2.5 on line 3 (valid-then-invalid)', () => {
      describe('When called', () => {
        it('Then throws CONFIG_BAD_NUMERIC_VALUE (the effective last-wins value reaches the gate)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2048\n\tmaxTreeDepth = 2.5\n');

          // Act
          let caught: unknown;
          try {
            await assertRepoSettingsValid(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.maxtreedepth');
          expect(data.value).toBe('2.5');
        });
      });
    });

    describe('Given two synchronous, back-to-back calls before either settles', () => {
      describe('When called', () => {
        it('Then both return the identical promise (single-flight)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tbare = false\n');

          // Act
          const first = assertRepoSettingsValid(ctx);
          const second = assertRepoSettingsValid(ctx);

          // Assert
          expect(second).toBe(first);
          await first;
        });
      });
    });

    describe('Given a rejected call whose config is then fixed and invalidated', () => {
      describe('When assertRepoSettingsValid is called again', () => {
        it('Then a rejection is never cached — the second call re-runs and resolves', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2.5\n');
          await expect(assertRepoSettingsValid(ctx)).rejects.toBeInstanceOf(TsgitError);

          // Act
          await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2048\n');
          invalidateConfigCache(ctx);

          // Assert — must not throw and must not still be the stale rejection
          await assertRepoSettingsValid(ctx);
        });
      });
    });

    describe('Given a resolved session whose file is rewritten to a malformed value, then the operational gate runs again', () => {
      describe('When assertRepoSettingsValid is called again (no invalidateConfigCache call)', () => {
        it('Then the gate itself passes but the next boundary touch refuses — the epoch re-keyed the memo', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tbare = false\n');
          await assertRepoSettingsValid(ctx);

          // Act — external rewrite, then the next command's own operational gate
          await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2.5\n');
          const root = await assertOperationalRepository(ctx);

          // Assert — the eager gate does not validate this class, so it passes …
          expect(root).toBe(ctx.layout.workDir);
          // … but the first boundary touch after it must refuse.
          let caught: unknown;
          try {
            await assertRepoSettingsValid(ctx);
          } catch (err) {
            caught = err;
          }
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.maxtreedepth');
        });
      });
    });
  });

  describe('assertRepoSettingsValid — core.deltaBaseCacheLimit joins the class', () => {
    describe('Given core.deltaBaseCacheLimit = -1', () => {
      describe('When called', () => {
        it('Then throws CONFIG_BAD_NUMERIC_VALUE naming core.deltabasecachelimit', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tdeltaBaseCacheLimit = -1\n');

          // Act
          let caught: unknown;
          try {
            await assertRepoSettingsValid(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.deltabasecachelimit');
          expect(data.value).toBe('-1');
          expect(data.reason).toBe('invalid unit');
        });
      });
    });

    describe('Given BOTH core.maxTreeDepth and core.deltaBaseCacheLimit are malformed', () => {
      describe('When called', () => {
        it('Then names core.maxtreedepth — the in-function reading order (repo-settings.c:103 before :142)', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tdeltaBaseCacheLimit = -1\n\tmaxTreeDepth = 2.5\n');

          // Act
          let caught: unknown;
          try {
            await assertRepoSettingsValid(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.key).toBe('core.maxtreedepth');
        });
      });
    });

    describe('Given a malformed core.deltaBaseCacheLimit AND an explicit cacheBudgets.deltaBaseCacheMaxBytes option', () => {
      describe('When called', () => {
        it('Then resolves — an option-overridden file value is never validated', async () => {
          // Arrange
          const base = createMemoryContext();
          await seedRepo(base);
          await seedConfig(base, '[core]\n\tdeltaBaseCacheLimit = -1\n');
          const ctx: Context = { ...base, cacheBudgets: { deltaBaseCacheMaxBytes: 2048 } };

          // Act + Assert — must not throw
          await assertRepoSettingsValid(ctx);
        });
      });
    });

    describe('Given the same malformed core.deltaBaseCacheLimit WITHOUT the option', () => {
      describe('When called', () => {
        it('Then throws — the file value is read and validated when nothing overrides it', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tdeltaBaseCacheLimit = -1\n');

          // Act
          let caught: unknown;
          try {
            await assertRepoSettingsValid(ctx);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          const data = (caught as TsgitError).data as BadNumericData;
          expect(data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
          expect(data.key).toBe('core.deltabasecachelimit');
        });
      });
    });
  });

  describe('repoSettingsVerdictSettled', () => {
    describe('Given a fresh session that has never called assertRepoSettingsValid', () => {
      describe('When checked', () => {
        it('Then reports false', async () => {
          // Arrange
          const ctx = createMemoryContext();

          // Act
          const result = repoSettingsVerdictSettled(ctx);

          // Assert
          expect(result).toBe(false);
        });
      });
    });

    describe('Given assertRepoSettingsValid has resolved for this session', () => {
      describe('When checked', () => {
        it('Then reports true', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tbare = false\n');
          await assertRepoSettingsValid(ctx);

          // Act
          const result = repoSettingsVerdictSettled(ctx);

          // Assert
          expect(result).toBe(true);
        });
      });
    });

    describe('Given a settled session whose cache is then invalidated', () => {
      describe('When checked', () => {
        it('Then reports false again', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tbare = false\n');
          await assertRepoSettingsValid(ctx);

          // Act
          invalidateConfigCache(ctx);

          // Assert
          expect(repoSettingsVerdictSettled(ctx)).toBe(false);
        });
      });
    });

    describe('Given assertRepoSettingsValid has rejected for this session', () => {
      describe('When checked', () => {
        it('Then reports false — a rejection never settles', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedConfig(ctx, '[core]\n\tmaxTreeDepth = 2.5\n');
          await expect(assertRepoSettingsValid(ctx)).rejects.toBeInstanceOf(TsgitError);

          // Act
          const result = repoSettingsVerdictSettled(ctx);

          // Assert
          expect(result).toBe(false);
        });
      });
    });
  });
});
