import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { clone } from '../../../../src/application/commands/clone.js';
import { TsgitError } from '../../../../src/domain/index.js';

describe('clone', () => {
  it('Given a fresh dir, When clone, Then bootstraps a repo and returns CloneResult', async () => {
    // Arrange
    const ctx = createMemoryContext();

    // Act
    const sut = await clone(ctx, { url: 'https://example.com/r.git' });

    // Assert
    expect(sut.path).toBe(ctx.config.gitDir);
    expect(sut.head).toBe('main');
  });

  it('Given an existing .git, When clone, Then throws TARGET_DIRECTORY_NOT_EMPTY', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await ctx.fs.writeUtf8(`${ctx.config.gitDir}/HEAD`, 'ref: refs/heads/main\n');

    // Act
    let caught: unknown;
    try {
      await clone(ctx, { url: 'https://example.com/r.git' });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('TARGET_DIRECTORY_NOT_EMPTY');
  });
});
