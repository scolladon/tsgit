import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { resolveRevision, revParse } from '../../../../src/application/commands/rev-parse.js';
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

const LOCAL_UPSTREAM = `[branch "main"]
  remote = .
  merge = refs/heads/other
`;

/** main's upstream is the local branch other, which refs/remotes/other shadows; warnings captured. */
const shadowedUpstreamRepo = async () => {
  const warnings: string[] = [];
  const base = createMemoryContext();
  const ctx: Context = { ...base, logger: { warn: (message: string) => warnings.push(message) } };
  await init(ctx);
  const config = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, `${config}${LOCAL_UPSTREAM}`);
  const tip = await commitFile(ctx, 'tip.txt');
  await updateRef(ctx, 'refs/heads/other' as RefName, tip, { reflogMessage: 'branch' });
  await updateRef(ctx, 'refs/remotes/other' as RefName, tip, { reflogMessage: 'fetch' });
  return { ctx, warnings };
};

describe('Given an upstream branch name a remote-tracking ref also carries', () => {
  describe('When revParse reads @{u}^{blob}, which names no object', () => {
    it('Then it warns the ambiguity once, the reread being quiet, as git does', async () => {
      // Arrange
      const { ctx, warnings } = await shadowedUpstreamRepo();
      const sut = revParse;

      // Act
      const result = await sut(ctx, '@{u}^{blob}').catch(
        (error: unknown) => (error as TsgitError).data,
      );

      // Assert
      expect(result).toMatchObject({ code: 'OBJECT_NOT_FOUND' });
      expect(warnings).toEqual(["refname '@{u}' is ambiguous."]);
    });
  });
});
