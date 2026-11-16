import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  assertOperationalRepository,
  assertOperationalRepositorySettingsFirst,
  assertWorktreeSparseBooleansValid,
} from '../../../../../src/application/primitives/internal/repo-state.js';
import type { Context } from '../../../../../src/ports/context.js';
import { instrumentedContext } from '../fixtures.js';

const EXTENSION_ON = '[extensions]\n\tworktreeConfig = true\n';

const seedRepo = async (ctx: Context, config = EXTENSION_ON): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
};

const seedWorktreeConfig = async (ctx: Context, text: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config.worktree`, text);
};

const refusalOf = async (action: () => Promise<unknown>): Promise<Record<string, unknown>> => {
  try {
    await action();
  } catch (error) {
    return (error as { readonly data: Record<string, unknown> }).data;
  }
  throw new Error('expected a refusal');
};

const badBoolean = (ctx: Context, key: string, value: string): Record<string, unknown> => ({
  code: 'CONFIG_BAD_BOOLEAN_VALUE',
  key,
  source: `${ctx.layout.gitDir}/config.worktree`,
  value,
});

describe('assertWorktreeSparseBooleansValid', () => {
  describe('Given the extension on and a bad sparseCheckout in config.worktree', () => {
    describe('When the check runs', () => {
      it('Then it refuses naming the key, the value and the worktree file', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        await seedWorktreeConfig(ctx, '[core]\n\tsparseCheckout = bogus\n');
        const sut = assertWorktreeSparseBooleansValid;

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toMatchObject(badBoolean(ctx, 'core.sparsecheckout', 'bogus'));
      });
    });
  });

  describe('Given a bad sparseCheckoutCone alone', () => {
    describe('When the check runs', () => {
      it('Then it refuses naming the cone key', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        await seedWorktreeConfig(ctx, '[core]\n\tsparseCheckoutCone = bogus\n');
        const sut = assertWorktreeSparseBooleansValid;

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toMatchObject(badBoolean(ctx, 'core.sparsecheckoutcone', 'bogus'));
      });
    });
  });

  describe('Given both sparse keys bad', () => {
    describe('When the check runs', () => {
      it('Then the first in file order is named', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        await seedWorktreeConfig(
          ctx,
          '[core]\n\tsparseCheckoutCone = first\n\tsparseCheckout = second\n',
        );
        const sut = assertWorktreeSparseBooleansValid;

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toMatchObject(badBoolean(ctx, 'core.sparsecheckoutcone', 'first'));
      });
    });
  });

  describe('Given upper-case section and key names', () => {
    describe('When the check runs', () => {
      it('Then it refuses with the lowercased key', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        await seedWorktreeConfig(ctx, '[CORE]\n\tSPARSECHECKOUT = bogus\n');
        const sut = assertWorktreeSparseBooleansValid;

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toMatchObject(badBoolean(ctx, 'core.sparsecheckout', 'bogus'));
      });
    });
  });

  describe.each([
    ['a valueless sparseCheckout', '[core]\n\tsparseCheckout\n'],
    ['a bad value under a subsectioned [core "x"]', '[core "x"]\n\tsparseCheckout = bogus\n'],
    ['a bad ignoreCase, which is not a sparse key', '[core]\n\tignoreCase = bogus\n'],
    ['a bad value in another section', '[other]\n\tsparseCheckout = bogus\n'],
    ['valid sparse booleans', '[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = no\n'],
  ])('Given %s in config.worktree', (_label, text) => {
    describe('When the check runs', () => {
      it('Then it resolves', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        await seedWorktreeConfig(ctx, text);
        const sut = assertWorktreeSparseBooleansValid;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given the extension off and a bad value in config.worktree', () => {
    describe('When the check runs', () => {
      it('Then it resolves', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, '[core]\n\tbare = false\n');
        await seedWorktreeConfig(ctx, '[core]\n\tsparseCheckout = bogus\n');
        const sut = assertWorktreeSparseBooleansValid;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a refused layout and a bad value in config.worktree', () => {
    describe('When the check runs', () => {
      it('Then it resolves without reading config.worktree', async () => {
        // Arrange
        const base = createMemoryContext();
        await seedRepo(base);
        await seedWorktreeConfig(base, '[core]\n\tsparseCheckout = bogus\n');
        const { ctx, calls } = instrumentedContext({
          ...base,
          layout: { ...base.layout, formatRefusal: { kind: 'version', version: 99 } },
        });
        const sut = assertWorktreeSparseBooleansValid;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBeUndefined();
        expect(calls().filter((c) => c.path.endsWith('/config.worktree'))).toEqual([]);
      });
    });
  });

  describe('Given a linked worktree context with the bad value only in its own file', () => {
    describe('When the check runs on the linked and the main context', () => {
      it('Then only the linked one refuses', async () => {
        // Arrange
        const main = createMemoryContext();
        await seedRepo(main);
        const linkedDir = `${main.layout.gitDir}/worktrees/wt`;
        const linked: Context = {
          ...main,
          layout: { ...main.layout, gitDir: linkedDir, commonDir: main.layout.gitDir },
        };
        await seedWorktreeConfig(linked, '[core]\n\tsparseCheckout = bogus\n');
        const sut = assertWorktreeSparseBooleansValid;

        // Act
        const mainResult = await sut(main);
        const linkedResult = await refusalOf(() => sut(linked));

        // Assert
        expect(mainResult).toBeUndefined();
        expect(linkedResult).toMatchObject(badBoolean(linked, 'core.sparsecheckout', 'bogus'));
      });
    });
  });
});

describe('assertOperationalRepository', () => {
  describe('Given a settled verdict and config.worktree then rewritten to a bad value', () => {
    describe('When the gate runs again in the same session', () => {
      it('Then it refuses on the worktree file', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        const sut = assertOperationalRepository;
        await sut(ctx);
        await seedWorktreeConfig(ctx, '[core]\n\tsparseCheckout = bogus\n');

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toMatchObject(badBoolean(ctx, 'core.sparsecheckout', 'bogus'));
      });
    });
  });

  describe('Given a settled verdict and config.worktree then rewritten malformed', () => {
    describe('When the gate runs again in the same session', () => {
      it('Then it refuses with a parse error on line 1 of the worktree file', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        const sut = assertOperationalRepository;
        await sut(ctx);
        await seedWorktreeConfig(ctx, '[core\n');

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toMatchObject({
          code: 'CONFIG_PARSE_ERROR',
          line: 1,
          source: `${ctx.layout.gitDir}/config.worktree`,
        });
      });
    });
  });

  describe('Given a bad local value and a bad worktree value', () => {
    describe('When the gate runs', () => {
      it('Then the local one is named', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, `${EXTENSION_ON}[core]\n\tsparseCheckout = local\n`);
        await seedWorktreeConfig(ctx, '[core]\n\tsparseCheckout = worktree\n');
        const sut = assertOperationalRepository;

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toMatchObject({
          code: 'CONFIG_BAD_BOOLEAN_VALUE',
          key: 'core.sparsecheckout',
          source: `${ctx.layout.gitDir}/config`,
          value: 'local',
        });
      });
    });
  });
});

describe('assertOperationalRepositorySettingsFirst', () => {
  describe('Given a bad sparse value in config.worktree', () => {
    describe('When the gate runs', () => {
      it('Then it refuses with the worktree source', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        await seedWorktreeConfig(ctx, '[core]\n\tsparseCheckoutCone = bogus\n');
        const sut = assertOperationalRepositorySettingsFirst;

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toMatchObject(badBoolean(ctx, 'core.sparsecheckoutcone', 'bogus'));
      });
    });
  });
});
