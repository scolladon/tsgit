import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  assertOperationalRepository,
  assertOperationalRepositorySettingsFirst,
  assertWorktreeCoreBooleansValid,
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

describe('assertWorktreeCoreBooleansValid', () => {
  describe('Given the extension on and a bad sparseCheckout in config.worktree', () => {
    describe('When the check runs', () => {
      it('Then it refuses naming the key, the value and the worktree file', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        await seedWorktreeConfig(ctx, '[core]\n\tsparseCheckout = bogus\n');
        const sut = assertWorktreeCoreBooleansValid;

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
        const sut = assertWorktreeCoreBooleansValid;

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
        const sut = assertWorktreeCoreBooleansValid;

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
        const sut = assertWorktreeCoreBooleansValid;

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
    ['a bad ignoreCase, which the worktree gate does not check', '[core]\n\tignoreCase = bogus\n'],
    ['a bad value in another section', '[other]\n\tsparseCheckout = bogus\n'],
    ['valid sparse booleans', '[core]\n\tsparseCheckout = true\n\tsparseCheckoutCone = no\n'],
  ])('Given %s in config.worktree', (_label, text) => {
    describe('When the check runs', () => {
      it('Then it resolves', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        await seedWorktreeConfig(ctx, text);
        const sut = assertWorktreeCoreBooleansValid;

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
        const sut = assertWorktreeCoreBooleansValid;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given the extension on and a bad fileMode in config.worktree', () => {
    describe('When the check runs', () => {
      it('Then it refuses naming core.filemode, the value and the worktree file', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        await seedWorktreeConfig(ctx, '[core]\n\tfileMode = bogus\n');
        const sut = assertWorktreeCoreBooleansValid;

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toMatchObject(badBoolean(ctx, 'core.filemode', 'bogus'));
      });
    });

    describe('When assertOperationalRepository runs', () => {
      it('Then it refuses naming core.filemode', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        await seedWorktreeConfig(ctx, '[core]\n\tfileMode = bogus\n');
        const sut = assertOperationalRepository;

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toMatchObject(badBoolean(ctx, 'core.filemode', 'bogus'));
      });
    });
  });

  describe('Given the extension on and a bad trustCtime in config.worktree', () => {
    describe('When the check runs', () => {
      it('Then it refuses naming core.trustctime, the value and the worktree file', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        await seedWorktreeConfig(ctx, '[core]\n\ttrustCtime = bogus\n');
        const sut = assertWorktreeCoreBooleansValid;

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toMatchObject(badBoolean(ctx, 'core.trustctime', 'bogus'));
      });
    });
  });

  describe.each([
    ['bogus', '\tcheckStat = bogus\n', 'CONFIG_INVALID_ENUM_VALUE', 'bogus'],
    ['empty', '\tcheckStat =\n', 'CONFIG_INVALID_ENUM_VALUE', ''],
  ])(
    'Given the extension on and a %s checkStat in config.worktree',
    (_label, line, code, value) => {
      describe('When the check runs', () => {
        it('Then it refuses naming core.checkstat, the value, the file and the line', async () => {
          // Arrange
          const ctx = createMemoryContext();
          await seedRepo(ctx);
          await seedWorktreeConfig(ctx, `[core]\n${line}`);
          const sut = assertWorktreeCoreBooleansValid;

          // Act
          const result = await refusalOf(() => sut(ctx));

          // Assert
          expect(result).toMatchObject({
            code,
            key: 'core.checkstat',
            value,
            source: `${ctx.layout.gitDir}/config.worktree`,
            line: 2,
          });
        });
      });
    },
  );

  describe('Given the extension on and a valueless checkStat in config.worktree', () => {
    describe('When the check runs', () => {
      it('Then it refuses with CONFIG_MISSING_VALUE naming the file and the line', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        await seedWorktreeConfig(ctx, '[core]\n\tcheckStat\n');
        const sut = assertWorktreeCoreBooleansValid;

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toMatchObject({
          code: 'CONFIG_MISSING_VALUE',
          key: 'core.checkstat',
          source: `${ctx.layout.gitDir}/config.worktree`,
          line: 2,
        });
      });
    });
  });

  describe('Given a bad checkStat on line 3 and a bad trustCtime on line 2 in config.worktree', () => {
    describe('When the check runs', () => {
      it('Then the lower line is the one refused', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        await seedWorktreeConfig(ctx, '[core]\n\ttrustCtime = bogus\n\tcheckStat = bogus\n');
        const sut = assertWorktreeCoreBooleansValid;

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toMatchObject(badBoolean(ctx, 'core.trustctime', 'bogus'));
      });
    });
  });

  describe.each([
    ['Minimal', '\tcheckStat = Minimal\n'],
    ['valueless trustCtime', '\ttrustCtime\n'],
    ['false trustCtime', '\ttrustCtime = false\n'],
  ])('Given the extension on and %s in config.worktree', (_label, line) => {
    describe('When the check runs', () => {
      it('Then it resolves', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        await seedWorktreeConfig(ctx, `[core]\n${line}`);
        const sut = assertWorktreeCoreBooleansValid;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given the extension off and a bad checkStat in config.worktree', () => {
    describe('When the check runs', () => {
      it('Then it resolves', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, '[core]\n\tbare = false\n');
        await seedWorktreeConfig(ctx, '[core]\n\tcheckStat = bogus\n');
        const sut = assertWorktreeCoreBooleansValid;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given the extension off and a bad fileMode in config.worktree', () => {
    describe('When the check runs', () => {
      it('Then it resolves', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, '[core]\n\tbare = false\n');
        await seedWorktreeConfig(ctx, '[core]\n\tfileMode = bogus\n');
        const sut = assertWorktreeCoreBooleansValid;

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
        const sut = assertWorktreeCoreBooleansValid;

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
        const sut = assertWorktreeCoreBooleansValid;

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

describe('assertOperationalRepository sparse.expectFilesOutsideOfPatterns', () => {
  const sparseBogus = '[sparse]\n\texpectFilesOutsideOfPatterns = bogus\n';

  describe('Given a bogus local sparse.expectFilesOutsideOfPatterns', () => {
    describe('When the gate runs', () => {
      it('Then it refuses naming the key, the value and the local file', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, sparseBogus);
        const sut = assertOperationalRepository;

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toMatchObject({
          code: 'CONFIG_BAD_BOOLEAN_VALUE',
          key: 'sparse.expectfilesoutsideofpatterns',
          value: 'bogus',
          source: `${ctx.layout.gitDir}/config`,
        });
      });
    });
  });

  describe('Given the sparse key on line 2 before a bad core.fileMode on line 4', () => {
    describe('When the gate runs', () => {
      it('Then the sparse key is named', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, `${sparseBogus}[core]\n\tfileMode = bogus\n`);
        const sut = assertOperationalRepository;

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toMatchObject({ key: 'sparse.expectfilesoutsideofpatterns' });
      });
    });
  });

  describe('Given a bad core.fileMode before the sparse key', () => {
    describe('When the gate runs', () => {
      it('Then core.filemode is named', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, `[core]\n\tfileMode = bogus\n${sparseBogus}`);
        const sut = assertOperationalRepository;

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toMatchObject({ key: 'core.filemode' });
      });
    });
  });

  describe('Given core.sparseCheckout absent and a bogus sparse key', () => {
    describe('When the gate runs', () => {
      it('Then it still refuses', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, `[core]\n\tbare = false\n${sparseBogus}`);
        const sut = assertOperationalRepository;

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toMatchObject({ code: 'CONFIG_BAD_BOOLEAN_VALUE' });
      });
    });
  });

  describe('Given the extension on and the bogus value only in config.worktree', () => {
    describe('When the gate runs', () => {
      it('Then it refuses with the worktree source', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx);
        await seedWorktreeConfig(ctx, sparseBogus);
        const sut = assertOperationalRepository;

        // Act
        const result = await refusalOf(() => sut(ctx));

        // Assert
        expect(result).toMatchObject(
          badBoolean(ctx, 'sparse.expectfilesoutsideofpatterns', 'bogus'),
        );
      });
    });
  });

  describe('Given the extension off and the bogus value only in config.worktree', () => {
    describe('When the gate runs', () => {
      it('Then it resolves', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, '[core]\n\tbare = false\n');
        await seedWorktreeConfig(ctx, sparseBogus);
        const sut = assertOperationalRepository;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(typeof result).toBe('string');
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
