import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { submoduleSync } from '../../../../src/application/commands/submodule.js';
import { readConfig } from '../../../../src/application/primitives/config-read.js';
import type { Context } from '../../../../src/ports/context.js';

const SUPER_OLD = 'https://old.example/lib.git';
const SUPER_NEW = 'https://new.example/lib.git';
const INNER_OLD = 'https://old.example/inner.git';
const INNER_NEW = 'https://new.example/inner.git';

/**
 * Seed a two-level superproject: `lib` is checked out and itself has a checked-out
 * `inner` submodule. `.gitmodules` carries the NEW urls; config carries the OLD
 * ones — so a sync re-points them, and a recursive sync re-points the nested one.
 */
const seedNested = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  const { gitDir, workDir } = ctx.layout;
  await ctx.fs.writeUtf8(`${gitDir}/HEAD`, 'ref: refs/heads/main\n');
  // Superproject: lib registered (config OLD), .gitmodules NEW.
  await ctx.fs.writeUtf8(
    `${workDir}/.gitmodules`,
    `[submodule "lib"]\n\tpath = lib\n\turl = ${SUPER_NEW}\n`,
  );
  await ctx.fs.writeUtf8(
    `${gitDir}/config`,
    `[submodule "lib"]\n\turl = ${SUPER_OLD}\n\tactive = true\n`,
  );
  // lib checked out: its absorbed gitdir + remote + nested submodule.
  await ctx.fs.writeUtf8(`${gitDir}/modules/lib/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(
    `${gitDir}/modules/lib/config`,
    `[remote "origin"]\n\turl = ${SUPER_OLD}\n[submodule "inner"]\n\turl = ${INNER_OLD}\n\tactive = true\n`,
  );
  await ctx.fs.writeUtf8(
    `${workDir}/lib/.gitmodules`,
    `[submodule "inner"]\n\tpath = inner\n\turl = ${INNER_NEW}\n`,
  );
  // inner checked out under lib's absorbed gitdir.
  await ctx.fs.writeUtf8(`${gitDir}/modules/lib/modules/inner/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(
    `${gitDir}/modules/lib/modules/inner/config`,
    `[remote "origin"]\n\turl = ${INNER_OLD}\n`,
  );
  return ctx;
};

const innerUrlOf = async (ctx: Context): Promise<string | undefined> => {
  const text = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/modules/lib/config`);
  return text.match(/\[submodule "inner"\][\s\S]*?url = (\S+)/)?.[1];
};

describe('Given a two-level submodule tree', () => {
  describe('When sync runs without recursion', () => {
    it('Then it re-points the top level only, leaving the nested submodule untouched', async () => {
      // Arrange
      const ctx = await seedNested();
      // Act
      await submoduleSync(ctx);
      // Assert
      const config = await readConfig(ctx);
      expect(config.submodule?.get('lib')?.url).toBe(SUPER_NEW);
      expect(await innerUrlOf(ctx)).toBe(INNER_OLD);
    });
  });

  describe('When sync runs with recursion', () => {
    it('Then it descends and re-points the nested submodule too', async () => {
      // Arrange
      const ctx = await seedNested();
      // Act
      await submoduleSync(ctx, { recursive: true });
      // Assert — top level re-pointed
      const config = await readConfig(ctx);
      expect(config.submodule?.get('lib')?.url).toBe(SUPER_NEW);
      // lib's own remote.origin.url re-pointed
      const libConfig = await ctx_text(ctx, 'modules/lib/config');
      expect(libConfig).toContain(`url = ${SUPER_NEW}`);
      // nested inner re-pointed in lib's config + inner's own remote
      expect(await innerUrlOf(ctx)).toBe(INNER_NEW);
      const innerConfig = await ctx_text(ctx, 'modules/lib/modules/inner/config');
      expect(innerConfig).toContain(`url = ${INNER_NEW}`);
    });
  });
});

const ctx_text = (ctx: Context, rel: string): Promise<string> =>
  ctx.fs.readUtf8(`${ctx.layout.gitDir}/${rel}`);
