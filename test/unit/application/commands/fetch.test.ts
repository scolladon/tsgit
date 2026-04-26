import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { fetch } from '../../../../src/application/commands/fetch.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { seedRepo } from './fixtures.js';

describe('fetch', () => {
  it('Given no remote configured, When fetch, Then throws REMOTE_NOT_CONFIGURED', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seedRepo(ctx, {});

    // Act
    let caught: unknown;
    try {
      await fetch(ctx);
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('REMOTE_NOT_CONFIGURED');
  });

  it('Given an origin remote, When fetch, Then returns the resolved url', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seedRepo(ctx, {});
    await ctx.fs.writeUtf8(
      `${ctx.config.gitDir}/config`,
      '[remote "origin"]\n  url = https://example.com/r.git\n',
    );

    // Act
    const sut = await fetch(ctx);

    // Assert
    expect(sut.remote).toBe('origin');
    expect(sut.url).toBe('https://example.com/r.git');
  });
});
