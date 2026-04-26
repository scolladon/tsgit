import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { diff } from '../../../../src/application/commands/diff.js';
import { init } from '../../../../src/application/commands/init.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

describe('diff', () => {
  it('Given two commits with one file change, When diff(from=c1, to=c2), Then returns a TreeDiff with the change', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.config.workDir}/a.txt`, 'a1');
    await add(ctx, ['a.txt']);
    const c1 = await commit(ctx, { message: 'first', author });
    await ctx.fs.writeUtf8(`${ctx.config.workDir}/a.txt`, 'a2');
    await add(ctx, ['a.txt']);
    const c2 = await commit(ctx, { message: 'second', author });

    // Act
    const sut = await diff(ctx, { from: c1.id, to: c2.id });

    // Assert — TreeDiff carries `changes`; modifying `a.txt` must produce ≥1 change.
    expect(sut.changes.length).toBeGreaterThanOrEqual(1);
  });

  it('Given a non-repo ctx, When diff, Then throws NOT_A_REPOSITORY', async () => {
    // Arrange
    const ctx = createMemoryContext();

    // Act
    let caught: unknown;
    try {
      await diff(ctx);
    } catch (err) {
      caught = err;
    }

    // Assert
    expect((caught as { data?: { code?: string } })?.data?.code).toBe('NOT_A_REPOSITORY');
  });
});
