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

  describe('Given config with user.name and user.email', () => {
    describe('When resolving', () => {
      it('Then the identity uses those values', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[user]\n  name = Ada Lovelace\n  email = ada@example.com\n');

        // Act
        const sut = await resolveReflogIdentity(ctx);

        // Assert
        expect(sut.name).toBe('Ada Lovelace');
        expect(sut.email).toBe('ada@example.com');
      });
    });
  });

  describe('Given config with user.*', () => {
    describe('When resolving', () => {
      it('Then the timestamp is the current instant in seconds', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[user]\n  name = Ada\n  email = ada@example.com\n');

        // Act
        const sut = await resolveReflogIdentity(ctx);

        // Assert
        expect(sut.timestamp).toBe(Math.floor(FIXED_NOW_MS / 1000));
      });
      it('Then the timezone offset is +0000', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[user]\n  name = Ada\n  email = ada@example.com\n');

        // Act
        const sut = await resolveReflogIdentity(ctx);

        // Assert
        expect(sut.timezoneOffset).toBe('+0000');
      });
    });
  });

  describe('Given no .git/config at all', () => {
    describe('When resolving', () => {
      it('Then the portable fallback identity is used', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const sut = await resolveReflogIdentity(ctx);

        // Assert
        expect(sut.name).toBe('tsgit');
        expect(sut.email).toBe('tsgit@localhost');
      });
    });
  });

  describe('Given a config with [user] but no name/email', () => {
    describe('When resolving', () => {
      it('Then the portable fallback is used', async () => {
        // Arrange — git treats a half-configured user as unconfigured.
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[core]\n  bare = false\n');

        // Act
        const sut = await resolveReflogIdentity(ctx);

        // Assert
        expect(sut.name).toBe('tsgit');
        expect(sut.email).toBe('tsgit@localhost');
      });
    });
  });

  describe('Given the fallback identity', () => {
    describe('When resolving', () => {
      it('Then it still carries a fresh timestamp', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const sut = await resolveReflogIdentity(ctx);

        // Assert
        expect(sut.timestamp).toBe(Math.floor(FIXED_NOW_MS / 1000));
        expect(sut.timezoneOffset).toBe('+0000');
      });
    });
  });

  describe('Given an unconfigured repo', () => {
    describe('When resolving', () => {
      it('Then it returns a non-empty identity with both name and email', async () => {
        // Arrange — unconfigured repo must still surface SOME identity so the
        // ref update can record an author line; the resolver synthesises a
        // fallback rather than throwing.
        const ctx = createMemoryContext();

        // Act
        const sut = await resolveReflogIdentity(ctx);

        // Assert — fallback identity has both fields populated.
        expect(sut.name.length).toBeGreaterThan(0);
        expect(sut.email.length).toBeGreaterThan(0);
      });
    });
  });
});
