/**
 * A malformed `core.bigFileThreshold` (last entry wins) under `add`: git's
 * `index_fd` reads it before hashing a regular file, so `add` refuses once it
 * has a regular file to hash — never for a symlink.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { init } from '../../../../src/application/commands/init.js';
import type { Context } from '../../../../src/ports/context.js';

const MALFORMED = '[core]\n\tbigFileThreshold = x\n';

const repoWithMalformedThreshold = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  const configPath = `${ctx.layout.gitDir}/config`;
  await ctx.fs.writeUtf8(configPath, `${await ctx.fs.readUtf8(configPath)}${MALFORMED}`);
  return ctx;
};

describe('Given a malformed core.bigFileThreshold', () => {
  describe('When add stages a regular file', () => {
    it('Then it refuses with the key', async () => {
      // Arrange
      const ctx = await repoWithMalformedThreshold();
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a\n');
      const sut = add;

      // Act
      const result = await sut(ctx, ['a.txt']).catch((err: { data: unknown }) => err.data);

      // Assert
      expect(result).toMatchObject({
        code: 'CONFIG_BAD_NUMERIC_VALUE',
        key: 'core.bigfilethreshold',
        value: 'x',
      });
    });
  });

  describe('When add stages a symlink', () => {
    it('Then it stages it without reading the threshold', async () => {
      // Arrange
      const ctx = await repoWithMalformedThreshold();
      await ctx.fs.symlink('target', `${ctx.layout.workDir}/link`);
      const sut = add;

      // Act
      const result = await sut(ctx, ['link']);

      // Assert
      expect(result.added).toEqual(['link']);
    });
  });
});
