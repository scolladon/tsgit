import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { resolveRevision } from '../../../../src/application/commands/rev-parse.js';
import { errorDataCode } from '../../../../src/domain/error-data-code.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

interface SwitchedRepo {
  readonly ctx: Context;
  readonly warnings: string[];
  readonly base: ObjectId;
  readonly side: ObjectId;
  readonly main: ObjectId;
}

const commitFile = async (ctx: Context, name: string, message: string): Promise<ObjectId> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}`, `${name}\n`);
  await add(ctx, [name]);
  return (await commit(ctx, { message, author })).id;
};

/** main: base → main; side: base → side; HEAD went main → side → main. */
const switchedRepo = async (): Promise<SwitchedRepo> => {
  const warnings: string[] = [];
  const base = createMemoryContext();
  const ctx = { ...base, logger: { ...base.logger, warn: (m: string) => warnings.push(m) } };
  await init(ctx);
  const baseId = await commitFile(ctx, 'base.txt', 'base');
  await branchCreate(ctx, { name: 'side' });
  await checkout(ctx, { rev: 'side' });
  const side = await commitFile(ctx, 'side.txt', 'side');
  await checkout(ctx, { rev: 'main' });
  const main = await commitFile(ctx, 'main.txt', 'main');
  return { ctx, warnings, base: baseId, side, main };
};

const codeOf = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
    return undefined;
  } catch (error) {
    return errorDataCode(error);
  }
};

describe('Given HEAD switched main → side → main', () => {
  describe.each([
    ['@{-1}', 'side'],
    ['@{-1}~1', 'base'],
    ['@{-2}', 'main'],
    ['@{-1}@{0}', 'side'],
  ] as const)('When %s is resolved', (expression, expected) => {
    it(`Then it names the ${expected} commit, as git's nth prior checkout does`, async () => {
      // Arrange
      const repo = await switchedRepo();
      const sut = resolveRevision;

      // Act
      const result = await sut(repo.ctx, expression);

      // Assert
      expect(result).toBe(repo[expected]);
    });
  });

  describe.each([
    ['x@{-1}', 'REVPARSE_UNRESOLVED'],
    ['@{1}@{-1}', 'REVPARSE_UNRESOLVED'],
    ['@{-3}', 'OBJECT_NOT_FOUND'],
    ['@{-0}', 'OBJECT_NOT_FOUND'],
  ])('When %s is resolved', (expression, expected) => {
    it('Then it names no revision', async () => {
      // Arrange
      const { ctx } = await switchedRepo();
      const sut = resolveRevision;

      // Act
      const result = await codeOf(() => sut(ctx, expression));

      // Assert
      expect(result).toBe(expected);
    });
  });
});

describe('Given the prior checkout was a detached HEAD', () => {
  describe('When @{-1} is resolved', () => {
    it('Then it names the commit HEAD was detached at', async () => {
      // Arrange
      const repo = await switchedRepo();
      await checkout(repo.ctx, { rev: repo.side, detach: true });
      await checkout(repo.ctx, { rev: 'main' });
      const sut = resolveRevision;

      // Act
      const result = await sut(repo.ctx, '@{-1}');

      // Assert
      expect(result).toBe(repo.side);
    });
  });
});

describe('Given a tag sharing the prior branch name', () => {
  describe('When @{-1} is resolved', () => {
    it('Then the tag wins and the ambiguity is warned under @{-1}', async () => {
      // Arrange
      const repo = await switchedRepo();
      await repo.ctx.fs.writeUtf8(`${repo.ctx.layout.gitDir}/refs/tags/side`, `${repo.main}\n`);
      const sut = resolveRevision;

      // Act
      const result = await sut(repo.ctx, '@{-1}');

      // Assert
      expect(result).toBe(repo.main);
      expect(repo.warnings).toEqual(["refname '@{-1}' is ambiguous."]);
    });
  });
});
