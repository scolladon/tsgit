import { describe, expect, it } from 'vitest';
import {
  createPackRegistry,
  nextOffsetForEntry,
  type PackOffsetTable,
} from '../../../../src/application/primitives/pack-registry.js';
import { REASON_PACK_IDX_EXCEEDS_MAX } from '../../../../src/application/primitives/validators.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import type { DirEntry, FileStat } from '../../../../src/ports/file-system.js';
import { buildSeededContext } from './fixtures.js';
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

        try {
          await sut.all();
        } catch {
          // Assert
          // parsePackIndex will throw on our fake bytes; that's expected.
        }
        // Good entry is statted; the unsafe one must have been filtered out.
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
        let caught: unknown;
        try {
          await sut.all();
        } catch (error) {
          caught = error;
        }
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
        let readdirCalls = 0;
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            exists: async () => true,
            readdir: async (): Promise<ReadonlyArray<DirEntry>> => {
              readdirCalls += 1;
              return [];
            },
          },
        };
        const sut = createPackRegistry(wrapped);

        // Act & Assert — first all() scans, the second is served from the cache.
        await sut.all();
        await sut.all();
        // Assert
        expect(readdirCalls).toBe(1);

        // refresh() drops the cache, so the next all() re-scans.
        sut.refresh();
        await sut.all();
        expect(readdirCalls).toBe(2);
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
        let caught: unknown;
        try {
          await sut.all();
        } catch (error) {
          caught = error;
        }
        const data = (caught as { data?: { code?: string; reason?: string } }).data;
        // Assert
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

    describe('When nextOffsetForEntry is called with offset=100 (non-last)', () => {
      it('Then returns 500', () => {
        // Arrange
        const sut = nextOffsetForEntry;
        // Act
        const result = sut(table, 100);
        // Assert
        expect(result).toBe(500);
      });
    });

    describe('When nextOffsetForEntry is called with offset=500 (middle)', () => {
      it('Then returns 900', () => {
        // Arrange
        const sut = nextOffsetForEntry;
        // Act
        const result = sut(table, 500);
        // Assert
        expect(result).toBe(900);
      });
    });

    describe('When nextOffsetForEntry is called with offset=900 (last)', () => {
      it('Then returns trailerStart = 980', () => {
        // Arrange
        const sut = nextOffsetForEntry;
        // Act
        const result = sut(table, 900);
        // Assert
        expect(result).toBe(980);
      });
    });

    describe('When nextOffsetForEntry is called with offset=200 (not in sortedOffsets)', () => {
      it('Then throws INVALID_PACK_INDEX with reason containing "offset not in pack index"', () => {
        // Arrange
        const sut = nextOffsetForEntry;
        // Act / Assert
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
});
