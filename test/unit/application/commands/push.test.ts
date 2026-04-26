import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { push } from '../../../../src/application/commands/push.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { seedRepo } from './fixtures.js';

describe('push', () => {
  it('Given no remote configured, When push, Then throws REMOTE_NOT_CONFIGURED', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seedRepo(ctx, {});

    // Act
    let caught: unknown;
    try {
      await push(ctx);
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('REMOTE_NOT_CONFIGURED');
  });

  it('Given an origin remote, When push, Then returns the resolved url', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seedRepo(ctx, {});
    await ctx.fs.writeUtf8(
      `${ctx.config.gitDir}/config`,
      '[remote "origin"]\n  url = https://example.com/r.git\n',
    );

    // Act
    const sut = await push(ctx);

    // Assert
    expect(sut.url).toBe('https://example.com/r.git');
  });
});
