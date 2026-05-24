import { describe, expect, it } from 'vitest';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { TsgitError } from '../../../../src/domain/error.js';
import {
  buildSeededContext,
  serializeIndexFixture,
  serializeIndexFixtureAsync,
} from './fixtures.js';

describe('readIndex', () => {
  describe('Given no index file', () => {
    describe('When readIndex is called', () => {
      it('Then returns { version: 2, entries: [], extensions: [] }', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = await readIndex(ctx);
        // Assert
        expect(sut.version).toBe(2);
        expect(sut.entries).toEqual([]);
        expect(sut.extensions).toEqual([]);
      });
    });
  });

  describe('Given a seeded empty index', () => {
    describe('When readIndex is called', () => {
      it('Then round-trips correctly', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          index: { version: 2, entries: [], extensions: [] },
        });
        const sut = await readIndex(ctx);
        // Assert
        expect(sut.version).toBe(2);
        expect(sut.entries).toEqual([]);
      });
    });
  });

  describe('Given a well-formed body with a mutated trailer byte', () => {
    describe('When readIndex is called', () => {
      it('Then throws INVALID_INDEX_HEADER /checksum mismatch/ (integrity check fires before parseIndex)', async () => {
        // Arrange
        // Build a body that parseIndex would accept on its own, then append a
        // trailer that DOESN'T match the body's hash. This distinguishes the
        // integrity-first flow from a no-op path: under a skipped check,
        // parseIndex would succeed.
        const ctx = await buildSeededContext();
        const body = serializeIndexFixture({ version: 2, entries: [], extensions: [] });
        const trailer = new Uint8Array(20); // 20 zero bytes — definitely wrong
        const bytes = new Uint8Array(body.length + trailer.length);
        bytes.set(body, 0);
        bytes.set(trailer, body.length);
        await ctx.fs.write('/repo/.git/index', bytes);
        try {
          await readIndex(ctx);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          expect((error as TsgitError).data.code).toBe('INVALID_INDEX_HEADER');
          expect((error as TsgitError).message).toMatch(/checksum mismatch/);
        }
      });
    });
  });

  describe('Given stat size exactly 256 MiB (at cap)', () => {
    describe('When readIndex is called', () => {
      it('Then size check passes and only the trailer-too-short branch fires', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.write('/repo/.git/index', new Uint8Array([0]));
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            stat: async (p: string) => {
              const s = await ctx.fs.stat(p);
              return { ...s, size: 256 * 1024 * 1024 };
            },
          },
        };
        let caught: unknown;
        try {
          await readIndex(wrapped);
          // Assert
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        // At-cap (size === MAX) must NOT trip the `> MAX` predicate. A `>= MAX`
        // mutant would surface "exceeds 256 MiB"; we positively assert the
        // *other* error fires instead, proving the predicate held its boundary.
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('INVALID_INDEX_HEADER');
        expect((caught as TsgitError).message).not.toMatch(/exceeds 256 MiB/);
        expect((caught as TsgitError).message).toMatch(/shorter than/);
      });
    });
  });

  describe('Given a read that returns oversized bytes despite a small stat size (TOCTOU)', () => {
    describe('When readIndex is called', () => {
      it('Then throws INVALID_INDEX_HEADER /exceeds 256 MiB/', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.write('/repo/.git/index', new Uint8Array([0]));
        const oversized = new Uint8Array(256 * 1024 * 1024 + 1);
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async () => oversized,
          },
        };
        try {
          await readIndex(wrapped);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('INVALID_INDEX_HEADER');
          expect((error as TsgitError).message).toMatch(/exceeds 256 MiB/);
        }
      });
    });
  });

  describe('Given a well-formed empty index with matching trailer', () => {
    describe('When readIndex is called', () => {
      it('Then succeeds and returns empty entries', async () => {
        // Arrange
        // Ensures the integrity branch is reachable AND the trailer matches, so
        // parseIndex runs and returns an empty index.
        const ctx = await buildSeededContext();
        const bytes = await serializeIndexFixtureAsync(
          { version: 2, entries: [], extensions: [] },
          ctx,
        );
        await ctx.fs.write('/repo/.git/index', bytes);
        const sut = await readIndex(ctx);
        // Assert
        expect(sut.entries).toEqual([]);
      });
    });
  });

  describe('Given bytes shorter than the trailer size', () => {
    describe('When readIndex is called', () => {
      it('Then throws INVALID_INDEX_HEADER /shorter than/ (rejects early)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.write('/repo/.git/index', new Uint8Array([0, 0, 0, 0, 0]));
        try {
          await readIndex(ctx);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('INVALID_INDEX_HEADER');
          expect((error as TsgitError).message).toMatch(/shorter than/);
        }
      });
    });
  });

  describe('Given hashConfig.digestLength=32 and a 25-byte file (long enough for SHA-1 but not SHA-256)', () => {
    describe('When readIndex is called', () => {
      it('Then throws /shorter than the hash trailer/ (proves split honors digestLength)', async () => {
        // Arrange
        // 25 bytes is >= 20 (SHA-1 trailer) but < 32 (SHA-256 trailer). Under a
        // hardcoded-20 split the file would be considered long enough and would
        // proceed to the checksum branch; under the correct digestLength-driven
        // split it must reject with the trailer-too-short error.
        const ctx = await buildSeededContext();
        const wrapped = {
          ...ctx,
          hashConfig: { digestLength: 32 as const, hexLength: 64 as const },
        };
        await ctx.fs.write('/repo/.git/index', new Uint8Array(25));
        let caught: unknown;
        try {
          await readIndex(wrapped);
          // Assert
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('INVALID_INDEX_HEADER');
        expect((caught as TsgitError).message).toMatch(/shorter than the hash trailer/);
      });
    });
  });

  describe('Given a file exactly trailerSize bytes long with a valid empty-payload checksum', () => {
    describe('When readIndex is called', () => {
      it('Then it does NOT reject with /shorter than/ (boundary: length === trailerSize is long enough)', async () => {
        // Arrange — a 20-byte file whose bytes ARE the SHA-1 of the empty payload.
        // `bytes.length (20) < trailerSize (20)` is false, so the trailer-too-short
        // guard must NOT fire; the checksum then matches and parsing proceeds.
        // A `<=` mutant would treat an exactly-trailerSize file as too short.
        const ctx = await buildSeededContext();
        const emptyHashHex = await ctx.hash.hashHex(new Uint8Array(0));
        const trailer = new Uint8Array(20);
        for (let i = 0; i < 20; i += 1) {
          trailer[i] = Number.parseInt(emptyHashHex.slice(i * 2, i * 2 + 2), 16);
        }
        await ctx.fs.write('/repo/.git/index', trailer);

        // Act
        let caught: unknown;
        try {
          await readIndex(ctx);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert — the checksum passed; the failure is a parse error, never the
        // trailer-too-short rejection that the `<=` mutant would produce.
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).message).not.toMatch(/shorter than/);
      });
    });
  });

  describe('Given a multi-gigabyte index stat size', () => {
    describe('When readIndex is called', () => {
      it('Then throws INVALID_INDEX_HEADER /exceeds 256 MiB/ (without materializing)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        // Seed a tiny file so exists() returns true; then override stat via a wrapper context.
        await ctx.fs.write('/repo/.git/index', new Uint8Array([0]));
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            stat: async (p: string) => {
              const s = await ctx.fs.stat(p);
              return { ...s, size: 256 * 1024 * 1024 + 1 };
            },
          },
        };
        try {
          await readIndex(wrapped);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('INVALID_INDEX_HEADER');
          const msg = (error as TsgitError).message;
          expect(msg).toMatch(/exceeds 256 MiB/);
        }
      });
    });
  });
});
