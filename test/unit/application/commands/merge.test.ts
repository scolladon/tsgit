import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branch } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { merge } from '../../../../src/application/commands/merge.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

describe('merge', () => {
  it('Given target equals HEAD, When merge, Then result.kind=up-to-date', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
    await add(ctx, ['a.txt']);
    const c = await commit(ctx, { message: 'first', author });

    // Act
    const sut = await merge(ctx, { target: c.id });

    // Assert
    expect(sut.kind).toBe('up-to-date');
  });

  it('Given an ancestor target, When merge, Then result.kind=fast-forward and branch advances', async () => {
    // Arrange — create main with 1 commit, branch feature, advance feature, switch to main, merge feature.
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
    await add(ctx, ['a.txt']);
    await commit(ctx, { message: 'first', author });
    await branch(ctx, { kind: 'create', name: 'feature' });
    await checkout(ctx, { target: 'feature' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
    await add(ctx, ['b.txt']);
    const c2 = await commit(ctx, { message: 'second', author });
    await checkout(ctx, { target: 'main' });

    // Act
    const sut = await merge(ctx, { target: 'feature' });

    // Assert
    expect(sut.kind).toBe('fast-forward');
    if (sut.kind === 'fast-forward') {
      expect(sut.id).toBe(c2.id);
    }
  });

  it('Given an ancestor target + noFastForward=true, When merge, Then a real merge commit is produced', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
    await add(ctx, ['a.txt']);
    await commit(ctx, { message: 'first', author });
    await branch(ctx, { kind: 'create', name: 'feature' });
    await checkout(ctx, { target: 'feature' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
    await add(ctx, ['b.txt']);
    await commit(ctx, { message: 'second', author });
    await checkout(ctx, { target: 'main' });

    // Act
    const sut = await merge(ctx, {
      target: 'feature',
      noFastForward: true,
      message: 'merge',
      author,
    });

    // Assert
    expect(sut.kind).toBe('merge');
    if (sut.kind === 'merge') {
      expect(sut.parents).toHaveLength(2);
    }
  });

  it('Given diverged histories + fastForwardOnly=true, When merge, Then throws NON_FAST_FORWARD', async () => {
    // Arrange — diverge: both branches advance from a common base.
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
    await add(ctx, ['a.txt']);
    await commit(ctx, { message: 'base', author });
    await branch(ctx, { kind: 'create', name: 'feature' });
    await checkout(ctx, { target: 'feature' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b.txt`, 'b');
    await add(ctx, ['b.txt']);
    await commit(ctx, { message: 'on-feature', author });
    await checkout(ctx, { target: 'main' });
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/c.txt`, 'c');
    await add(ctx, ['c.txt']);
    await commit(ctx, { message: 'on-main', author });

    // Act
    let caught: unknown;
    try {
      await merge(ctx, { target: 'feature', fastForwardOnly: true });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect((caught as { data?: { code?: string } })?.data?.code).toBe('NON_FAST_FORWARD');
  });
});

import { recordingProgress, withProgress } from './fixtures.js';

describe('merge — progress reporting', () => {
  it('Given an up-to-date merge, When run, Then NO progress events fire (early return before start)', async () => {
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
    await add(ctx, ['a.txt']);
    await commit(ctx, { message: 'm', author });
    const { reporter, events } = recordingProgress();

    await merge(withProgress(ctx, reporter), { target: 'main' });

    expect(events).toEqual([]);
  });
});
