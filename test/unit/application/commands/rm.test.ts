import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { rm } from '../../../../src/application/commands/rm.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { seedRepo } from './fixtures.js';

const seedAndStage = async (workingTree: Readonly<Record<string, string>>) => {
  const ctx = createMemoryContext();
  await seedRepo(ctx, { workingTree });
  await add(ctx, Object.keys(workingTree));
  return ctx;
};

const expectError = async (fn: () => Promise<unknown>, code: string): Promise<TsgitError> => {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  expect((caught as TsgitError).data.code).toBe(code);
  return caught as TsgitError;
};

describe('rm', () => {
  it('Given an empty pathspec, When rm, Then throws EMPTY_PATHSPEC', async () => {
    const ctx = await seedAndStage({ 'a.txt': 'a' });
    await expectError(() => rm(ctx, []), 'EMPTY_PATHSPEC');
  });

  it('Given a tracked file, When rm, Then result.removed lists it and the file is deleted', async () => {
    // Arrange
    const ctx = await seedAndStage({ 'a.txt': 'a' });

    // Act
    const sut = await rm(ctx, ['a.txt']);

    // Assert
    expect(sut.removed).toEqual(['a.txt']);
    expect(await ctx.fs.exists(`${ctx.layout.workDir}/a.txt`)).toBe(false);
  });

  it('Given cached=true, When rm, Then index entry removed but working file kept', async () => {
    // Arrange
    const ctx = await seedAndStage({ 'a.txt': 'a' });

    // Act
    await rm(ctx, ['a.txt'], { cached: true });

    // Assert
    expect(await ctx.fs.exists(`${ctx.layout.workDir}/a.txt`)).toBe(true);
  });

  it('Given an untracked path, When rm, Then throws PATHSPEC_NO_MATCH', async () => {
    const ctx = await seedAndStage({ 'a.txt': 'a' });
    await expectError(() => rm(ctx, ['ghost.txt']), 'PATHSPEC_NO_MATCH');
  });

  it('Given a glob "*.log" with two matching tracked files, When rm, Then both are removed (no PATHSPEC_NO_MATCH for globs)', async () => {
    // Arrange
    const ctx = await seedAndStage({ 'a.log': 'a', 'b.log': 'b', 'keep.ts': 'k' });

    // Act
    const sut = await rm(ctx, ['*.log']);

    // Assert
    expect([...sut.removed].sort()).toEqual(['a.log', 'b.log']);
    expect(await ctx.fs.exists(`${ctx.layout.workDir}/keep.ts`)).toBe(true);
  });

  it('Given a glob "*.nope" with no matches, When rm, Then returns removed=[] without throwing', async () => {
    // Arrange
    const ctx = await seedAndStage({ 'a.txt': 'a' });

    // Act
    const sut = await rm(ctx, ['*.nope']);

    // Assert — glob no-match is a no-op, not an error (Git semantics).
    expect(sut.removed).toEqual([]);
  });

  it('Given a glob + a `!`-negation, When rm, Then negated paths stay in the index', async () => {
    // Arrange
    const ctx = await seedAndStage({ 'a.log': 'a', 'keep.log': 'k', 'b.log': 'b' });

    // Act
    const sut = await rm(ctx, ['*.log', '!keep.log']);

    // Assert
    expect([...sut.removed].sort()).toEqual(['a.log', 'b.log']);
    expect(await ctx.fs.exists(`${ctx.layout.workDir}/keep.log`)).toBe(true);
  });

  it('Given a bare repo, When rm, Then throws BARE_REPOSITORY', async () => {
    // Arrange — fresh ctx with bare=true config seeded BEFORE any read.
    const ctx = createMemoryContext();
    await seedRepo(ctx, {});
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  bare = true\n');

    // Act
    await expectError(() => rm(ctx, ['a.txt']), 'BARE_REPOSITORY');
  });
});
