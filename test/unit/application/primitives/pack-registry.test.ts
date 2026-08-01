import { describe, expect, it, vi } from 'vitest';
import {
  createPackRegistry,
  nextOffsetForEntry,
  type PackOffsetTable,
} from '../../../../src/application/primitives/pack-registry.js';
import { REASON_PACK_IDX_EXCEEDS_MAX } from '../../../../src/application/primitives/validators.js';
import {
  permissionDenied,
  type TsgitError,
  unsupportedOperation,
} from '../../../../src/domain/error.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import type { DirEntry, FileStat } from '../../../../src/ports/file-system.js';
import { buildSeededContext } from './fixtures.js';
import { withHandleLedger } from './handle-ledger.js';
import { writeSyntheticPack } from './pack-fixture.js';

const dirEntry = (name: string): DirEntry => ({
  name,
  isFile: true,
  isDirectory: false,
  isSymbolicLink: false,
});

function makeStat(): FileStat {
  return {
    ctimeMs: 0,
    mtimeMs: 0,
    dev: 0,
    ino: 0,
    mode: 0o100644,
    uid: 0,
    gid: 0,
    size: 0,
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
  };
}

describe('pack-registry', () => {
  describe('Given a missing pack directory', () => {
    describe('When all() is called', () => {
      it('Then returns an empty array', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = createPackRegistry(ctx);

        // Act
        const result = await sut.all();

        // Assert
        expect(result).toEqual([]);
      });
    });
    describe('When lookup is called', () => {
      it('Then returns undefined', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = createPackRegistry(ctx);

        // Act
        const result = await sut.lookup('a'.repeat(40) as ObjectId);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a readdir entry whose name contains a %s', () => {
    describe('When all() is called', () => {
      it.each([
        ['slash (no dot-dot, no backslash)', 'pac/k.idx'],
        ['backslash (no dot-dot, no slash)', 'pac\\k.idx'],
        ['dot-dot (no slash, no backslash)', 'pa..k.idx'],
      ])('Then loadPack is never reached for the unsafe path', async (_label, badName) => {
        // Arrange
        // Each bad name carries exactly ONE of the three forbidden substrings so a
        // per-operand mutation of `isSafePackName` (`&&` -> `||`, or any operand
        // forced true) lets that specific name through. loadPack's first op is
        // `fs.stat`; tracking stat calls reveals whether the unsafe entry was
        // accepted. The good entry stat is allowed; the bad path must never appear.
        const ctx = await buildSeededContext();
        const statsSeen: string[] = [];
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            exists: async () => true,
            readdir: async (): Promise<ReadonlyArray<DirEntry>> => [
              dirEntry(badName),
              dirEntry('pack-good.idx'),
            ],
            stat: async (path: string): Promise<FileStat> => {
              statsSeen.push(path);
              return makeStat();
            },
            read: async (): Promise<Uint8Array> => {
              throw new Error('parse fail — intentional');
            },
          },
        };
        const sut = createPackRegistry(wrapped);

        // Act
        try {
          await sut.all();
        } catch {
          // parsePackIndex will throw on our fake bytes; that's expected.
        }

        // Assert — good entry is statted; the unsafe one must have been filtered out.
        expect(statsSeen.some((p) => p.includes('pack-good'))).toBe(true);
        expect(statsSeen.some((p) => p.includes(badName))).toBe(false);
      });
    });
  });

  describe('Given an .idx file whose stat reports > MAX_PACK_IDX_BYTES', () => {
    describe('When all() is called', () => {
      it('Then throws INVALID_PACK_INDEX without issuing a read', async () => {
        // Arrange
        // Kills the mutant where the stat size guard is removed — read() would be
        // called and a multi-GiB array would be allocated.
        const ctx = await buildSeededContext();
        const reads: string[] = [];
        const oversized = 64 * 1024 * 1024 + 1;
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            exists: async () => true,
            readdir: async () => [
              { name: 'pack-bomb.idx', isFile: true, isDirectory: false, isSymbolicLink: false },
            ],
            stat: async (p: string) => {
              const base = await ctx.fs.stat(p).catch(() => undefined);
              return { ...(base ?? makeStat()), size: oversized };
            },
            read: async (path: string) => {
              reads.push(path);
              throw new Error('should not be reached');
            },
          },
        };
        const sut = createPackRegistry(wrapped);

        // Act
        let caught: unknown;
        try {
          await sut.all();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeDefined();
        const data = (caught as { data?: { code?: string; reason?: string } }).data;
        expect(data?.code).toBe('INVALID_PACK_INDEX');
        // Assert the SPECIFIC reason: `parsePackIndex` on real bytes would also
        // throw INVALID_PACK_INDEX (bad magic), so the code alone does not pin the
        // pre-read size guard. The reason does.
        expect(data?.reason).toBe(REASON_PACK_IDX_EXCEEDS_MAX);
        expect(reads).toEqual([]);
      });
    });
  });

  describe('Given a cached scan', () => {
    describe('When refresh() is called', () => {
      it('Then the next all() re-scans the pack directory', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ledger = withHandleLedger({
          ...ctx,
          fs: {
            ...ctx.fs,
            exists: async () => true,
            readdir: async (): Promise<ReadonlyArray<DirEntry>> => [],
          },
        });
        const sut = createPackRegistry(ledger.ctx);

        // Act & Assert — first all() scans, the second is served from the cache.
        await sut.all();
        await sut.all();
        // Assert
        expect(ledger.readdirCalls()).toBe(1);

        // refresh() drops the cache, so the next all() re-scans.
        sut.refresh();
        await sut.all();
        expect(ledger.readdirCalls()).toBe(2);
      });
    });
  });

  describe('Given an .idx file whose stat lies (small) but read returns oversized bytes (TOCTOU)', () => {
    describe('When all() is called', () => {
      it('Then throws INVALID_PACK_INDEX after read', async () => {
        // Arrange
        // Kills the mutant where the post-read length check is removed.
        const ctx = await buildSeededContext();
        const oversized = new Uint8Array(64 * 1024 * 1024 + 1);
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            exists: async () => true,
            readdir: async () => [
              { name: 'pack-toctou.idx', isFile: true, isDirectory: false, isSymbolicLink: false },
            ],
            stat: async (p: string) => {
              const base = await ctx.fs.stat(p).catch(() => undefined);
              return { ...(base ?? makeStat()), size: 1 };
            },
            read: async () => oversized,
          },
        };
        const sut = createPackRegistry(wrapped);

        // Act
        let caught: unknown;
        try {
          await sut.all();
        } catch (error) {
          caught = error;
        }

        // Assert
        const data = (caught as { data?: { code?: string; reason?: string } }).data;
        expect(data?.code).toBe('INVALID_PACK_INDEX');
        // Kills the L46 `ConditionalExpression -> false` and `BlockStatement -> {}`
        // mutants: without the post-read length check, the oversized zero-filled
        // buffer reaches `parsePackIndex`, which throws INVALID_PACK_INDEX with a
        // DIFFERENT reason (bad magic). Pinning the exact reason kills both.
        expect(data?.reason).toBe(REASON_PACK_IDX_EXCEEDS_MAX);
      });
    });
  });
});

describe('nextOffsetForEntry', () => {
  describe('Given a table with sortedOffsets=[100, 500, 900], packFileSize=1000, trailerStart=980', () => {
    const table: PackOffsetTable = {
      sortedOffsets: [100, 500, 900],
      packFileSize: 1000,
      trailerStart: 980,
    };

    describe('When nextOffsetForEntry is called with an offset present in sortedOffsets', () => {
      it.each([
        [100, 500], // non-last
        [500, 900], // middle
        [900, 980], // last (returns trailerStart)
      ])('Then offset=%s returns %s', (offset, expected) => {
        // Arrange
        const sut = nextOffsetForEntry;
        // Act
        const result = sut(table, offset);
        // Assert
        expect(result).toBe(expected);
      });
    });

    describe('When nextOffsetForEntry is called with offset=200 (not in sortedOffsets)', () => {
      it('Then throws INVALID_PACK_INDEX with reason containing "offset not in pack index"', () => {
        // Arrange
        const sut = nextOffsetForEntry;
        // Act + Assert
        try {
          sut(table, 200);
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('INVALID_PACK_INDEX');
          if (data.code === 'INVALID_PACK_INDEX') {
            expect(data.reason).toContain('offset not in pack index');
          }
        }
      });
    });
  });

  describe('Given a table with a single sortedOffset=[400], packFileSize=500, trailerStart=480', () => {
    describe('When nextOffsetForEntry is called with offset=400 (single element, both first and last)', () => {
      it('Then returns trailerStart = 480', () => {
        // Arrange
        const table: PackOffsetTable = {
          sortedOffsets: [400],
          packFileSize: 500,
          trailerStart: 480,
        };
        const sut = nextOffsetForEntry;
        // Act
        const result = sut(table, 400);
        // Assert
        expect(result).toBe(480);
      });
    });
  });
});

describe('RegisteredPack.offsetTable — negative trailerStart guard', () => {
  describe('Given a pack file whose size is smaller than the digest length', () => {
    describe('When offsetTable() is called', () => {
      it('Then throws INVALID_PACK_INDEX with reason containing "pack file too small"', async () => {
        // Arrange — stat returns size=10 (< digestLength=20), so trailerStart = 10 - 20 = -10.
        const ctx = await buildSeededContext();
        const content1 = new Uint8Array([1, 2, 3]);
        await writeSyntheticPack(ctx, 'tiny-pack', [
          { kind: 'base', type: 'blob', content: content1 },
        ]);
        const tinySize = 10; // less than digestLength (20 for SHA-1)
        const wrappedCtx = {
          ...ctx,
          fs: {
            ...ctx.fs,
            stat: async (path: string) => {
              const real = await ctx.fs.stat(path);
              // Only override the .pack file stat, not .idx
              if (path.endsWith('.pack')) {
                return { ...real, size: tinySize };
              }
              return real;
            },
          },
        };
        const registry = createPackRegistry(wrappedCtx);
        const packs = await registry.all();
        const pack = packs[0]!;
        const sut = pack.offsetTable;

        // Act
        let caught: unknown;
        try {
          await sut();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeDefined();
        const data = (caught as { data?: { code?: string; reason?: string } }).data;
        expect(data?.code).toBe('INVALID_PACK_INDEX');
        expect(data?.reason).toContain('pack file too small');
      });
    });
  });
});

describe('RegisteredPack.offsetTable — zero trailerStart boundary', () => {
  describe('Given a pack file whose size equals the digest length', () => {
    describe('When offsetTable() is called', () => {
      it('Then admits trailerStart = 0 without throwing', async () => {
        // Arrange — stat the .pack as exactly digestLength bytes, so
        // trailerStart = digestLength - digestLength = 0. The `< 0` guard admits
        // this boundary; a `<= 0` mutant would reject it and throw.
        const ctx = await buildSeededContext();
        const content1 = new Uint8Array([1, 2, 3]);
        await writeSyntheticPack(ctx, 'zero-trailer-pack', [
          { kind: 'base', type: 'blob', content: content1 },
        ]);
        const digestLength = ctx.hashConfig.digestLength;
        const wrappedCtx = {
          ...ctx,
          fs: {
            ...ctx.fs,
            stat: async (path: string) => {
              const real = await ctx.fs.stat(path);
              if (path.endsWith('.pack')) {
                return { ...real, size: digestLength };
              }
              return real;
            },
          },
        };
        const registry = createPackRegistry(wrappedCtx);
        const packs = await registry.all();
        const pack = packs[0]!;
        const sut = pack.offsetTable;

        // Act
        const result = await sut();

        // Assert — the boundary trailerStart === 0 is accepted, not rejected.
        expect(result.trailerStart).toBe(0);
      });
    });
  });
});

describe('RegisteredPack.offsetTable', () => {
  describe('Given a pack with 2 base entries', () => {
    describe('When offsetTable() is called twice', () => {
      it('Then ctx.fs.stat is called exactly once (lazy cache)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content1 = new Uint8Array([10, 20, 30]);
        const content2 = new Uint8Array([40, 50, 60, 70]);
        await writeSyntheticPack(ctx, 'two-entry', [
          { kind: 'base', type: 'blob', content: content1 },
          { kind: 'base', type: 'blob', content: content2 },
        ]);
        const registry = createPackRegistry(ctx);
        const packs = await registry.all();
        const pack = packs[0]!;

        // Replace pack's offsetTable with one that uses a stat-counting fs,
        // but only after all() has already finished (so we don't count loadPack's stat).
        let statCallCount = 0;
        const countingCtx = {
          ...ctx,
          fs: {
            ...ctx.fs,
            stat: async (path: string) => {
              statCallCount += 1;
              return ctx.fs.stat(path);
            },
          },
        };
        const registry2 = createPackRegistry(countingCtx);
        const packs2 = await registry2.all();
        const pack2 = packs2[0]!;
        // Stat was called during loadPack (for readBoundedIdx); reset the counter.
        statCallCount = 0;
        const sut = pack2.offsetTable;

        // Act — call twice; only the first should hit stat
        await sut();
        await sut();

        // Assert — stat called exactly once across both offsetTable() calls
        expect(statCallCount).toBe(1);
        // Verify the pack reference is the same as what we loaded
        expect(pack.name).toBe(pack2.name);
      });
    });

    describe('When offsetTable() is called', () => {
      it('Then sortedOffsets contains both entry offsets in ascending order', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content1 = new Uint8Array([10, 20, 30]);
        const content2 = new Uint8Array([40, 50, 60, 70]);
        await writeSyntheticPack(ctx, 'sorted-offsets', [
          { kind: 'base', type: 'blob', content: content1 },
          { kind: 'base', type: 'blob', content: content2 },
        ]);
        const registry = createPackRegistry(ctx);
        const packs = await registry.all();
        const pack = packs[0]!;
        const sut = pack.offsetTable;

        // Act
        const result = await sut();

        // Assert — two entries, offsets are in ascending order, both > 0
        expect(result.sortedOffsets).toHaveLength(2);
        expect(result.sortedOffsets[0]!).toBeGreaterThan(0);
        expect(result.sortedOffsets[1]!).toBeGreaterThan(result.sortedOffsets[0]!);
      });
    });
  });

  describe('Given a cold pack obtained from all() with the stat counter reset', () => {
    describe('When 8 offsetTable() calls run under Promise.all', () => {
      it('Then ctx.fs.stat was called exactly once and all 8 results are the same object reference', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content1 = new Uint8Array([10, 20, 30]);
        const content2 = new Uint8Array([40, 50, 60, 70]);
        await writeSyntheticPack(ctx, 'concurrent-offset-table', [
          { kind: 'base', type: 'blob', content: content1 },
          { kind: 'base', type: 'blob', content: content2 },
        ]);
        let statCallCount = 0;
        const countingCtx = {
          ...ctx,
          fs: {
            ...ctx.fs,
            stat: async (path: string) => {
              statCallCount += 1;
              return ctx.fs.stat(path);
            },
          },
        };
        const registry = createPackRegistry(countingCtx);
        const packs = await registry.all();
        const pack = packs[0]!;
        // Stat was called during loadPack (for readBoundedIdx); reset the counter
        // so only offsetTable()'s own stat calls are measured.
        statCallCount = 0;
        const sut = pack.offsetTable;

        // Act — 8 concurrent calls under Promise.all
        const results = await Promise.all(Array.from({ length: 8 }, () => sut()));

        // Assert — single-flight: exactly one stat, identical object across all callers
        expect(statCallCount).toBe(1);
        for (const result of results) {
          expect(result).toBe(results[0]);
        }
      });
    });
  });

  describe('Given a pack whose stat makes trailerStart negative', () => {
    describe('When offsetTable() rejects and is called again', () => {
      it('Then stat ran twice and the second rejection carries INVALID_PACK_INDEX with reason containing "pack file too small"', async () => {
        // Arrange — stat returns size=10 (< digestLength=20), so trailerStart = 10 - 20 = -10 each time.
        const ctx = await buildSeededContext();
        const content1 = new Uint8Array([1, 2, 3]);
        await writeSyntheticPack(ctx, 'tiny-pack-retried', [
          { kind: 'base', type: 'blob', content: content1 },
        ]);
        const tinySize = 10; // less than digestLength (20 for SHA-1)
        let statCallCount = 0;
        const wrappedCtx = {
          ...ctx,
          fs: {
            ...ctx.fs,
            stat: async (path: string) => {
              const real = await ctx.fs.stat(path);
              if (path.endsWith('.pack')) {
                statCallCount += 1;
                return { ...real, size: tinySize };
              }
              return real;
            },
          },
        };
        const registry = createPackRegistry(wrappedCtx);
        const packs = await registry.all();
        const pack = packs[0]!;
        const sut = pack.offsetTable;

        // Act
        let firstCaught: unknown;
        try {
          await sut();
        } catch (error) {
          firstCaught = error;
        }
        let secondCaught: unknown;
        try {
          await sut();
        } catch (error) {
          secondCaught = error;
        }

        // Assert — rejection is never memoised: stat runs again on the second call
        expect(firstCaught).toBeDefined();
        expect(statCallCount).toBe(2);
        const data = (secondCaught as { data?: { code?: string; reason?: string } }).data;
        expect(data?.code).toBe('INVALID_PACK_INDEX');
        expect(data?.reason).toContain('pack file too small');
      });
    });
  });
});

describe('RegisteredPack.readSlice — persistent handle (A4)', () => {
  describe('Given a pack read twice via readSlice', () => {
    describe('When the second call runs', () => {
      it('Then openWithNoFollow is called exactly once', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('reuse-content');
        await writeSyntheticPack(ctx, 'reuse-pack', [{ kind: 'base', type: 'blob', content }]);
        const registry = createPackRegistry(ctx);
        const pack = (await registry.all())[0]!;
        const openSpy = vi.spyOn(ctx.fs, 'openWithNoFollow');

        // Act
        await pack.readSlice(0, 4);
        await pack.readSlice(4, 4);

        // Assert — a single persistent handle serves both reads.
        expect(openSpy.mock.calls.length).toBe(1);
      });
    });
  });

  describe('Given a length request that exceeds the remaining pack bytes', () => {
    describe('When readSlice is called', () => {
      it('Then returns exactly the available bytes with no trailing zero-fill', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('short-read-content');
        await writeSyntheticPack(ctx, 'short-read-pack', [{ kind: 'base', type: 'blob', content }]);
        const registry = createPackRegistry(ctx);
        const pack = (await registry.all())[0]!;
        const table = await pack.offsetTable();
        const entryOffset = table.sortedOffsets[0]!;
        const available = table.packFileSize - entryOffset;

        // Act — request far more than the remaining bytes.
        const result = await pack.readSlice(entryOffset, available + 1000);

        // Assert — trimmed to exactly what was read, not the requested length.
        expect(result.length).toBe(available);
      });
    });
  });

  describe('Given an fs whose openWithNoFollow always throws UNSUPPORTED_OPERATION (browser-like)', () => {
    describe('When readSlice is called', () => {
      it('Then falls back to ctx.fs.readSlice and returns correct bytes', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('fallback-content');
        await writeSyntheticPack(ctx, 'fallback-pack', [{ kind: 'base', type: 'blob', content }]);
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            openWithNoFollow: async () => {
              throw unsupportedOperation(
                'openWithNoFollow',
                'browser FS does not support O_NOFOLLOW',
              );
            },
          },
        };
        const registry = createPackRegistry(wrapped);
        const pack = (await registry.all())[0]!;
        const table = await pack.offsetTable();
        const entryOffset = table.sortedOffsets[0]!;
        const sliceLength = table.trailerStart - entryOffset;

        // Act — twice: the second call exercises the handlePromise
        // reset-and-retry path after the first fallback
        const result = await pack.readSlice(entryOffset, sliceLength);
        const secondResult = await pack.readSlice(entryOffset, sliceLength);

        // Assert — the fallback path returns the exact bytes of the direct
        // per-call read, byte-for-byte, on both attempts
        const direct = await ctx.fs.readSlice(pack.packPath, entryOffset, sliceLength);
        expect(result.length).toBe(sliceLength);
        expect(Array.from(result)).toEqual(Array.from(direct));
        expect(Array.from(secondResult)).toEqual(Array.from(direct));
      });
    });
  });
});

describe('RegisteredPack.readSlice — non-UNSUPPORTED_OPERATION failure', () => {
  describe('Given a persistent handle whose read rejects with a non-UNSUPPORTED_OPERATION error (permission denied)', () => {
    describe('When readSlice is called', () => {
      it('Then the error propagates instead of silently falling back to the per-call read', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('propagate-content');
        await writeSyntheticPack(ctx, 'propagate-pack', [{ kind: 'base', type: 'blob', content }]);
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            openWithNoFollow: async (path: string, mode: 'read' | 'write') => {
              const handle = await ctx.fs.openWithNoFollow(path, mode);
              return {
                ...handle,
                read: async () => {
                  throw permissionDenied(path);
                },
              };
            },
          },
        };
        const registry = createPackRegistry(wrapped);
        const pack = (await registry.all())[0]!;

        // Act
        let caught: unknown;
        try {
          await pack.readSlice(0, 4);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        const data = (caught as { data?: { code?: string } }).data;
        expect(data?.code).toBe('PERMISSION_DENIED');
      });
    });
  });
});

describe('RegisteredPack retired reads', () => {
  describe('Given a pack whose persistent handle was closed', () => {
    describe('When readSlice is called after close', () => {
      it('Then it falls back to the per-call read and never re-opens a handle', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('retired-read');
        await writeSyntheticPack(ctx, 'retired-read', [{ kind: 'base', type: 'blob', content }]);
        const ledger = withHandleLedger(ctx);
        const registry = createPackRegistry(ledger.ctx);
        const pack = (await registry.all())[0]!;
        await pack.readSlice(0, 4);
        await pack.close();

        // Act
        const result = await pack.readSlice(0, 4);
        const direct = await ctx.fs.readSlice(pack.packPath, 0, 4);

        // Assert — one open total (never re-opened), the post-close read went
        // through the per-call path, bytes identical
        expect(ledger.opens()).toBe(1);
        expect(ledger.perCallReads()).toBe(1);
        expect(Array.from(result)).toEqual(Array.from(direct));
      });
    });
  });

  describe('Given a slice read still in flight', () => {
    describe('When close is called before the read is awaited', () => {
      it('Then the in-flight read completes with correct bytes (drained before the handle closes)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('drain-in-flight');
        await writeSyntheticPack(ctx, 'drain-in-flight', [{ kind: 'base', type: 'blob', content }]);
        const registry = createPackRegistry(ctx);
        const pack = (await registry.all())[0]!;

        // Act — fire the read, close immediately, then await the read
        const pending = pack.readSlice(0, 4);
        await pack.close();
        const result = await pending;

        // Assert
        const direct = await ctx.fs.readSlice(pack.packPath, 0, 4);
        expect(Array.from(result)).toEqual(Array.from(direct));
      });
    });
  });
});

describe('HandleLedger.outstanding', () => {
  describe('Given a pack read once through the ledger', () => {
    describe('When close() has run', () => {
      it('Then outstanding() was 1 before the close and is 0 after', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('outstanding-arithmetic');
        await writeSyntheticPack(ctx, 'outstanding-arithmetic', [
          { kind: 'base', type: 'blob', content },
        ]);
        const sut = withHandleLedger(ctx);
        const registry = createPackRegistry(sut.ctx);
        const pack = (await registry.all())[0]!;
        await pack.readSlice(0, 4);
        const beforeClose = sut.outstanding();

        // Act
        await pack.close();

        // Assert
        expect(beforeClose).toBe(1);
        expect(sut.outstanding()).toBe(0);
      });
    });
  });
});

describe('RegisteredPack.close', () => {
  describe('Given a pack whose persistent handle was opened via readSlice', () => {
    describe('When close is called twice', () => {
      it('Then it does not throw (idempotent)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('close-idempotent');
        await writeSyntheticPack(ctx, 'close-idempotent', [
          { kind: 'base', type: 'blob', content },
        ]);
        const registry = createPackRegistry(ctx);
        const pack = (await registry.all())[0]!;
        await pack.readSlice(0, 4);

        // Act
        await pack.close();

        // Assert
        await expect(pack.close()).resolves.toBeUndefined();
      });
    });
  });

  describe('Given a pack whose handle was never opened', () => {
    describe('When close is called', () => {
      it('Then it resolves without opening a handle', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('close-never-opened');
        await writeSyntheticPack(ctx, 'close-never-opened', [
          { kind: 'base', type: 'blob', content },
        ]);
        const registry = createPackRegistry(ctx);
        const pack = (await registry.all())[0]!;
        const openSpy = vi.spyOn(ctx.fs, 'openWithNoFollow');

        // Act
        await pack.close();

        // Assert
        expect(openSpy).not.toHaveBeenCalled();
      });
    });
  });
});

describe('PackRegistry.refresh', () => {
  describe('Given a pack that was read once (persistent handle opened)', () => {
    describe('When refresh is called', () => {
      it('Then the outgoing pack handle is closed (no fd leak across refreshes)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'refresh-leak', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('r') },
        ]);
        const ledger = withHandleLedger(ctx);
        const registry = createPackRegistry(ledger.ctx);
        const packs = await registry.all();
        await packs[0]!.readSlice(0, 4);

        // Act
        registry.refresh();
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Assert
        expect(ledger.closes()).toBe(1);
      });
    });
  });
});

describe('PackRegistry.dispose', () => {
  describe('Given two packs that were each read once (persistent handles opened)', () => {
    describe('When dispose is called', () => {
      it('Then closes every loaded pack handle', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'dispose-a', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('a') },
        ]);
        await writeSyntheticPack(ctx, 'dispose-b', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('b') },
        ]);
        const ledger = withHandleLedger(ctx);
        const registry = createPackRegistry(ledger.ctx);
        const packs = await registry.all();
        for (const pack of packs) {
          await pack.readSlice(0, 4);
        }

        // Act
        await registry.dispose();

        // Assert
        expect(ledger.closes()).toBe(2);
      });
    });
  });

  describe('Given a pack whose close() rejects', () => {
    describe('When dispose is called', () => {
      it('Then rethrows the rejection reason', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'dispose-fail', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('f') },
        ]);
        const failure = permissionDenied('/fake/pack/path');
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            openWithNoFollow: async (path: string, mode: 'read' | 'write') => {
              const handle = await ctx.fs.openWithNoFollow(path, mode);
              return {
                ...handle,
                close: async () => {
                  throw failure;
                },
              };
            },
          },
        };
        const registry = createPackRegistry(wrapped);
        const pack = (await registry.all())[0]!;
        await pack.readSlice(0, 4);

        // Act
        let caught: unknown;
        try {
          await registry.dispose();
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBe(failure);
      });
    });
  });

  describe('Given no packs were ever loaded', () => {
    describe('When dispose is called', () => {
      it('Then resolves without scanning the pack directory', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ledger = withHandleLedger(ctx);
        const registry = createPackRegistry(ledger.ctx);

        // Act
        await registry.dispose();

        // Assert
        expect(ledger.readdirCalls()).toBe(0);
      });
    });
  });
});

describe('PackRegistry — single-flight scan', () => {
  describe('Given a registry that never scanned', () => {
    describe('When refresh() is called', () => {
      it('Then it neither throws nor triggers a readdir or a close', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ledger = withHandleLedger(ctx);
        const sut = createPackRegistry(ledger.ctx);

        // Act
        expect(() => sut.refresh()).not.toThrow();

        // Assert
        expect(ledger.readdirCalls()).toBe(0);
        expect(ledger.closes()).toBe(0);
      });
    });
  });

  describe('Given a cold registry over a repo with 2 packs', () => {
    describe('When 8 all() calls run under Promise.all', () => {
      it('Then readdir runs once and every result is the same array reference', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'burst-a', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('a') },
        ]);
        await writeSyntheticPack(ctx, 'burst-b', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('b') },
        ]);
        const ledger = withHandleLedger(ctx);
        const sut = createPackRegistry(ledger.ctx);

        // Act
        const results = await Promise.all(Array.from({ length: 8 }, () => sut.all()));

        // Assert
        expect(ledger.readdirCalls()).toBe(1);
        for (const result of results) {
          expect(result).toBe(results[0]);
        }
      });
    });
  });

  describe('Given the same shape of repo, indexed by a synthetic id', () => {
    describe('When 8 lookup(id) calls run concurrently', () => {
      it('Then every hit carries the identical pack reference and readdir runs once', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const idsA = await writeSyntheticPack(ctx, 'burst-lookup-a', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('a') },
        ]);
        await writeSyntheticPack(ctx, 'burst-lookup-b', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('b') },
        ]);
        const ledger = withHandleLedger(ctx);
        const sut = createPackRegistry(ledger.ctx);
        const id = idsA[0] as ObjectId;

        // Act
        const hits = await Promise.all(Array.from({ length: 8 }, () => sut.lookup(id)));

        // Assert
        expect(ledger.readdirCalls()).toBe(1);
        for (const hit of hits) {
          expect(hit?.pack).toBe(hits[0]?.pack);
        }
      });
    });
  });

  describe('Given a cold registry over a repo with 2 packs (read burst)', () => {
    describe('When each of 8 concurrent all() callers reads every pack in its own result and dispose() is awaited', () => {
      it('Then exactly one handle per pack is opened and none is left outstanding', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'burst-read-a', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('a') },
        ]);
        await writeSyntheticPack(ctx, 'burst-read-b', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('b') },
        ]);
        const ledger = withHandleLedger(ctx);
        const sut = createPackRegistry(ledger.ctx);

        // Act — every one of the 8 racing callers reads every pack in its own
        // result: pre-fix, each caller built its own set and opened its own
        // handle (8 sets × 2 packs); this is the reported crash in unit form.
        const results = await Promise.all(Array.from({ length: 8 }, () => sut.all()));
        await Promise.all(
          results.map((packs) => Promise.all(packs.map((pack) => pack.readSlice(0, 4)))),
        );
        await sut.dispose();

        // Assert
        expect(ledger.opens()).toBe(2);
        expect(ledger.outstanding()).toBe(0);
      });
    });
  });

  describe('Given a gated scan (call 0) in flight', () => {
    describe('When refresh() runs, call 0 settles, the original caller reads a stale pack, and all() runs again', () => {
      it('Then a second scan runs and the stale read never opens a handle', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'gated-refresh', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('r') },
        ]);
        const ledger = withHandleLedger(ctx, { gateReaddir: true });
        const sut = createPackRegistry(ledger.ctx);

        // Act
        const p1 = sut.all();
        await ledger.readdirGate.arrived(0);
        sut.refresh();
        ledger.readdirGate.settle(0);
        const packs = await p1;
        await packs[0]!.readSlice(0, 4);
        // Pre-release call 1's gate: whether or not a second scan happens is
        // exactly what this test observes, so it must not block on that
        // outcome to make progress.
        ledger.readdirGate.settle(1);
        await sut.all();

        // Assert — the second scan ran (a fresh readdir, not the cached
        // pre-refresh one), and the stale, now-retired pack's read never
        // opened a handle.
        expect(ledger.readdirCalls()).toBe(2);
        expect(ledger.opens()).toBe(0);
      });
    });
  });

  describe('Given a gated scan (call 0) in flight', () => {
    describe('When dispose() is started, call 0 settles, and the disposal is awaited', () => {
      it('Then the scan settles before dispose resolves, and a later read by the scan caller opens no handle', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'gated-dispose', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('d') },
        ]);
        const ledger = withHandleLedger(ctx, { gateReaddir: true });
        const sut = createPackRegistry(ledger.ctx);
        const order: string[] = [];

        // Act
        const p1 = sut.all();
        await ledger.readdirGate.arrived(0);
        const scanDone = p1.then(() => {
          order.push('scan-settled');
        });
        const disposal = sut.dispose().then(() => {
          order.push('dispose-resolved');
        });
        ledger.readdirGate.settle(0);
        await Promise.all([scanDone, disposal]);
        const packs = await p1;
        await packs[0]!.readSlice(0, 4);

        // Assert
        expect(order).toEqual(['scan-settled', 'dispose-resolved']);
        expect(ledger.opens()).toBe(0);
        expect(ledger.outstanding()).toBe(0);
      });
    });
  });

  describe('Given a gated scan whose call 0 is failed with PERMISSION_DENIED', () => {
    describe('When all() is awaited', () => {
      it('Then the rejection carries PERMISSION_DENIED and a second all() re-scans and resolves normally', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'gated-retry', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('t') },
        ]);
        const ledger = withHandleLedger(ctx, { gateReaddir: true });
        const sut = createPackRegistry(ledger.ctx);

        // Act
        const p1 = sut.all();
        await ledger.readdirGate.arrived(0);
        ledger.readdirGate.fail(0, permissionDenied('/fake/pack/dir'));
        let caught: unknown;
        try {
          await p1;
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        const p2 = sut.all();
        await ledger.readdirGate.arrived(1);
        ledger.readdirGate.settle(1);
        const packs = await p2;

        // Assert
        const data = (caught as { data?: { code?: string } }).data;
        expect(data?.code).toBe('PERMISSION_DENIED');
        expect(packs).toHaveLength(1);
      });
    });
  });

  describe('Given gated scans', () => {
    describe('When refresh() runs between two overlapping scans and the first is failed while the second settles', () => {
      it('Then the first scan rejects, the second resolves, and a third all() performs no further scan', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'gated-identity', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('i') },
        ]);
        const ledger = withHandleLedger(ctx, { gateReaddir: true });
        const sut = createPackRegistry(ledger.ctx);
        const err = permissionDenied('/fake/pack/dir');

        // Act
        const p1 = sut.all();
        await ledger.readdirGate.arrived(0);
        sut.refresh();
        const p2 = sut.all();
        await ledger.readdirGate.arrived(1);
        ledger.readdirGate.fail(0, err);
        ledger.readdirGate.settle(1);

        let p1Caught: unknown;
        try {
          await p1;
          expect.unreachable();
        } catch (error) {
          p1Caught = error;
        }
        const p2Result = await p2;
        const p3Result = await sut.all();

        // Assert
        expect(p1Caught).toBe(err);
        expect(p2Result).toHaveLength(1);
        expect(p3Result).toBe(p2Result);
        expect(ledger.readdirCalls()).toBe(2);
      });
    });
  });

  describe('Given a gated scan whose call 0 is failed', () => {
    describe('When dispose() is awaited concurrently', () => {
      it('Then it resolves without throwing and closes no handle', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'gated-dispose-fail', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('x') },
        ]);
        const ledger = withHandleLedger(ctx, { gateReaddir: true });
        const sut = createPackRegistry(ledger.ctx);
        const err = permissionDenied('/fake/pack/dir');

        // Act
        const p1 = sut.all();
        // Owned here — the disposal absorbs this same rejection separately;
        // without this the test's own p1 rejection would be unhandled.
        p1.catch(() => {});
        await ledger.readdirGate.arrived(0);
        const disposal = sut.dispose();
        ledger.readdirGate.fail(0, err);

        // Assert
        await expect(disposal).resolves.toBeUndefined();
        expect(ledger.closes()).toBe(0);
      });
    });
  });

  describe('Given a gated scan that is failed while a refresh() ran during it', () => {
    describe('When one macrotask has passed', () => {
      it('Then no unhandledRejection is ever raised', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'gated-unhandled', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('u') },
        ]);
        const ledger = withHandleLedger(ctx, { gateReaddir: true });
        const sut = createPackRegistry(ledger.ctx);
        const err = permissionDenied('/fake/pack/dir');
        let unhandled = false;
        const onUnhandledRejection = (): void => {
          unhandled = true;
        };
        process.on('unhandledRejection', onUnhandledRejection);

        try {
          // Act
          const p1 = sut.all();
          // Owned here — separate from refresh's own () => NO_PACKS handler,
          // which is exactly what this test is pinning.
          p1.catch(() => {});
          await ledger.readdirGate.arrived(0);
          sut.refresh();
          ledger.readdirGate.fail(0, err);
          await new Promise((resolve) => setTimeout(resolve, 0));

          // Assert
          expect(unhandled).toBe(false);
        } finally {
          process.removeListener('unhandledRejection', onUnhandledRejection);
        }
      });
    });
  });
});
