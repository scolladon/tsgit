import { describe, expect, it } from 'vitest';
import { deriveContext } from '../../../../src/application/primitives/derive-context.js';
import { indexEntryFromStat } from '../../../../src/application/primitives/internal/index-entry-from-stat.js';
import { acquireIndexLock } from '../../../../src/application/primitives/internal/index-lock.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { TsgitError } from '../../../../src/domain/error.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../src/ports/context.js';
import {
  buildSeededContext,
  serializeIndexFixture,
  serializeIndexFixtureAsync,
} from './fixtures.js';

const FAKE_OBJECT_ID = 'a'.repeat(40) as ObjectId;

/** Counts `ctx.fs.read` calls, proving whether a `readIndex` call was a cache hit or a miss. */
const trackRead = (ctx: Context): { readonly ctx: Context; readonly count: () => number } => {
  const baseRead = ctx.fs.read;
  let calls = 0;
  const wrappedFs = {
    ...ctx.fs,
    read: async (path: string) => {
      calls += 1;
      return baseRead(path);
    },
  };
  return { ctx: { ...ctx, fs: wrappedFs }, count: () => calls };
};

const seedEmptyIndex = async (ctx: Context): Promise<void> => {
  const bytes = await serializeIndexFixtureAsync(
    { version: 2, entries: [], extensions: [], trailerSha: new Uint8Array(0) },
    ctx,
  );
  await ctx.fs.write('/repo/.git/index', bytes);
};

/** Wraps `ctx.fs.stat` so every call returns the frozen stat, simulating a filesystem with no nanosecond precision colliding on a same-tick write. */
const withFrozenStat = (
  ctx: Context,
  pinned: Awaited<ReturnType<Context['fs']['stat']>>,
): Context => ({
  ...ctx,
  fs: { ...ctx.fs, stat: async () => pinned },
});

describe('readIndex', () => {
  describe('Given no index file', () => {
    describe('When readIndex is called', () => {
      it('Then returns { version: 2, entries: [], extensions: [] }', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act
        const result = await readIndex(ctx);

        // Assert
        expect(result.version).toBe(2);
        expect(result.entries).toEqual([]);
        expect(result.extensions).toEqual([]);
      });
    });
  });

  describe('Given a seeded empty index', () => {
    describe('When readIndex is called', () => {
      it('Then round-trips correctly', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          index: { version: 2, entries: [], extensions: [], trailerSha: new Uint8Array(0) },
        });

        // Act
        const result = await readIndex(ctx);

        // Assert
        expect(result.version).toBe(2);
        expect(result.entries).toEqual([]);
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
        const body = serializeIndexFixture({
          version: 2,
          entries: [],
          extensions: [],
          trailerSha: new Uint8Array(0),
        });
        const trailer = new Uint8Array(20); // 20 zero bytes — definitely wrong
        const bytes = new Uint8Array(body.length + trailer.length);
        bytes.set(body, 0);
        bytes.set(trailer, body.length);
        await ctx.fs.write('/repo/.git/index', bytes);

        // Act
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

        // Act
        let caught: unknown;
        try {
          await readIndex(wrapped);
          // Assert
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert — at-cap (size === MAX) must NOT trip the `> MAX` predicate. A
        // `>= MAX` mutant would surface "exceeds 256 MiB"; we positively assert the
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

        // Act
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
          { version: 2, entries: [], extensions: [], trailerSha: new Uint8Array(0) },
          ctx,
        );
        await ctx.fs.write('/repo/.git/index', bytes);

        // Act
        const result = await readIndex(ctx);

        // Assert
        expect(result.entries).toEqual([]);
      });
    });
  });

  describe('Given bytes shorter than the trailer size', () => {
    describe('When readIndex is called', () => {
      it('Then throws INVALID_INDEX_HEADER /shorter than/ (rejects early)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.write('/repo/.git/index', new Uint8Array([0, 0, 0, 0, 0]));

        // Act
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
          hashConfig: {
            algorithm: 'sha256' as const,
            digestLength: 32 as const,
            hexLength: 64 as const,
          },
        };
        await ctx.fs.write('/repo/.git/index', new Uint8Array(25));

        // Act
        let caught: unknown;
        try {
          await readIndex(wrapped);
          // Assert
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
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

  describe('Given a backing stat with a known sub-second mtimeNs value', () => {
    describe('When readIndex is called', () => {
      it('Then indexMtime.nanoseconds is the nanosecond-of-second remainder (not the full ns value scaled up)', async () => {
        // Arrange
        // mtimeNs encodes whole seconds too: 1_700_000_100_222_000_000n is
        // 1_700_000_100s + 222_000_000ns. The correct derivation is `% 1e9`,
        // giving exactly the 222_000_000 sub-second remainder. A `*` mutant
        // would produce an astronomically larger, clearly divergent number.
        const ctx = await buildSeededContext();
        const bytes = await serializeIndexFixtureAsync(
          { version: 2, entries: [], extensions: [], trailerSha: new Uint8Array(0) },
          ctx,
        );
        await ctx.fs.write('/repo/.git/index', bytes);
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            stat: async (p: string) => {
              const s = await ctx.fs.stat(p);
              return { ...s, mtimeNs: 1_700_000_100_222_000_000n };
            },
          },
        };

        // Act
        const result = await readIndex(wrapped);

        // Assert
        expect(result.indexMtime?.nanoseconds).toBe(222_000_000);
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

        // Act
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

  describe('Given a stat size above the caching threshold but under the 256 MiB hard cap', () => {
    describe('When readIndex is called twice with the index unchanged', () => {
      it('Then the file is read and re-parsed on both calls — never cached above the threshold', async () => {
        // Arrange — a small, valid index file on disk (so the real read/parse/
        // verify still succeeds), but `stat` is wrapped to report a size just
        // above the caching threshold: large enough that a session-lifetime
        // cache would retain a 3-5x-parsed blowup of it for no benefit, small
        // enough that it is still a valid, readable index (not the 256 MiB
        // hard refusal this file's other test already covers).
        // A defined, matching `mtimeNs` on both calls keeps the stat-key
        // comparison non-racy (see `isRacyMatch`), so the cache decision
        // below is driven purely by the size threshold this test targets —
        // not by the unrelated trailer-fallback path a racy match would
        // otherwise route through.
        const base = await buildSeededContext();
        await seedEmptyIndex(base);
        const { ctx, count } = trackRead(base);
        const wrapped: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            stat: async (p: string) => {
              const s = await ctx.fs.stat(p);
              return { ...s, size: 32 * 1024 * 1024 + 1, mtimeNs: 0n };
            },
          },
        };

        // Act
        const first = await readIndex(wrapped);
        const second = await readIndex(wrapped);

        // Assert
        expect(count()).toBe(2);
        expect(second).toEqual(first);
      });
    });
  });

  describe('Given two readIndex calls on one Context with the index unchanged', () => {
    describe('When readIndex is called', () => {
      it('Then the file is read once', async () => {
        // Arrange
        const base = await buildSeededContext();
        await seedEmptyIndex(base);
        const { ctx, count } = trackRead(base);

        // Act
        const first = await readIndex(ctx);
        const second = await readIndex(ctx);

        // Assert
        expect(count()).toBe(1);
        expect(second).toEqual(first);
      });
    });
  });

  describe('Given the index parsed once through the opening Context', () => {
    describe('When readIndex is called through a Context derived by deriveContext (same session)', () => {
      it('Then the derived Context hits the shared cache — the file is read once', async () => {
        // Arrange
        const base = await buildSeededContext();
        await seedEmptyIndex(base);
        const { ctx, count } = trackRead(base);
        const derived = deriveContext(ctx, {});

        // Act
        const first = await readIndex(ctx);
        const second = await readIndex(derived);

        // Assert
        expect(derived.session).toBe(ctx.session);
        expect(count()).toBe(1);
        expect(second).toEqual(first);
      });
    });
  });

  describe('Given the index parsed once through a Context derived by deriveContext (same session)', () => {
    describe('When readIndex is called through the opening Context', () => {
      it('Then the opening Context hits the shared cache — the file is read once', async () => {
        // Arrange
        const base = await buildSeededContext();
        await seedEmptyIndex(base);
        const { ctx, count } = trackRead(base);
        const derived = deriveContext(ctx, { deltaCache: ctx.deltaCache });

        // Act
        const first = await readIndex(derived);
        const second = await readIndex(ctx);

        // Assert
        expect(count()).toBe(1);
        expect(second).toEqual(first);
      });
    });
  });

  describe('Given the index size changed between two readIndex calls', () => {
    describe('When readIndex is called', () => {
      it('Then it is re-read', async () => {
        // Arrange
        const base = await buildSeededContext();
        await seedEmptyIndex(base);
        const realStat = await base.fs.stat('/repo/.git/index');
        const { ctx, count } = trackRead(base);
        await readIndex(ctx);
        const grown = {
          ...ctx,
          fs: { ...ctx.fs, stat: async () => ({ ...realStat, size: realStat.size + 1 }) },
        };

        // Act
        await readIndex(grown);

        // Assert
        expect(count()).toBe(2);
      });
    });
  });

  describe('Given mtimeMs changed between two readIndex calls', () => {
    describe('When readIndex is called', () => {
      it('Then it is re-read', async () => {
        // Arrange
        const base = await buildSeededContext();
        await seedEmptyIndex(base);
        const realStat = await base.fs.stat('/repo/.git/index');
        const { ctx, count } = trackRead(base);
        await readIndex(ctx);
        const touched = {
          ...ctx,
          fs: { ...ctx.fs, stat: async () => ({ ...realStat, mtimeMs: realStat.mtimeMs + 1 }) },
        };

        // Act
        await readIndex(touched);

        // Assert
        expect(count()).toBe(2);
      });
    });
  });

  describe('Given mtimeNs changed between two readIndex calls', () => {
    describe('When readIndex is called', () => {
      it('Then it is re-read', async () => {
        // Arrange
        const base = await buildSeededContext();
        await seedEmptyIndex(base);
        const realStat = await base.fs.stat('/repo/.git/index');
        const { ctx, count } = trackRead(base);
        const firstStat = { ...realStat, mtimeNs: 1n };
        const first = { ...ctx, fs: { ...ctx.fs, stat: async () => firstStat } };
        await readIndex(first);
        const second = {
          ...ctx,
          fs: { ...ctx.fs, stat: async () => ({ ...firstStat, mtimeNs: 2n }) },
        };

        // Act
        await readIndex(second);

        // Assert
        expect(count()).toBe(2);
      });
    });
  });

  describe('Given ino changed between two readIndex calls', () => {
    describe('When readIndex is called', () => {
      it('Then it is re-read', async () => {
        // Arrange
        const base = await buildSeededContext();
        await seedEmptyIndex(base);
        const realStat = await base.fs.stat('/repo/.git/index');
        const { ctx, count } = trackRead(base);
        const firstStat = { ...realStat, ino: 7 };
        const first = { ...ctx, fs: { ...ctx.fs, stat: async () => firstStat } };
        await readIndex(first);
        const second = { ...ctx, fs: { ...ctx.fs, stat: async () => ({ ...firstStat, ino: 8 }) } };

        // Act
        await readIndex(second);

        // Assert
        expect(count()).toBe(2);
      });
    });
  });

  describe('Given the stat key collides across two calls (no nanosecond precision) and the file content genuinely changed', () => {
    describe('When readIndex is called again', () => {
      it('Then the trailer mismatch is detected and the file is re-read', async () => {
        // Arrange — freeze `stat` so the key looks identical on both calls
        // (mtimeNs undefined, exactly the memory adapter's shape); the on-disk
        // bytes are genuinely swapped in between via a raw write (an external
        // actor, not the lock-commit path).
        const base = await buildSeededContext();
        await seedEmptyIndex(base);
        const frozenStat = await base.fs.stat('/repo/.git/index');
        const { ctx, count } = trackRead(withFrozenStat(base, frozenStat));
        const first = await readIndex(ctx);
        const entry = indexEntryFromStat(
          frozenStat,
          FILE_MODE.REGULAR,
          FAKE_OBJECT_ID,
          'a.txt' as FilePath,
        );
        const bytes = await serializeIndexFixtureAsync(
          { version: 2, entries: [entry], extensions: [], trailerSha: new Uint8Array(0) },
          base,
        );
        await base.fs.write('/repo/.git/index', bytes);

        // Act
        const second = await readIndex(ctx);

        // Assert
        expect(count()).toBe(2);
        expect(first.entries).toEqual([]);
        expect(second.entries.map((e) => e.path)).toEqual(['a.txt']);
      });
    });
  });

  describe('Given the stat key collides across two calls (no nanosecond precision) and the file content is unchanged', () => {
    describe('When readIndex is called again', () => {
      it('Then the trailer still matches and the cached parse is reused', async () => {
        // Arrange
        const base = await buildSeededContext();
        await seedEmptyIndex(base);
        const frozenStat = await base.fs.stat('/repo/.git/index');
        const { ctx, count } = trackRead(withFrozenStat(base, frozenStat));
        await readIndex(ctx);

        // Act
        await readIndex(ctx);

        // Assert — one real read plus one trailer-fallback `readSlice`
        // verification, never a second full read.
        expect(count()).toBe(1);
      });
    });
  });

  describe('Given an index written through the lock commit path, with BOTH the stat key and the trailer read pinned identical across both reads', () => {
    describe('When readIndex is called again', () => {
      it('Then the next readIndex sees it — invalidation, not the stat/trailer safety nets, drives the re-read', async () => {
        // Arrange — `ctx` (pinned-stat, pinned-trailer wrapper) is the SAME
        // identity used for both reads and the lock/commit: the cache is
        // keyed on Context identity (matching config-read.ts's precedent),
        // so read and write must share one object for invalidation to be
        // observable at all. Pinning `readSlice` too defeats the racy-stat
        // trailer fallback, which would otherwise independently notice the
        // content changed and mask a missing `invalidateIndexCache` call.
        const seeded = await buildSeededContext();
        await seedEmptyIndex(seeded);
        const pinnedStat = await seeded.fs.stat('/repo/.git/index');
        const trailerSize = seeded.hashConfig.digestLength;
        const pinnedTrailer = await seeded.fs.readSlice(
          '/repo/.git/index',
          pinnedStat.size - trailerSize,
          trailerSize,
        );
        const ctx: Context = {
          ...seeded,
          fs: { ...seeded.fs, stat: async () => pinnedStat, readSlice: async () => pinnedTrailer },
        };
        const before = await readIndex(ctx);
        const entry = indexEntryFromStat(
          pinnedStat,
          FILE_MODE.REGULAR,
          FAKE_OBJECT_ID,
          'a.txt' as FilePath,
        );
        const lock = await acquireIndexLock(ctx);
        await lock.commit([entry]);

        // Act
        const after = await readIndex(ctx);

        // Assert
        expect(before.entries).toEqual([]);
        expect(after.entries.map((e) => e.path)).toEqual(['a.txt']);
      });
    });
  });

  describe('Given a first readIndex call caches a valid index, then the file is replaced with a truncated one', () => {
    describe('When readIndex is called again', () => {
      it('Then the trailer check still refuses before parsing (integrity-first survives caching)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedEmptyIndex(ctx);
        await readIndex(ctx);
        await ctx.fs.write('/repo/.git/index', new Uint8Array([0, 0, 0, 0, 0]));

        // Act
        let caught: unknown;
        try {
          await readIndex(ctx);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('INVALID_INDEX_HEADER');
        expect((caught as TsgitError).message).toMatch(/shorter than/);
      });
    });
  });
});
