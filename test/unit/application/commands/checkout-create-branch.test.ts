import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import type { TsgitError } from '../../../../src/domain/index.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

interface Seed {
  readonly ctx: Context;
  readonly first: ObjectId;
  readonly second: ObjectId;
}

/** `other` at the first commit, `main` one commit ahead with different content. */
const seed = async (): Promise<Seed> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'A');
  await add(ctx, ['a.txt']);
  const first = (await commit(ctx, { message: 'first', author })).id;
  await branchCreate(ctx, { name: 'other' });
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'B');
  await add(ctx, ['a.txt']);
  const second = (await commit(ctx, { message: 'second', author })).id;
  return { ctx, first, second };
};

const readText = (ctx: Context, path: string): Promise<string> => ctx.fs.readUtf8(path);

describe('checkout createBranch', () => {
  describe('Given a start point naming another branch', () => {
    describe('When checkout creates a new branch there', () => {
      it('Then the branch is created at the start point, HEAD attaches to it and the tree switches', async () => {
        // Arrange
        const { ctx, first } = await seed();
        const sut = checkout;

        // Act
        const result = await sut(ctx, { rev: 'other', createBranch: { name: 'topic' } });

        // Assert
        expect(result).toEqual({
          branch: 'refs/heads/topic',
          id: first,
          detached: false,
          changedPaths: 1,
        });
        expect(await readText(ctx, `${ctx.layout.gitDir}/HEAD`)).toBe('ref: refs/heads/topic\n');
        expect(await readText(ctx, `${ctx.layout.gitDir}/refs/heads/topic`)).toBe(`${first}\n`);
        expect(await readText(ctx, `${ctx.layout.workDir}/a.txt`)).toBe('A');
        const headLog = await readText(ctx, `${ctx.layout.gitDir}/logs/HEAD`);
        expect(headLog.trimEnd().split('\n').at(-1)).toMatch(
          /\tcheckout: moving from main to topic$/,
        );
      });
    });
  });

  describe('Given a start point and an explicit track', () => {
    describe('When checkout creates a new branch tracking it', () => {
      it('Then branch.<new>.remote and merge record the local start branch', async () => {
        // Arrange
        const { ctx } = await seed();
        const sut = checkout;

        // Act
        await sut(ctx, { rev: 'other', createBranch: { name: 't2', track: 'direct' } });

        // Assert
        const config = await readText(ctx, `${ctx.layout.gitDir}/config`);
        expect(config).toContain('[branch "t2"]\n\tremote = .\n\tmerge = refs/heads/other\n');
      });
    });
  });

  describe('Given a branch name already taken', () => {
    describe('When checkout tries to create it', () => {
      it('Then it refuses before touching the work tree', async () => {
        // Arrange
        const { ctx } = await seed();
        const sut = checkout;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { rev: 'other', createBranch: { name: 'main' } });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'BRANCH_EXISTS',
          name: 'refs/heads/main',
        });
        expect(await readText(ctx, `${ctx.layout.workDir}/a.txt`)).toBe('B');
        expect(await readText(ctx, `${ctx.layout.gitDir}/HEAD`)).toBe('ref: refs/heads/main\n');
      });
    });
  });

  describe('Given detach alongside a new branch', () => {
    describe('When checkout runs', () => {
      it('Then it refuses the combination', async () => {
        // Arrange
        const { ctx } = await seed();
        const sut = checkout;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { rev: 'other', detach: true, createBranch: { name: 'topic' } });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'INVALID_OPTION',
          option: 'createBranch',
          reason: 'cannot be combined with detach',
        });
      });
    });
  });
});
