import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../../src/application/commands/init.js';
import { invalidateConfigCache } from '../../../../../src/application/primitives/config-read.js';
import { packUseSparse } from '../../../../../src/application/primitives/internal/pack-use-sparse.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { Context } from '../../../../../src/ports/context.js';

const repoWith = async (packSection: string): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  const path = `${ctx.layout.gitDir}/config`;
  await ctx.fs.writeUtf8(path, `${await ctx.fs.readUtf8(path)}${packSection}`);
  invalidateConfigCache(ctx);
  return ctx;
};

describe.each([
  { label: 'no pack.useSparse', section: '', expected: true },
  { label: 'pack.useSparse=false', section: '[pack]\n\tuseSparse = false\n', expected: false },
  { label: 'pack.useSparse=true', section: '[pack]\n\tuseSparse = true\n', expected: true },
])('Given $label', ({ section, expected }) => {
  describe('When the setting is read', () => {
    it(`Then it answers ${expected}`, async () => {
      // Arrange
      const ctx = await repoWith(section);
      const sut = packUseSparse;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(result).toBe(expected);
    });
  });
});

describe('Given a pack.useSparse git cannot read as a boolean', () => {
  describe('When the setting is read', () => {
    it('Then it refuses with the bad boolean value', async () => {
      // Arrange
      const ctx = await repoWith('[pack]\n\tuseSparse = maybe\n');
      const sut = packUseSparse;

      // Act
      const result = await sut(ctx).catch((error: unknown) => (error as TsgitError).data);

      // Assert
      expect(result).toMatchObject({
        code: 'CONFIG_BAD_BOOLEAN_VALUE',
        key: 'pack.usesparse',
        value: 'maybe',
      });
    });
  });
});
