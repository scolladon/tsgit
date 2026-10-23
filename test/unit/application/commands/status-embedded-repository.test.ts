import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { status } from '../../../../src/application/commands/status.js';
import { seedRepo } from './fixtures.js';

type Ctx = ReturnType<typeof createMemoryContext>;

const BRANCH_HEAD = 'c'.repeat(40);

const layOutRepository = async (ctx: Ctx, directory: string): Promise<void> => {
  const gitDir = `${ctx.layout.workDir}/${directory}/.git`;
  await ctx.fs.writeUtf8(`${gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.mkdir(`${gitDir}/objects`);
  await ctx.fs.mkdir(`${gitDir}/refs`);
  await ctx.fs.writeUtf8(`${gitDir}/refs/heads/main`, `${BRANCH_HEAD}\n`);
};

const embedded = async (workingTree: Readonly<Record<string, string>> = {}): Promise<Ctx> => {
  const ctx = createMemoryContext();
  await seedRepo(ctx, { workingTree });
  await layOutRepository(ctx, 'sub');
  return ctx;
};

describe('status over an untracked repository', () => {
  describe('Given an untracked repository holding a file', () => {
    describe('When the status is taken', () => {
      it('Then the repository is listed once as its directory', async () => {
        // Arrange
        const ctx = await embedded({ 'sub/u': 'u\n' });
        const sut = status;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.untracked).toEqual(['sub/']);
        expect(result.clean).toBe(false);
      });
    });
  });

  describe('Given a directory whose .git leads to no repository', () => {
    describe('When the status is taken', () => {
      it('Then its files are listed one by one', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, { workingTree: { 'sub/u': 'u\n' } });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/.git/HEAD`, 'garbage\n');
        const sut = status;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.untracked).toEqual(['sub/u']);
      });
    });
  });
});
