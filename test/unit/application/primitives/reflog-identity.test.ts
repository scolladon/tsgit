import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { resolveReflogIdentity } from '../../../../src/application/primitives/reflog-identity.js';
import type { Context } from '../../../../src/ports/context.js';

const FIXED_NOW_MS = 1_716_240_000_000;

const seedConfig = async (ctx: Context, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);
};

describe('resolveReflogIdentity', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Given config with user.name and user.email, When resolving, Then the identity uses those values', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seedConfig(ctx, '[user]\n  name = Ada Lovelace\n  email = ada@example.com\n');

    // Act
    const sut = await resolveReflogIdentity(ctx);

    // Assert
    expect(sut.name).toBe('Ada Lovelace');
    expect(sut.email).toBe('ada@example.com');
  });

  it('Given config with user.*, When resolving, Then the timestamp is the current instant in seconds', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seedConfig(ctx, '[user]\n  name = Ada\n  email = ada@example.com\n');

    // Act
    const sut = await resolveReflogIdentity(ctx);

    // Assert
    expect(sut.timestamp).toBe(Math.floor(FIXED_NOW_MS / 1000));
  });

  it('Given config with user.*, When resolving, Then the timezone offset is +0000', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seedConfig(ctx, '[user]\n  name = Ada\n  email = ada@example.com\n');

    // Act
    const sut = await resolveReflogIdentity(ctx);

    // Assert
    expect(sut.timezoneOffset).toBe('+0000');
  });

  it('Given no .git/config at all, When resolving, Then the portable fallback identity is used', async () => {
    // Arrange
    const ctx = createMemoryContext();

    // Act
    const sut = await resolveReflogIdentity(ctx);

    // Assert
    expect(sut.name).toBe('tsgit');
    expect(sut.email).toBe('tsgit@localhost');
  });

  it('Given a config with [user] but no name/email, When resolving, Then the portable fallback is used', async () => {
    // Arrange — git treats a half-configured user as unconfigured.
    const ctx = createMemoryContext();
    await seedConfig(ctx, '[core]\n  bare = false\n');

    // Act
    const sut = await resolveReflogIdentity(ctx);

    // Assert
    expect(sut.name).toBe('tsgit');
    expect(sut.email).toBe('tsgit@localhost');
  });

  it('Given the fallback identity, When resolving, Then it still carries a fresh timestamp', async () => {
    // Arrange
    const ctx = createMemoryContext();

    // Act
    const sut = await resolveReflogIdentity(ctx);

    // Assert
    expect(sut.timestamp).toBe(Math.floor(FIXED_NOW_MS / 1000));
    expect(sut.timezoneOffset).toBe('+0000');
  });

  it('Given an unconfigured repo, When resolving, Then it never throws', async () => {
    // Arrange
    const ctx = createMemoryContext();

    // Act & Assert — resolution must not abort a ref update.
    // Assert
    await expect(resolveReflogIdentity(ctx)).resolves.toBeDefined();
  });
});
