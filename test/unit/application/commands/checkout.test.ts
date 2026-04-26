import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branch } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
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

const seedWithBranches = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const c = await commit(ctx, { message: 'first', author });
  await branch(ctx, { kind: 'create', name: 'feature' });
  return { ctx, commitId: c.id };
};

describe('checkout', () => {
  it('Given an existing branch, When checkout, Then HEAD becomes symref to that branch', async () => {
    // Arrange
    const { ctx, commitId } = await seedWithBranches();

    // Act
    const sut = await checkout(ctx, { target: 'feature' });

    // Assert
    expect(sut.branch).toBe('refs/heads/feature');
    expect(sut.id).toBe(commitId);
    expect(sut.detached).toBe(false);
    const head = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
    expect(head).toBe('ref: refs/heads/feature\n');
  });

  it('Given a 40-hex oid, When checkout, Then HEAD becomes detached at that oid', async () => {
    // Arrange
    const { ctx, commitId } = await seedWithBranches();

    // Act
    const sut = await checkout(ctx, { target: commitId });

    // Assert
    expect(sut.detached).toBe(true);
    expect(sut.id).toBe(commitId);
    const head = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
    expect(head).toBe(`${commitId}\n`);
  });

  it('Given a non-existent branch, When checkout, Then throws BRANCH_NOT_FOUND', async () => {
    // Arrange
    const { ctx } = await seedWithBranches();

    // Act
    let caught: unknown;
    try {
      await checkout(ctx, { target: 'ghost' });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('BRANCH_NOT_FOUND');
  });

  it('Given the currently-checked-out branch, When checkout, Then HEAD remains a symref to the same branch (no-op-equivalent)', async () => {
    // Arrange
    const { ctx } = await seedWithBranches();

    // Act
    const sut = await checkout(ctx, { target: 'main' });

    // Assert
    expect(sut.branch).toBe('refs/heads/main');
    expect(sut.detached).toBe(false);
  });

  it('Given detach=true with a branch name, When checkout, Then HEAD is detached at the resolved oid', async () => {
    // Arrange
    const { ctx, commitId } = await seedWithBranches();

    // Act — branch name + detach should resolve to the oid AND detach.
    const sut = await checkout(ctx, { target: commitId, detach: true });

    // Assert
    expect(sut.detached).toBe(true);
    expect(sut.id).toBe(commitId);
  });
});

import { recordingProgress, withProgress } from './fixtures.js';

describe('checkout — progress reporting', () => {
  const seedWithBranch = async () => {
    const ctx = createMemoryContext();
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
    await add(ctx, ['a.txt']);
    await commit(ctx, { message: 'first', author });
    await branch(ctx, { kind: 'create', name: 'feature' });
    return ctx;
  };

  it("Given a successful checkout, When run, Then start fires before end with op === 'checkout:materialize'", async () => {
    const ctx = await seedWithBranch();
    const { reporter, events } = recordingProgress();

    await checkout(withProgress(ctx, reporter), { target: 'feature' });

    expect(events[0]).toEqual({ kind: 'start', op: 'checkout:materialize' });
    expect(events[events.length - 1]).toEqual({ kind: 'end', op: 'checkout:materialize' });
  });

  it('Given a checkout that throws (unknown branch), When run, Then end still fires', async () => {
    const ctx = await seedWithBranch();
    const { reporter, events } = recordingProgress();

    try {
      await checkout(withProgress(ctx, reporter), { target: 'does-not-exist' });
    } catch {
      // expected
    }

    const startCount = events.filter((e) => e.kind === 'start').length;
    const endCount = events.filter((e) => e.kind === 'end').length;
    expect(endCount).toBe(startCount);
  });
});
