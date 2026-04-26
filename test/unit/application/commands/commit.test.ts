import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const seed = async (workingTree: Readonly<Record<string, string>> = { 'a.txt': 'a' }) => {
  const ctx = createMemoryContext();
  await init(ctx);
  for (const [path, content] of Object.entries(workingTree)) {
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);
  }
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

describe('commit', () => {
  it('Given a staged file + explicit author, When commit, Then returns id and updates HEAD branch', async () => {
    // Arrange
    const ctx = await seed();

    // Act
    const sut = await commit(ctx, { message: 'first', author });

    // Assert
    expect(sut.id).toMatch(/^[0-9a-f]{40}$/);
    expect(sut.parents).toEqual([]);
    expect(sut.branch).toBe('refs/heads/main');
    const refContent = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/main`);
    expect(refContent.trim()).toBe(sut.id);
  });

  it('Given a second commit with no index changes, When commit (allowEmpty=false), Then throws NOTHING_TO_COMMIT', async () => {
    // Arrange
    const ctx = await seed();
    await commit(ctx, { message: 'first', author });

    // Act
    await expectError(() => commit(ctx, { message: 'second', author }), 'NOTHING_TO_COMMIT');
  });

  it('Given an empty message + allowEmptyMessage=false, When commit, Then throws EMPTY_COMMIT_MESSAGE', async () => {
    const ctx = await seed();
    await expectError(() => commit(ctx, { message: '   \n   ', author }), 'EMPTY_COMMIT_MESSAGE');
  });

  it('Given no author and no config user, When commit, Then throws AUTHOR_UNCONFIGURED', async () => {
    const ctx = await seed();
    await expectError(() => commit(ctx, { message: 'x' }), 'AUTHOR_UNCONFIGURED');
  });

  it('Given a non-repo ctx, When commit, Then throws NOT_A_REPOSITORY', async () => {
    const ctx = createMemoryContext();
    await expectError(() => commit(ctx, { message: 'x', author }), 'NOT_A_REPOSITORY');
  });

  it('Given allowEmpty=true, When commit on unchanged tree, Then succeeds with the same tree', async () => {
    // Arrange
    const ctx = await seed();
    const first = await commit(ctx, { message: 'first', author });

    // Act — same tree, allowEmpty=true means the empty-commit guard is skipped.
    const sut = await commit(ctx, { message: 'second', author, allowEmpty: true });

    // Assert — both commits share the tree but produce distinct ids (different message).
    expect(sut.tree).toBe(first.tree);
    expect(sut.id).not.toBe(first.id);
    expect(sut.parents).toEqual([first.id]);
  });
});
