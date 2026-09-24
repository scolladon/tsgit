import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  createPackWindowCache,
  DEFAULT_PACK_WINDOW_BYTES,
  DEFAULT_PACK_WINDOW_LIMIT_BYTES,
  packWindowBudgetFor,
} from '../../../../../src/application/primitives/internal/pack-window-cache.js';
import type { Context } from '../../../../../src/ports/context.js';

const seedConfig = async (ctx: Context, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);
};

/** Deterministic filler bytes standing in for a pack's on-disk contents. */
function fakeSource(byteCount: number): Uint8Array {
  return Uint8Array.from({ length: byteCount }, (_unused, i) => i % 256);
}

/** A `load` double over `source`: `subarray` clamps at the array's own end,
 *  the same clamping `loadWindow` performs against the real pack file size. */
function loaderOver(source: Uint8Array) {
  return vi.fn(
    async (base: number, size: number): Promise<Uint8Array> => source.subarray(base, base + size),
  );
}

describe('createPackWindowCache', () => {
  describe('Given a request fully inside an uncached window', () => {
    describe('When read is called', () => {
      it('Then it loads exactly one window and returns the requested view', async () => {
        // Arrange
        const source = fakeSource(1000);
        const load = loaderOver(source);
        const cache = createPackWindowCache({ windowBytes: 256, limitBytes: 4096 });

        // Act
        const result = await cache.read('pack-a', 10, 20, load);

        // Assert
        expect(Array.from(result)).toEqual(Array.from(source.subarray(10, 30)));
        expect(load).toHaveBeenCalledTimes(1);
        expect(load).toHaveBeenCalledWith(0, 256);
      });
    });
  });

  describe('Given a request already served by a cached window', () => {
    describe('When read is called a second time inside the same window', () => {
      it('Then no second load is issued', async () => {
        // Arrange
        const source = fakeSource(1000);
        const load = loaderOver(source);
        const cache = createPackWindowCache({ windowBytes: 256, limitBytes: 4096 });
        await cache.read('pack-a', 10, 20, load);

        // Act
        const result = await cache.read('pack-a', 40, 30, load);

        // Assert
        expect(Array.from(result)).toEqual(Array.from(source.subarray(40, 70)));
        expect(load).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a request that crosses a window-aligned boundary', () => {
    describe('When read is called', () => {
      it('Then it bypasses the cache with one direct load, never a page-aligned rescue window', async () => {
        // Arrange — windowBytes=8192 (two 4 KiB pages); offset=8100 straddles
        // the window-aligned boundary at 8192. A page-aligned rescue window
        // would load [4096, 12288) — a range the FOLLOWING aligned window
        // ([8192, 16384)) already re-loads on the very next sequential read,
        // doubling I/O over their overlap. Serving the straddling read
        // directly, uncached, avoids that double load; it costs no more than
        // the rescue window did for this one request.
        const source = fakeSource(20000);
        const load = loaderOver(source);
        const cache = createPackWindowCache({ windowBytes: 8192, limitBytes: 1 << 20 });

        // Act
        const result = await cache.read('pack-a', 8100, 200, load);

        // Assert
        expect(Array.from(result)).toEqual(Array.from(source.subarray(8100, 8300)));
        expect(load).toHaveBeenCalledTimes(1);
        expect(load).toHaveBeenCalledWith(8100, 200);
      });
    });
  });

  describe('Given a sequential trace whose first entry straddles a window boundary', () => {
    describe('When the next entry lands inside the following aligned window', () => {
      it('Then every byte range is loaded at most once — no overlapping double load', async () => {
        // Arrange — the default 64 KiB window: an entry at [65000, 65600)
        // straddles the [0, 65536) window (65000 + 600 > 65536), so it is
        // served directly; the next entry at 66000 lands fully inside the
        // FOLLOWING aligned window [65536, 131072), loaded once and cached.
        // Pre-fix, the straddling read would have loaded a page-aligned
        // rescue window [61440, 126976) — overlapping the second read's own
        // [65536, 131072) window across [65536, 126976), loading that whole
        // span twice.
        const source = fakeSource(140_000);
        const load = loaderOver(source);
        const cache = createPackWindowCache({ windowBytes: 65536, limitBytes: 1 << 20 });

        // Act
        const first = await cache.read('pack-a', 65000, 600, load);
        const second = await cache.read('pack-a', 66000, 4, load);
        const third = await cache.read('pack-a', 66100, 4, load);

        // Assert
        expect(Array.from(first)).toEqual(Array.from(source.subarray(65000, 65600)));
        expect(Array.from(second)).toEqual(Array.from(source.subarray(66000, 66004)));
        expect(Array.from(third)).toEqual(Array.from(source.subarray(66100, 66104)));
        expect(load).toHaveBeenCalledTimes(2);
        expect(load).toHaveBeenNthCalledWith(1, 65000, 600);
        expect(load).toHaveBeenNthCalledWith(2, 65536, 65536);
      });
    });
  });

  describe('Given a request that crosses a window edge and still does not fit once page-aligned', () => {
    describe('When read is called', () => {
      it('Then it bypasses the cache with one direct load at the exact offset and length', async () => {
        // Arrange — windowBytes=100 is far smaller than the 4 KiB page, so
        // aligning offset=4050 down to its page (0) cannot rescue a request
        // that already crosses the 100-byte window.
        const source = fakeSource(5000);
        const load = loaderOver(source);
        const cache = createPackWindowCache({ windowBytes: 100, limitBytes: 4096 });

        // Act
        const result = await cache.read('pack-a', 4050, 90, load);

        // Assert
        expect(Array.from(result)).toEqual(Array.from(source.subarray(4050, 4140)));
        expect(load).toHaveBeenCalledTimes(1);
        expect(load).toHaveBeenCalledWith(4050, 90);
      });
    });
  });

  describe('Given a request longer than the window', () => {
    describe('When read is called', () => {
      it('Then it bypasses the cache with one direct load at the exact offset and length', async () => {
        // Arrange
        const source = fakeSource(5000);
        const load = loaderOver(source);
        const cache = createPackWindowCache({ windowBytes: 256, limitBytes: 4096 });

        // Act
        const result = await cache.read('pack-a', 10, 300, load);

        // Assert
        expect(Array.from(result)).toEqual(Array.from(source.subarray(10, 310)));
        expect(load).toHaveBeenCalledTimes(1);
        expect(load).toHaveBeenCalledWith(10, 300);
      });
    });
  });

  describe('Given a registry-wide limit smaller than one window', () => {
    describe('When read is called', () => {
      it('Then it bypasses the cache with one direct load at the exact offset and length', async () => {
        // Arrange
        const source = fakeSource(5000);
        const load = loaderOver(source);
        const cache = createPackWindowCache({ windowBytes: 256, limitBytes: 100 });

        // Act
        const result = await cache.read('pack-a', 10, 20, load);

        // Assert
        expect(Array.from(result)).toEqual(Array.from(source.subarray(10, 30)));
        expect(load).toHaveBeenCalledTimes(1);
        expect(load).toHaveBeenCalledWith(10, 20);
      });
    });
  });

  describe('Given a window request near the end of a short file', () => {
    describe('When read is called', () => {
      it('Then it returns a short view no longer than the loaded window', async () => {
        // Arrange — the file is 40 bytes; a 256-byte window load clamps at
        // 40, and the request [30, 50) can only be served up to byte 40.
        const source = fakeSource(40);
        const load = loaderOver(source);
        const cache = createPackWindowCache({ windowBytes: 256, limitBytes: 4096 });

        // Act
        const result = await cache.read('pack-a', 30, 20, load);

        // Assert
        expect(Array.from(result)).toEqual(Array.from(source.subarray(30, 40)));
        expect(result.length).toBe(10);
      });
    });
  });

  describe('Given a registry-wide limit that holds only one window at a time', () => {
    describe('When two packs are each read once, then the first pack is read again', () => {
      it('Then the second pack evicts the first, forcing a fresh load on the re-read', async () => {
        // Arrange — one 256-byte window per pack, a 300-byte limit: only one
        // window fits at a time, so loading pack-b's window evicts pack-a's.
        const source = fakeSource(1000);
        const load = loaderOver(source);
        const cache = createPackWindowCache({ windowBytes: 256, limitBytes: 300 });
        await cache.read('pack-a', 0, 10, load);

        // Act
        await cache.read('pack-b', 0, 10, load);
        await cache.read('pack-a', 0, 10, load);

        // Assert — pack-a loaded twice (evicted in between), pack-b once.
        expect(load).toHaveBeenCalledTimes(3);
      });
    });
  });

  describe('Given a populated cache', () => {
    describe('When clear() is called', () => {
      it('Then a subsequent read at the same key issues a fresh load', async () => {
        // Arrange
        const source = fakeSource(1000);
        const load = loaderOver(source);
        const cache = createPackWindowCache({ windowBytes: 256, limitBytes: 4096 });
        await cache.read('pack-a', 0, 10, load);

        // Act
        cache.clear();
        await cache.read('pack-a', 0, 10, load);

        // Assert
        expect(load).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Given two concurrent reads that miss the same uncached window', () => {
    describe('When both are read at once', () => {
      it('Then load is called exactly once, and each read gets its own requested view', async () => {
        // Arrange — both offsets fall inside the same [0, 256) window, so an
        // unsynchronised second miss would start a SECOND load before the
        // first one ever populates the cache.
        const source = fakeSource(1000);
        let releaseLoad: ((value: Uint8Array) => void) | undefined;
        const gate = new Promise<Uint8Array>((resolve) => {
          releaseLoad = resolve;
        });
        const load = vi.fn(async (): Promise<Uint8Array> => gate);
        const cache = createPackWindowCache({ windowBytes: 256, limitBytes: 4096 });

        // Act
        const first = cache.read('pack-a', 10, 20, load);
        const second = cache.read('pack-a', 40, 30, load);
        releaseLoad?.(source.subarray(0, 256));
        const [firstResult, secondResult] = await Promise.all([first, second]);

        // Assert
        expect(load).toHaveBeenCalledTimes(1);
        expect(Array.from(firstResult)).toEqual(Array.from(source.subarray(10, 30)));
        expect(Array.from(secondResult)).toEqual(Array.from(source.subarray(40, 70)));
      });
    });
  });

  describe('Given an in-flight load for a key', () => {
    describe('When clear() runs before the load settles', () => {
      it('Then a read arriving after clear() starts its own fresh load, not the stale in-flight one', async () => {
        // Arrange
        const source = fakeSource(1000);
        let releaseFirstLoad: ((value: Uint8Array) => void) | undefined;
        const firstGate = new Promise<Uint8Array>((resolve) => {
          releaseFirstLoad = resolve;
        });
        const load = vi
          .fn<(base: number, size: number) => Promise<Uint8Array>>()
          .mockImplementationOnce(async () => firstGate)
          .mockImplementation(async (base, size) => source.subarray(base, base + size));
        const cache = createPackWindowCache({ windowBytes: 256, limitBytes: 4096 });
        const stalePending = cache.read('pack-a', 10, 20, load);

        // Act
        cache.clear();
        const fresh = await cache.read('pack-a', 10, 20, load);
        releaseFirstLoad?.(source.subarray(0, 256));
        await stalePending;

        // Assert — the post-clear read did not join the pre-clear in-flight
        // load; it issued its own.
        expect(load).toHaveBeenCalledTimes(2);
        expect(Array.from(fresh)).toEqual(Array.from(source.subarray(10, 30)));
      });
    });
  });
});

describe('packWindowBudgetFor', () => {
  describe('Given a Context with no core.packedGitWindowSize', () => {
    describe('When packWindowBudgetFor is called', () => {
      it('Then windowBytes resolves to the 64 KiB default', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const result = await packWindowBudgetFor(ctx);

        // Assert
        expect(result.windowBytes).toBe(DEFAULT_PACK_WINDOW_BYTES);
      });
    });
  });

  describe('Given core.packedGitWindowSize below the default but not a whole 2×page unit', () => {
    describe('When packWindowBudgetFor is called', () => {
      it('Then windowBytes is normalised up to the nearest 2×page unit, not passed through raw', async () => {
        // Arrange — 4096 is under one 8192-byte unit (2×4 KiB pages), so it
        // floors to 0 units and is bumped to the 1-unit floor, exactly as
        // git normalises `core.packedGitWindowSize` — the config value is
        // NOT the config value's own byte count once git's own rule applies.
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[core]\n\tpackedGitWindowSize = 4096\n');

        // Act
        const result = await packWindowBudgetFor(ctx);

        // Assert
        expect(result.windowBytes).toBe(8192);
      });
    });
  });

  describe("Given core.packedGitWindowSize at the boundary values git's 2×page normalisation treats specially", () => {
    describe('When packWindowBudgetFor is called', () => {
      it.each([
        ['0', 0],
        ['1', 1],
        ['one unit (8192)', 8192],
        ['one unit + 1 (8193)', 8193],
      ])('Then %s normalises to exactly one 8192-byte unit', async (_label, configured) => {
        // Arrange — git: `packed_git_window_size /= pgsz_x2; if (< 1) = 1;
        // packed_git_window_size *= pgsz_x2;` (environment.c, `pgsz_x2` =
        // 2×getpagesize()). 0 and 1 hit the 1-unit floor; 8192 is already
        // exactly one unit; 8193 truncates BACK DOWN into the same unit —
        // never up to a second one. All four collapse to the same 8192,
        // proving floor-with-a-floor, not a plain clamp (which would leave
        // 0, 1, 8192, 8193 each distinct) and not ceiling (which would carry
        // 8193 up to 16384).
        const ctx = createMemoryContext();
        await seedConfig(ctx, `[core]\n\tpackedGitWindowSize = ${configured}\n`);

        // Act
        const result = await packWindowBudgetFor(ctx);

        // Assert
        expect(result.windowBytes).toBe(8192);
      });
    });
  });

  describe('Given core.packedGitWindowSize above the default', () => {
    describe('When packWindowBudgetFor is called', () => {
      it('Then windowBytes is clamped to the default', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[core]\n\tpackedGitWindowSize = 1g\n');

        // Act
        const result = await packWindowBudgetFor(ctx);

        // Assert
        expect(result.windowBytes).toBe(DEFAULT_PACK_WINDOW_BYTES);
      });
    });
  });

  describe('Given core.packedGitWindowSize equal to the default', () => {
    describe('When packWindowBudgetFor is called', () => {
      it('Then windowBytes resolves to the default value', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, `[core]\n\tpackedGitWindowSize = ${DEFAULT_PACK_WINDOW_BYTES}\n`);

        // Act
        const result = await packWindowBudgetFor(ctx);

        // Assert
        expect(result.windowBytes).toBe(DEFAULT_PACK_WINDOW_BYTES);
      });
    });
  });

  describe('Given a Context with no core.packedGitLimit', () => {
    describe('When packWindowBudgetFor is called', () => {
      it('Then limitBytes resolves to the 16 MiB default', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const result = await packWindowBudgetFor(ctx);

        // Assert
        expect(result.limitBytes).toBe(DEFAULT_PACK_WINDOW_LIMIT_BYTES);
      });
    });
  });

  describe('Given core.packedGitLimit below the default', () => {
    describe('When packWindowBudgetFor is called', () => {
      it('Then limitBytes resolves to the config value', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[core]\n\tpackedGitLimit = 1m\n');

        // Act
        const result = await packWindowBudgetFor(ctx);

        // Assert
        expect(result.limitBytes).toBe(1024 * 1024);
      });
    });
  });

  describe('Given core.packedGitLimit above the default', () => {
    describe('When packWindowBudgetFor is called', () => {
      it('Then limitBytes is clamped to the default', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[core]\n\tpackedGitLimit = 1g\n');

        // Act
        const result = await packWindowBudgetFor(ctx);

        // Assert
        expect(result.limitBytes).toBe(DEFAULT_PACK_WINDOW_LIMIT_BYTES);
      });
    });
  });

  describe('Given core.packedGitLimit equal to the default', () => {
    describe('When packWindowBudgetFor is called', () => {
      it('Then limitBytes resolves to the default value', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, `[core]\n\tpackedGitLimit = ${DEFAULT_PACK_WINDOW_LIMIT_BYTES}\n`);

        // Act
        const result = await packWindowBudgetFor(ctx);

        // Assert
        expect(result.limitBytes).toBe(DEFAULT_PACK_WINDOW_LIMIT_BYTES);
      });
    });
  });
});
