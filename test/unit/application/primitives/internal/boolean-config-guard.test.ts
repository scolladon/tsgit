import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  assertValidBooleanConfig,
  assertValidBooleanConfigInSection,
  assertValidBooleanLiteral,
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

describe('assertValidBooleanLiteral', () => {
  describe('Given [push] gpgSign holds a value git refuses', () => {
    describe('When called', () => {
      it('Then throws CONFIG_BAD_BOOLEAN_LITERAL with key/source/value', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[push]\n\tgpgSign = maybe\n');

        // Act
        let caught: unknown;
        try {
          await assertValidBooleanLiteral(ctx, 'push', undefined, ['gpgsign']);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data as BadBooleanData;
        expect(data.code).toBe('CONFIG_BAD_BOOLEAN_LITERAL');
        expect(data.key).toBe('push.gpgsign');
        expect(data.value).toBe('maybe');
        expect(data.source).toMatch(/\/config$/);
      });
    });
  });

  describe('Given [push] gpgSign holds a value git accepts', () => {
    describe('When called', () => {
      it('Then resolves (no throw)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[push]\n\tgpgSign = true\n');

        // Act + Assert
        await assertValidBooleanLiteral(ctx, 'push', undefined, ['gpgsign']);
      });
    });
  });

  describe('Given the requested key is absent', () => {
    describe('When called', () => {
      it('Then resolves (no throw)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[push]\n\tdefault = simple\n');

        // Act + Assert
        await assertValidBooleanLiteral(ctx, 'push', undefined, ['gpgsign']);
      });
    });
  });

  describe('Given the malformed key sits in a different section', () => {
    describe('When called', () => {
      it('Then resolves (no throw — out of section)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[push]\n\tgpgSign = maybe\n');

        // Act + Assert
        await assertValidBooleanLiteral(ctx, 'commit', undefined, ['gpgsign']);
      });
    });
  });
});
