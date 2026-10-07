import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { resolveRevision } from '../../../../src/application/commands/rev-parse.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const CONFIG = `[remote "origin"]
  fetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
  remote = origin
  merge = refs/heads/main
`;

const commitFile = async (ctx: Context, name: string): Promise<ObjectId> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}`, `${name}\n`);
  await add(ctx, [name]);
  return (await commit(ctx, { message: name, author })).id;
};

/** main at `base` → `tip`; origin/main, main's upstream, at `tip`. */
const trackingRepo = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  const config = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, `${config}${CONFIG}`);
  const base = await commitFile(ctx, 'base.txt');
  const tip = await commitFile(ctx, 'tip.txt');
  await updateRef(ctx, 'refs/remotes/origin/main' as RefName, tip, { reflogMessage: 'fetch' });
  return { ctx, base, tip };
};

describe('Given main tracking origin/main', () => {
  describe.each([
    ['@{u}', 'tip'],
    ['@{upstream}~1', 'base'],
    ['main@{UpStream}^', 'base'],
    ['HEAD@{u}', 'tip'],
    ['@{push}', 'tip'],
    ['main@{push}~', 'base'],
    ['main@{u}@{0}', 'tip'],
    ['@{u}@{0}~1', 'base'],
  ] as const)('When %j is resolved', (expression, expected) => {
    it('Then it names the remote-tracking ref git reads', async () => {
      // Arrange
      const repo = await trackingRepo();
      const sut = resolveRevision;

      // Act
      const result = await sut(repo.ctx, expression);

      // Assert
      expect(result).toBe(repo[expected]);
    });
  });

  describe('When a branch with no upstream is marked', () => {
    it("Then it refuses with git's no-upstream reason", async () => {
      // Arrange
      const { ctx } = await trackingRepo();
      await updateRef(ctx, 'refs/heads/nou' as RefName, (await trackingRepo()).base, {
        reflogMessage: 'branch',
      });
      const sut = resolveRevision;

      // Act
      const result = await sut(ctx, 'nou@{u}').catch(
        (error: unknown) => (error as TsgitError).data,
      );

      // Assert
      expect(result).toEqual({
        code: 'BRANCH_MARK_UNRESOLVED',
        reason: 'no-upstream',
        branch: 'nou',
      });
    });
  });
});
