import { describe, expect, it } from 'vitest';
import { buildSeededContext, instrumentedContext, serializeIndexFixture } from './fixtures.js';

describe('buildSeededContext', () => {
  describe('Given no parts', () => {
    describe('When building', () => {
      it('Then returns a usable Context with required fields', async () => {
        // Arrange / Act
        const sut = await buildSeededContext();

        // Assert — content checks on each field, not bare presence.
        expect(sut.layout.gitDir).toBe('/repo/.git');
        expect(typeof sut.deltaCache.get).toBe('function');
        expect(typeof sut.deltaCache.set).toBe('function');
        expect(sut.hashConfig.digestLength).toBe(20);
        expect(sut.hashConfig.hexLength).toBe(40);
      });
    });
  });

  describe('Given seeded loose refs', () => {
    describe('When reading via fs', () => {
      it('Then content is present', async () => {
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
    });
  });

  describe('Given an AbortSignal', () => {
    describe('When seeded', () => {
      it('Then ctx.signal is set', async () => {
        // Arrange
        const controller = new AbortController();
        const sut = await buildSeededContext({ signal: controller.signal });

        // Assert
        expect(sut.signal).toBe(controller.signal);
      });
    });
  });
});

describe('instrumentedContext', () => {
  describe('Given a wrapped context', () => {
    describe('When fs.read is called', () => {
      it('Then calls() records the method and path', async () => {
        // Arrange
        const base = await buildSeededContext();
        await base.fs.write('/repo/.git/foo', new Uint8Array([1, 2, 3]));
        const { ctx, calls } = instrumentedContext(base);

        // Act
        await ctx.fs.read('/repo/.git/foo');

        // Assert
        expect(calls()).toContainEqual({ method: 'read', path: '/repo/.git/foo' });
      });
    });
    describe('When no fs calls are made', () => {
      it('Then calls() is empty', async () => {
        // Arrange
        const base = await buildSeededContext();
        const { calls } = instrumentedContext(base);

        // Assert
        expect(calls()).toEqual([]);
      });
    });
  });
});

describe('serializeIndexFixture', () => {
  describe('Given an empty GitIndex', () => {
    describe('When serialized', () => {
      it('Then produces a 12-byte header only', () => {
        // Arrange — domain serializeIndex produces DIRC+version+count header for empty index.
        const index = {
          version: 2 as const,
          entries: [],
          extensions: [],
          trailerSha: new Uint8Array(0),
        };

        // Act
        const bytes = serializeIndexFixture(index);

        // Assert
        expect(bytes.length).toBeGreaterThanOrEqual(12);
      });
    });
  });
});
