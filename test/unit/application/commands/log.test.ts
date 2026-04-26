import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { log } from '../../../../src/application/commands/log.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const seedThree = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  for (const [path, content, message] of [
    ['a.txt', 'a', 'first'],
    ['b.txt', 'b', 'second'],
    ['c.txt', 'c', 'third'],
  ] as const) {
    await ctx.fs.writeUtf8(`${ctx.config.workDir}/${path}`, content);
    await add(ctx, [path]);
    await commit(ctx, { message, author });
  }
  return ctx;
};

describe('log', () => {
  it('Given three commits, When log, Then returns them in newest-first order', async () => {
    // Arrange
    const ctx = await seedThree();

    // Act
    const sut = await log(ctx);

    // Assert
    expect(sut.map((e) => e.message)).toEqual(['third', 'second', 'first']);
  });

  it('Given limit=2, When log, Then yields exactly 2', async () => {
    // Arrange
    const ctx = await seedThree();

    // Act
    const sut = await log(ctx, { limit: 2 });

    // Assert
    expect(sut).toHaveLength(2);
  });

  it('Given excluding contains the parent commit, When log, Then commits up to (but not including) the parent are returned', async () => {
    // Arrange
    const ctx = await seedThree();
    const all = await log(ctx);
    // Exclude the oldest commit (its parents are []); only the newest two should remain.
    const oldest = all[all.length - 1] as { readonly id: string };

    // Act
    const sut = await log(ctx, { excluding: [oldest.id] });

    // Assert — the excluded commit is not yielded.
    expect(sut.find((e) => e.id === oldest.id)).toBeUndefined();
  });

  it("Given from='main' (ref name, not HEAD), When log, Then resolves the named branch", async () => {
    // Arrange
    const ctx = await seedThree();

    // Act
    const sut = await log(ctx, { from: 'main' });

    // Assert — same shape as default HEAD-driven log; kills `from === 'HEAD'` mutants.
    expect(sut.length).toBeGreaterThanOrEqual(3);
  });

  it('Given from is a 40-hex oid, When log, Then walks from that oid directly (no ref lookup)', async () => {
    // Arrange
    const ctx = await seedThree();
    const all = await log(ctx);
    const oldest = all[all.length - 1] as { readonly id: string };

    // Act — walk from the oldest commit; should yield only itself.
    const sut = await log(ctx, { from: oldest.id });

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.id).toBe(oldest.id);
  });

  it('Given an unborn branch (no commits), When log, Then throws (HEAD ref is missing)', async () => {
    // Arrange — a fresh init produces an unborn `refs/heads/main`; HEAD points at it but the ref does not exist.
    const ctx = await seedThree();
    // Wipe the ref to simulate the unborn-branch state.
    await ctx.fs.rm(`${ctx.config.gitDir}/refs/heads/main`);

    // Act
    let caught: unknown;
    try {
      await log(ctx);
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeDefined();
  });
});
