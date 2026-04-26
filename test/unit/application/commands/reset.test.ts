import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { reset } from '../../../../src/application/commands/reset.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const seedTwoCommits = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const c1 = await commit(ctx, { message: 'first', author });
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
  await add(ctx, ['b.txt']);
  const c2 = await commit(ctx, { message: 'second', author });
  return { ctx, c1: c1.id, c2: c2.id };
};

describe('reset', () => {
  it('Given a soft reset to HEAD~1 (parent), When reset, Then current branch points at parent', async () => {
    // Arrange
    const { ctx, c1, c2 } = await seedTwoCommits();

    // Act
    const sut = await reset(ctx, { mode: 'soft', target: c1 });

    // Assert
    expect(sut.id).toBe(c1);
    expect(sut.branch).toBe('refs/heads/main');
    const ref = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/main`);
    expect(ref.trim()).toBe(c1);
    expect(c2).not.toBe(c1);
  });

  it('Given mixed mode and target oid, When reset, Then HEAD branch updated', async () => {
    const { ctx, c1 } = await seedTwoCommits();
    const sut = await reset(ctx, { mode: 'mixed', target: c1 });
    expect(sut.mode).toBe('mixed');
    expect(sut.id).toBe(c1);
  });

  it('Given hard mode and target oid, When reset, Then result.mode=hard and HEAD branch updated', async () => {
    const { ctx, c1 } = await seedTwoCommits();
    const sut = await reset(ctx, { mode: 'hard', target: c1 });
    expect(sut.mode).toBe('hard');
    expect(sut.id).toBe(c1);
  });

  it('Given an unresolvable target, When reset, Then throws REVPARSE_UNRESOLVED', async () => {
    const { ctx } = await seedTwoCommits();
    let caught: unknown;
    try {
      await reset(ctx, { mode: 'soft', target: 'no-such-ref' });
    } catch (err) {
      caught = err;
    }
    expect((caught as { data?: { code?: string } })?.data?.code).toBe('REVPARSE_UNRESOLVED');
  });

  it('Given target as a branch name, When reset, Then resolves via refs/heads/<name>', async () => {
    const { ctx, c1 } = await seedTwoCommits();
    const sut = await reset(ctx, { mode: 'soft', target: 'main' });
    expect(sut.id).not.toBe(c1); // main currently points at c2
  });

  it('Given target as HEAD, When reset, Then no-op (HEAD already points there)', async () => {
    const { ctx, c2 } = await seedTwoCommits();
    const sut = await reset(ctx, { mode: 'soft', target: 'HEAD' });
    expect(sut.id).toBe(c2);
  });

  it('Given hard mode on a bare repo, When reset, Then throws BARE_REPOSITORY', async () => {
    // Arrange — fresh ctx with bare config seeded BEFORE any read.
    const ctx = createMemoryContext();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  bare = true\n');

    // Act
    let caught: unknown;
    try {
      await reset(ctx, { mode: 'hard', target: 'HEAD' });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect((caught as { data?: { code?: string } })?.data?.code).toBe('BARE_REPOSITORY');
  });
});
