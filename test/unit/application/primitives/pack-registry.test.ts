import { describe, expect, it } from 'vitest';
import { createPackRegistry } from '../../../../src/application/primitives/pack-registry.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import type { FileStat } from '../../../../src/ports/file-system.js';
import { buildSeededContext } from './fixtures.js';

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
  it('Given a missing pack directory, When all() is called, Then returns an empty array', async () => {
    const ctx = await buildSeededContext();
    const sut = createPackRegistry(ctx);
    const result = await sut.all();
    expect(result).toEqual([]);
  });

  it('Given a missing pack directory, When lookup is called, Then returns undefined', async () => {
    const ctx = await buildSeededContext();
    const sut = createPackRegistry(ctx);
    const result = await sut.lookup('a'.repeat(40) as ObjectId);
    expect(result).toBeUndefined();
  });

  it.each([
    ['slash', 'pack/escape.idx'],
    ['backslash', 'pack\\escape.idx'],
    ['dot-dot', 'pack..idx'],
  ])('Given a readdir entry whose name contains a %s, When all() is called, Then read is never issued for the unsafe path', async (_label, badName) => {
    // Under correct isSafePackName, only the good entry reaches fs.read.
    // Under a mutated predicate that lets the bad name through, fs.read gets
    // called with the unsafe path — that's what this test asserts on.
    const ctx = await buildSeededContext();
    const readsSeen: string[] = [];
    const wrapped = {
      ...ctx,
      fs: {
        ...ctx.fs,
        exists: async () => true,
        readdir: async () => [
          { name: badName, isFile: true, isDirectory: false, isSymbolicLink: false },
          { name: 'pack-good.idx', isFile: true, isDirectory: false, isSymbolicLink: false },
        ],
        read: async (path: string) => {
          readsSeen.push(path);
          throw new Error('parse fail — intentional');
        },
      },
    };
    const sut = createPackRegistry(wrapped);

    try {
      await sut.all();
    } catch {
      // parsePackIndex will throw on our fake bytes; that's expected.
    }
    expect(readsSeen.some((p) => p.includes(badName))).toBe(false);
  });

  it('Given an .idx file whose stat reports > MAX_PACK_IDX_BYTES, When all() is called, Then throws INVALID_PACK_INDEX without issuing a read', async () => {
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
    expect((caught as { data?: { code?: string } }).data?.code).toBe('INVALID_PACK_INDEX');
    expect(reads).toEqual([]);
  });

  it('Given an .idx file whose stat lies (small) but read returns oversized bytes (TOCTOU), When all() is called, Then throws INVALID_PACK_INDEX after read', async () => {
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
    expect((caught as { data?: { code?: string } }).data?.code).toBe('INVALID_PACK_INDEX');
  });
});
