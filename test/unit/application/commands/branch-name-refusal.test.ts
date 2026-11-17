import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import {
  branchCreate,
  branchList,
  branchRename,
} from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import type { TsgitError } from '../../../../src/domain/index.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const born = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'A');
  await add(ctx, ['a.txt']);
  await commit(ctx, { message: 'first', author });
  return ctx;
};

const unborn = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  return ctx;
};

const dataOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return (error as TsgitError).data;
  }
  return undefined;
};

const headFile = (ctx: Context): Promise<string> => ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);

const refusals = [
  { name: 'HEAD', reason: 'branch name must not be HEAD' },
  { name: '-x', reason: 'branch name must not start with -' },
];

describe.each(refusals)('Given the branch name $name', ({ name, reason }) => {
  const refused = { code: 'INVALID_REF', reason };

  describe('When branch.create runs on a born repository', () => {
    it('Then it refuses and writes no branch', async () => {
      // Arrange
      const ctx = await born();
      const sut = branchCreate;

      // Act
      const data = await dataOf(() => sut(ctx, { name }));

      // Assert
      expect(data).toEqual(refused);
      expect((await branchList(ctx)).branches.map((b) => b.name)).toEqual(['refs/heads/main']);
    });
  });

  describe('When checkout -b runs on a born HEAD', () => {
    it('Then it refuses and HEAD stays on main', async () => {
      // Arrange
      const ctx = await born();
      const sut = checkout;

      // Act
      const data = await dataOf(() => sut(ctx, { rev: 'main', createBranch: { name } }));

      // Assert
      expect(data).toEqual(refused);
      expect(await headFile(ctx)).toBe('ref: refs/heads/main\n');
    });
  });

  describe('When checkout -b runs on an unborn HEAD', () => {
    it('Then it refuses and HEAD stays on main', async () => {
      // Arrange
      const ctx = await unborn();
      const sut = checkout;

      // Act
      const data = await dataOf(() => sut(ctx, { createBranch: { name } }));

      // Assert
      expect(data).toEqual(refused);
      expect(await headFile(ctx)).toBe('ref: refs/heads/main\n');
    });
  });

  describe('When branchRename targets it', () => {
    it('Then it refuses and keeps the source branch', async () => {
      // Arrange
      const ctx = await born();
      await branchCreate(ctx, { name: 'x' });
      const sut = branchRename;

      // Act
      const data = await dataOf(() => sut(ctx, { from: 'x', to: name }));

      // Assert
      expect(data).toEqual(refused);
      expect((await branchList(ctx)).branches.map((b) => b.name)).toEqual([
        'refs/heads/main',
        'refs/heads/x',
      ]);
    });
  });
});
