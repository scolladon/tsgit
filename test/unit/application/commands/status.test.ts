import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { status } from '../../../../src/application/commands/status.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const seedClean = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.config.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  await commit(ctx, { message: 'first', author });
  return ctx;
};

describe('status', () => {
  it('Given a clean repo, When status, Then clean=true and no working-tree changes', async () => {
    // Arrange
    const ctx = await seedClean();

    // Act
    const sut = await status(ctx);

    // Assert
    expect(sut.clean).toBe(true);
    expect(sut.workingTreeChanges).toEqual([]);
    expect(sut.branch).toBe('refs/heads/main');
  });

  it('Given a modified working file, When status, Then workingTreeChanges contains a modified entry', async () => {
    // Arrange
    const ctx = await seedClean();
    await ctx.fs.writeUtf8(`${ctx.config.workDir}/a.txt`, 'modified');

    // Act
    const sut = await status(ctx);

    // Assert
    expect(sut.clean).toBe(false);
    expect(sut.workingTreeChanges).toContainEqual({ kind: 'modified', path: 'a.txt' });
  });

  it('Given a deleted working file, When status, Then workingTreeChanges contains a deleted entry', async () => {
    // Arrange
    const ctx = await seedClean();
    await ctx.fs.rm(`${ctx.config.workDir}/a.txt`);

    // Act
    const sut = await status(ctx);

    // Assert
    expect(sut.workingTreeChanges).toContainEqual({ kind: 'deleted', path: 'a.txt' });
  });
});
