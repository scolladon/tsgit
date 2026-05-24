import { describe, expect, it } from 'vitest';
import { createPackRegistry } from '../../../../src/application/primitives/pack-registry.js';
import { REASON_PACK_IDX_EXCEEDS_MAX } from '../../../../src/application/primitives/validators.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import type { DirEntry, FileStat } from '../../../../src/ports/file-system.js';
import { buildSeededContext } from './fixtures.js';

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
