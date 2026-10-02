import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  assertValidBooleanConfig,
  assertValidBooleanConfigInSection,
  assertValidPromisorRemoteConfig,
} from '../../../../../src/application/primitives/internal/boolean-config-guard.js';
import { TsgitError } from '../../../../../src/domain/index.js';
import type { Context } from '../../../../../src/ports/context.js';

interface BadBooleanData {
  readonly code: string;
  readonly key: string;
  readonly source: string;
  readonly value: string;
}

const seedConfig = async (ctx: Context, config: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
};

describe('assertValidBooleanConfig', () => {
  describe('Given [core] sparseCheckout holds a value git refuses', () => {
    describe('When called', () => {
      it('Then throws CONFIG_BAD_BOOLEAN_VALUE with key/source/value', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[core]\n\tsparseCheckout = maybe\n');

        // Act
        let caught: unknown;
        try {
          await assertValidBooleanConfig(ctx, 'core', undefined, ['sparsecheckout']);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as BadBooleanData;
        expect(data.code).toBe('CONFIG_BAD_BOOLEAN_VALUE');
        expect(data.key).toBe('core.sparsecheckout');
        expect(data.value).toBe('maybe');
        expect(data.source).toMatch(/\/config$/);
      });
    });
  });

  describe('Given [core] sparseCheckout holds a value git accepts', () => {
    describe('When called', () => {
      it('Then resolves (no throw)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[core]\n\tsparseCheckout = true\n');

        // Act + Assert
        await assertValidBooleanConfig(ctx, 'core', undefined, ['sparsecheckout']);
      });
    });
  });

  describe('Given the requested key is absent', () => {
    describe('When called', () => {
      it('Then resolves (no throw)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[core]\n\tbare = true\n');

        // Act + Assert
        await assertValidBooleanConfig(ctx, 'core', undefined, ['sparsecheckout']);
      });
    });
  });

  describe('Given the malformed key sits in a different section', () => {
    describe('When called', () => {
      it('Then resolves (no throw — out of section)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[core]\n\tsparseCheckout = maybe\n');

        // Act + Assert
        await assertValidBooleanConfig(ctx, 'commit', undefined, ['gpgsign']);
      });
    });
  });
});

describe('assertValidBooleanConfigInSection', () => {
  describe('Given [diff "MyDriver"] cachetextconv holds a value git refuses', () => {
    describe('When called', () => {
      it('Then throws CONFIG_BAD_BOOLEAN_VALUE with the subsection-qualified key', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[diff "MyDriver"]\n\tcachetextconv = maybe\n');

        // Act
        let caught: unknown;
        try {
          await assertValidBooleanConfigInSection(ctx, 'diff', ['cachetextconv']);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as BadBooleanData;
        expect(data.code).toBe('CONFIG_BAD_BOOLEAN_VALUE');
        expect(data.key).toBe('diff.MyDriver.cachetextconv');
        expect(data.value).toBe('maybe');
      });
    });
  });

  describe('Given every [diff *] subsection holds a value git accepts', () => {
    describe('When called', () => {
      it('Then resolves (no throw)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[diff "a"]\n\tcachetextconv = true\n');

        // Act + Assert
        await assertValidBooleanConfigInSection(ctx, 'diff', ['cachetextconv']);
      });
    });
  });

  describe('Given the requested key is absent from every [diff *] subsection', () => {
    describe('When called', () => {
      it('Then resolves (no throw)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[diff "a"]\n\ttextconv = maybe\n');

        // Act + Assert
        await assertValidBooleanConfigInSection(ctx, 'diff', ['cachetextconv']);
      });
    });
  });

  describe('Given the malformed key sits under a non-matching section', () => {
    describe('When called', () => {
      it('Then resolves (no throw — out of section)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[other "x"]\n\tcachetextconv = maybe\n');

        // Act + Assert
        await assertValidBooleanConfigInSection(ctx, 'diff', ['cachetextconv']);
      });
    });
  });
});

describe('Given a remote whose partialclonefilter has no value', () => {
  describe('When the promisor config is validated', () => {
    it('Then it refuses with the missing value, as git dies loading its promisor remotes', async () => {
      // Arrange
      const ctx = createMemoryContext();
      await seedConfig(ctx, '[core]\n\tbare = false\n[remote "x"]\n\tpartialclonefilter\n');
      const sut = assertValidPromisorRemoteConfig;

      // Act
      let caught: unknown;
      try {
        await sut(ctx);
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeInstanceOf(TsgitError);
      expect((caught as TsgitError).data).toMatchObject({
        code: 'CONFIG_MISSING_VALUE',
        key: 'remote.x.partialclonefilter',
        line: 4,
      });
    });
  });
});

describe('assertValidPromisorRemoteConfig refusal order', () => {
  describe.each([
    {
      label: 'a valueless partialclonefilter before a malformed promisor',
      config: '[remote "y"]\n\tpartialclonefilter\n[remote "x"]\n\tpromisor = maybe\n',
      expected: { code: 'CONFIG_MISSING_VALUE', key: 'remote.y.partialclonefilter', line: 2 },
    },
    {
      label: 'a malformed promisor before a valueless partialclonefilter',
      config: '[remote "x"]\n\tpromisor = maybe\n\tpartialclonefilter\n',
      expected: { code: 'CONFIG_BAD_BOOLEAN_VALUE', key: 'remote.x.promisor', value: 'maybe' },
    },
    {
      label: "a valueless partialclonefilter under a '/'-named remote before a malformed promisor",
      config: '[remote "/x"]\n\tpartialclonefilter\n[remote "z"]\n\tpromisor = maybe\n',
      expected: { code: 'CONFIG_BAD_BOOLEAN_VALUE', key: 'remote.z.promisor', value: 'maybe' },
    },
  ])('Given $label', ({ config, expected }) => {
    describe('When the promisor config is validated', () => {
      it('Then it refuses the entry git meets first in the file', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, config);
        const sut = assertValidPromisorRemoteConfig;

        // Act
        let caught: unknown;
        try {
          await sut(ctx);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toMatchObject(expected);
      });
    });
  });

  describe("Given a valueless partialclonefilter only under a '/'-named remote", () => {
    describe('When the promisor config is validated', () => {
      it('Then it accepts it, as git never registers that remote', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[remote "/x"]\n\tpartialclonefilter\n');
        const sut = assertValidPromisorRemoteConfig;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});
