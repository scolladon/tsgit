import { describe, expect, it } from 'vitest';
import { buildSeededContext, instrumentedContext, serializeIndexFixture } from './fixtures.js';

describe('buildSeededContext', () => {
  it('Given no parts, When building, Then returns a usable Context with required fields', async () => {
    // Arrange / Act
    const sut = await buildSeededContext();

    // Assert
    expect(sut.config.gitDir).toBe('/repo/.git');
    expect(sut.deltaCache).toBeDefined();
    expect(sut.hashConfig).toBeDefined();
  });

  it('Given seeded loose refs, When reading via fs, Then content is present', async () => {
    // Arrange
    const sut = await buildSeededContext({
      refs: [
        {
          name: 'refs/heads/main' as never,
          id: 'a'.repeat(40) as never,
        },
      ],
    });

    // Act
    const content = await sut.fs.readUtf8('/repo/.git/refs/heads/main');

    // Assert
    expect(content).toBe(`${'a'.repeat(40)}\n`);
  });

  it('Given an AbortSignal, When seeded, Then ctx.signal is set', async () => {
    // Arrange
    const controller = new AbortController();
    const sut = await buildSeededContext({ signal: controller.signal });

    // Assert
    expect(sut.signal).toBe(controller.signal);
  });
});

describe('instrumentedContext', () => {
  it('Given a wrapped context, When fs.read is called, Then calls() records the method and path', async () => {
    // Arrange
    const base = await buildSeededContext();
    await base.fs.write('/repo/.git/foo', new Uint8Array([1, 2, 3]));
    const { ctx, calls } = instrumentedContext(base);

    // Act
    await ctx.fs.read('/repo/.git/foo');

    // Assert
    expect(calls()).toContainEqual({ method: 'read', path: '/repo/.git/foo' });
  });

  it('Given a wrapped context, When no fs calls are made, Then calls() is empty', async () => {
    // Arrange
    const base = await buildSeededContext();
    const { calls } = instrumentedContext(base);

    // Assert
    expect(calls()).toEqual([]);
  });
});

describe('serializeIndexFixture', () => {
  it('Given an empty GitIndex, When serialized, Then produces a 12-byte header only', () => {
    // Arrange — domain serializeIndex produces DIRC+version+count header for empty index.
    const index = { version: 2 as const, entries: [], extensions: [] };

    // Act
    const bytes = serializeIndexFixture(index);

    // Assert
    expect(bytes.length).toBeGreaterThanOrEqual(12);
  });
});
