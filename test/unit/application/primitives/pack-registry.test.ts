import { describe, expect, it, vi } from 'vitest';
import { enumerateObjects } from '../../../../src/application/primitives/enumerate-objects.js';
import {
  createPackRegistry,
  nextOffsetForEntry,
  type PackOffsetTable,
} from '../../../../src/application/primitives/pack-registry.js';
import { getPackRegistry, readObject } from '../../../../src/application/primitives/read-object.js';
import { REASON_PACK_IDX_EXCEEDS_MAX } from '../../../../src/application/primitives/validators.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import {
  fileNotFound,
  permissionDenied,
  type TsgitError,
  unsupportedOperation,
} from '../../../../src/domain/error.js';
import type { Blob, GitObject, ObjectId } from '../../../../src/domain/objects/index.js';
import { PACK_HEADER_SIZE } from '../../../../src/domain/storage/pack-entry.js';
import type { Context } from '../../../../src/ports/context.js';
import type { DirEntry, FileHandle, FileStat } from '../../../../src/ports/file-system.js';
import { buildSeededContext } from './fixtures.js';
import { withHandleLedger } from './handle-ledger.js';
import { restampPackHeader, writeSyntheticPack } from './pack-fixture.js';

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

// Long enough to pass parsePackIndex's truncation guard (header + fanout
// table) but with a magic that can never match, forcing the parser arm
// itself to reject it — the shape a naive length-only guard would miss.
const GARBAGE_IDX_LENGTH = 1032;

function garbageIdxBytes(): Uint8Array {
  return Uint8Array.from({ length: GARBAGE_IDX_LENGTH }, (_, i) => i % 256);
}

/**
 * Write a garbage `.idx` plus a sibling `.pack` (contents irrelevant —
 * scanPacks never reads a pack file's bytes) so the orphan filter is not
 * what these fixtures measure.
 */
async function writeGarbageIdx(ctx: Context, name: string): Promise<void> {
  const dir = `${ctx.layout.gitDir}/objects/pack`;
  await ctx.fs.write(`${dir}/pack-${name}.idx`, garbageIdxBytes());
  await ctx.fs.write(`${dir}/pack-${name}.pack`, new Uint8Array([0]));
}

const blob = (content: string): GitObject => ({
  type: 'blob',
  id: '' as ObjectId,
  content: new TextEncoder().encode(content),
});

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
              dirEntry('pack-good.pack'),
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
      it('Then the pack is skipped without issuing a read', async () => {
        // Arrange
        // Kills the mutant where the stat size guard is removed — read() would be
        // called and a multi-GiB array would be allocated.
        const ctx = await buildSeededContext();
        const reads: string[] = [];
        const oversized = 64 * 1024 * 1024 + 1;
        const warn = vi.fn();
        const wrapped = {
          ...ctx,
          logger: { warn },
          fs: {
            ...ctx.fs,
            exists: async () => true,
            readdir: async () => [
              { name: 'pack-bomb.idx', isFile: true, isDirectory: false, isSymbolicLink: false },
              { name: 'pack-bomb.pack', isFile: true, isDirectory: false, isSymbolicLink: false },
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
        const packs = await sut.all();

        // Assert
        expect(packs).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
        const [, context] = warn.mock.calls[0] ?? [];
        // Assert the SPECIFIC reason: `parsePackIndex` on real bytes would also
        // throw INVALID_PACK_INDEX (bad magic), so the code alone does not pin the
        // pre-read size guard. The reason does.
        expect((context as { reason?: string } | undefined)?.reason).toBe(
          REASON_PACK_IDX_EXCEEDS_MAX,
        );
        expect(reads).toEqual([]);
      });
    });
  });

  describe('Given a cached scan', () => {
    describe('When all() is called twice', () => {
      it('Then the pack directory is scanned once', async () => {
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

        // Act
        await sut.all();
        await sut.all();

        // Assert
        expect(ledger.readdirCalls()).toBe(1);
      });
    });

    describe('When refresh() runs and all() is called again', () => {
      it('Then the pack directory is re-scanned', async () => {
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
        await sut.all();

        // Act
        sut.refresh();
        await sut.all();

        // Assert
        expect(ledger.readdirCalls()).toBe(2);
      });
    });
  });

  describe('Given an .idx file whose stat lies (small) but read returns oversized bytes (TOCTOU)', () => {
    describe('When all() is called', () => {
      it('Then the pack is skipped and the warn carries the post-read reason', async () => {
        // Arrange
        // Kills the mutant where the post-read length check is removed.
        const ctx = await buildSeededContext();
        const oversized = new Uint8Array(64 * 1024 * 1024 + 1);
        const warn = vi.fn();
        const wrapped = {
          ...ctx,
          logger: { warn },
          fs: {
            ...ctx.fs,
            exists: async () => true,
            readdir: async () => [
              { name: 'pack-toctou.idx', isFile: true, isDirectory: false, isSymbolicLink: false },
              { name: 'pack-toctou.pack', isFile: true, isDirectory: false, isSymbolicLink: false },
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
        const packs = await sut.all();

        // Assert
        expect(packs).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
        const [, context] = warn.mock.calls[0] ?? [];
        // Kills the L46 `ConditionalExpression -> false` and `BlockStatement -> {}`
        // mutants: without the post-read length check, the oversized zero-filled
        // buffer reaches `parsePackIndex`, which throws INVALID_PACK_INDEX with a
        // DIFFERENT reason (bad magic). Pinning the exact reason kills both.
        expect((context as { reason?: string } | undefined)?.reason).toBe(
          REASON_PACK_IDX_EXCEEDS_MAX,
        );
      });
    });
  });
});

describe('PackRegistry.scan — per-pack idx degradation and orphan exclusion', () => {
  describe('Given a corrupt .idx with a good sibling pack, alongside a separate valid pack', () => {
    describe('When readObject reads the valid pack oid and all() is called', () => {
      it('Then the object round-trips, all() lists only the good pack, and exactly one warn names the skipped idx', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeGarbageIdx(ctx, 'corrupt');
        const content = new TextEncoder().encode('h6-good-content');
        const ids = await writeSyntheticPack(ctx, 'h6-good', [
          { kind: 'base', type: 'blob', content },
        ]);
        const id = ids[0] as ObjectId;
        const warn = vi.fn();
        const wrapped: Context = { ...ctx, logger: { warn } };
        const sut = getPackRegistry(wrapped);

        // Act
        const object = await readObject(wrapped, id);
        const packs = await sut.all();

        // Assert
        expect(object.type).toBe('blob');
        expect((object as Blob).content).toEqual(content);
        expect(packs).toHaveLength(1);
        expect(packs[0]!.name).toBe('pack-h6-good');
        expect(warn).toHaveBeenCalledTimes(1);
        const [message, context] = warn.mock.calls[0] ?? [];
        expect(message).toBe('packRegistry: skipping unreadable pack index');
        expect(context).toMatchObject({ idx: 'pack-corrupt.idx', code: 'INVALID_PACK_INDEX' });
      });
    });
  });

  describe('Given a corrupt .idx with a good sibling pack, and one object seeded loose', () => {
    describe('When enumerateObjects runs', () => {
      it('Then it resolves and contains the loose oid', async () => {
        // Arrange — a probe that consults registry.all() (not a loose-first read,
        // which never touches the scan and would prove nothing about the fix).
        const ctx = await buildSeededContext();
        await writeGarbageIdx(ctx, 'corrupt-loose');
        const looseId = await writeObject(ctx, blob('h6-loose-content'));

        // Act
        const result = await enumerateObjects(ctx);

        // Assert
        expect(result).toContain(looseId);
      });
    });
  });

  describe('Given a corrupt .idx and nothing else in the store', () => {
    describe('When readObject is called for an arbitrary id and all() is called', () => {
      it('Then readObject rejects with OBJECT_NOT_FOUND and all() resolves empty', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeGarbageIdx(ctx, 'only-corrupt');
        const id = 'b'.repeat(40) as ObjectId;
        const sut = getPackRegistry(ctx);

        // Act
        let caught: unknown;
        try {
          await readObject(ctx, id);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        const packs = await sut.all();

        // Assert
        expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id });
        expect(packs).toEqual([]);
      });
    });
  });

  describe('Given an .idx whose read rejects with PERMISSION_DENIED, with its sibling .pack present', () => {
    describe('When all() is called', () => {
      it('Then the pack is skipped and exactly one warn carries PERMISSION_DENIED', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('h7-content');
        await writeSyntheticPack(ctx, 'h7-locked', [{ kind: 'base', type: 'blob', content }]);
        const warn = vi.fn();
        const wrapped: Context = {
          ...ctx,
          logger: { warn },
          fs: {
            ...ctx.fs,
            read: async (path: string) => {
              if (path.endsWith('.idx')) throw permissionDenied(path);
              return ctx.fs.read(path);
            },
          },
        };
        const sut = createPackRegistry(wrapped);

        // Act
        const packs = await sut.all();

        // Assert
        expect(packs).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
        const [, context] = warn.mock.calls[0] ?? [];
        expect((context as { code?: string } | undefined)?.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given an .idx that vanishes between readdir and stat (concurrent repack), its sibling .pack still listed', () => {
    describe('When all() is called', () => {
      it('Then the pack is skipped and exactly one warn carries FILE_NOT_FOUND', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('h5-race-content');
        await writeSyntheticPack(ctx, 'h5-race', [{ kind: 'base', type: 'blob', content }]);
        const warn = vi.fn();
        const wrapped: Context = {
          ...ctx,
          logger: { warn },
          fs: {
            ...ctx.fs,
            stat: async (path: string) => {
              if (path.endsWith('.idx')) throw fileNotFound(path);
              return ctx.fs.stat(path);
            },
          },
        };
        const sut = createPackRegistry(wrapped);

        // Act
        const packs = await sut.all();

        // Assert
        expect(packs).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
        const [, context] = warn.mock.calls[0] ?? [];
        expect((context as { code?: string } | undefined)?.code).toBe('FILE_NOT_FOUND');
      });
    });
  });

  describe('Given every .idx in the store is faulty', () => {
    describe('When all() is called', () => {
      it('Then it resolves to an empty array without throwing and warns twice', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeGarbageIdx(ctx, 'faulty-one');
        await writeGarbageIdx(ctx, 'faulty-two');
        const warn = vi.fn();
        const sut = createPackRegistry({ ...ctx, logger: { warn } });

        // Act
        const packs = await sut.all();

        // Assert
        expect(packs).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Given an .idx read that rejects with an errno-mapped UNSUPPORTED_OPERATION fault', () => {
    describe('When all() is called', () => {
      it('Then the fault propagates instead of being treated as skippable, and no warn fires', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('emfile-scan-content');
        await writeSyntheticPack(ctx, 'emfile-scan', [{ kind: 'base', type: 'blob', content }]);
        const fault = unsupportedOperation('filesystem', 'EMFILE');
        const warn = vi.fn();
        const wrapped: Context = {
          ...ctx,
          logger: { warn },
          fs: {
            ...ctx.fs,
            read: async (path: string) => {
              if (path.endsWith('.idx')) throw fault;
              return ctx.fs.read(path);
            },
          },
        };
        const sut = createPackRegistry(wrapped);

        // Act
        let caught: unknown;
        try {
          await sut.all();
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual(fault.data);
        expect(warn).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a corrupt .idx with a good sibling pack', () => {
    describe('When lookup is called three times for three different ids', () => {
      it('Then exactly one warn fires — the scan memo holds across lookups', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeGarbageIdx(ctx, 'lookup-cardinality');
        const warn = vi.fn();
        const sut = createPackRegistry({ ...ctx, logger: { warn } });
        const idA = 'a'.repeat(40) as ObjectId;
        const idB = 'b'.repeat(40) as ObjectId;
        const idC = 'c'.repeat(40) as ObjectId;

        // Act
        await sut.lookup(idA);
        await sut.lookup(idB);
        await sut.lookup(idC);

        // Assert
        expect(warn).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given two packs, one whose .pack file is removed after write (an orphaned .idx)', () => {
    describe('When all() is called, then readObject is called for both the orphan and the survivor oid', () => {
      it('Then the orphan is excluded from the generation, its object is not found, the survivor still reads, and exactly one warn names the orphan', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const orphanContent = new TextEncoder().encode('h5-orphan-content');
        const orphanIds = await writeSyntheticPack(ctx, 'h5-orphan', [
          { kind: 'base', type: 'blob', content: orphanContent },
        ]);
        const orphanOid = orphanIds[0] as ObjectId;
        const survivorContent = new TextEncoder().encode('h5-survivor-content');
        const survivorIds = await writeSyntheticPack(ctx, 'h5-survivor', [
          { kind: 'base', type: 'blob', content: survivorContent },
        ]);
        const survivorOid = survivorIds[0] as ObjectId;
        const orphanPackPath = `${ctx.layout.gitDir}/objects/pack/pack-h5-orphan.pack`;
        await ctx.fs.rm(orphanPackPath);
        const warn = vi.fn();
        const wrapped: Context = { ...ctx, logger: { warn } };
        const sut = getPackRegistry(wrapped);

        // Act
        const packs = await sut.all();
        let caughtOrphan: unknown;
        try {
          await readObject(wrapped, orphanOid);
          expect.unreachable();
        } catch (error) {
          caughtOrphan = error;
        }
        const survivorObject = await readObject(wrapped, survivorOid);

        // Assert — (i) the orphan is out of the generation
        expect(packs).toHaveLength(1);
        expect(packs[0]!.name).toBe('pack-h5-survivor');
        // Assert — (ii) the orphan's object is unreachable
        expect((caughtOrphan as TsgitError).data).toEqual({
          code: 'OBJECT_NOT_FOUND',
          id: orphanOid,
        });
        // Assert — (iii) the survivor still reads
        expect(survivorObject.type).toBe('blob');
        expect((survivorObject as Blob).content).toEqual(survivorContent);
        // Assert — (iv) exactly one warn names the orphan
        expect(warn).toHaveBeenCalledTimes(1);
        const [message, context] = warn.mock.calls[0] ?? [];
        expect(message).toBe('packRegistry: skipping pack index with no pack file');
        expect(context).toEqual({ idx: 'pack-h5-orphan.idx' });
      });
    });
  });

  describe('Given a readdir listing where the .pack sibling is a directory entry, not a file', () => {
    describe('When all() is called', () => {
      it('Then the pack is excluded — a directory sibling does not count as the pack file', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('dir-sibling-content');
        await writeSyntheticPack(ctx, 'dir-sibling', [{ kind: 'base', type: 'blob', content }]);
        const wrapped: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            readdir: async (dir: string) => {
              const entries = await ctx.fs.readdir(dir);
              return entries.map((entry) =>
                entry.name === 'pack-dir-sibling.pack'
                  ? { ...entry, isFile: false, isDirectory: true }
                  : entry,
              );
            },
          },
        };
        const sut = createPackRegistry(wrapped);

        // Act
        const packs = await sut.all();

        // Assert
        expect(packs).toEqual([]);
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
    describe('When refresh is called and dispose() is awaited', () => {
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
        await registry.dispose();

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

  describe('Given a pack read once and then refresh()ed', () => {
    describe('When dispose() is awaited', () => {
      it('Then outstanding() is 0 and closes() is 1 at the moment dispose() resolves', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'dispose-drains-refresh', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('d') },
        ]);
        const ledger = withHandleLedger(ctx);
        // Delay the handle's close by a real turn so a dispose() that fails to
        // drain refresh's fire-and-forget close batch observes it still
        // outstanding. The ledger stays the inner layer, so it still counts
        // the completion once the delayed close runs.
        const slowClose = {
          ...ledger.ctx,
          fs: {
            ...ledger.ctx.fs,
            openWithNoFollow: async (path: string, mode: 'read' | 'write') => {
              const handle = await ledger.ctx.fs.openWithNoFollow(path, mode);
              return {
                ...handle,
                close: async () => {
                  await new Promise((resolve) => setTimeout(resolve, 5));
                  await handle.close();
                },
              };
            },
          },
        };
        const registry = createPackRegistry(slowClose);
        const pack = (await registry.all())[0]!;
        await pack.readSlice(0, 4);

        // Act
        registry.refresh();
        await registry.dispose();

        // Assert
        expect(ledger.outstanding()).toBe(0);
        expect(ledger.closes()).toBe(1);
      });
    });
  });
});

describe('PackRegistry.refresh — after dispose', () => {
  describe('Given a disposed registry whose pack was read once', () => {
    describe('When refresh() then all() then readSlice run', () => {
      it('Then the pack directory is not re-scanned and no handle is opened', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'refresh-after-dispose', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('r') },
        ]);
        const ledger = withHandleLedger(ctx);
        const registry = createPackRegistry(ledger.ctx);
        const pack = (await registry.all())[0]!;
        await pack.readSlice(0, 4);
        await registry.dispose();

        // Act
        registry.refresh();
        const packsAfterRefresh = await registry.all();
        await packsAfterRefresh[0]!.readSlice(0, 4);

        // Assert — the one pre-dispose scan and the one pre-dispose open stand alone
        expect(ledger.readdirCalls()).toBe(1);
        expect(ledger.opens()).toBe(1);
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
        let thrown: unknown;
        try {
          sut.refresh();
        } catch (error) {
          thrown = error;
        }

        // Assert
        expect(thrown).toBeUndefined();
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
        expect(hits.every((hit) => hit !== undefined)).toBe(true);
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

describe('PackRegistry — read path after dispose', () => {
  describe('Given a disposed registry that never scanned', () => {
    describe('When all() and lookup() are called', () => {
      it('Then both resolve empty without ever scanning the pack directory', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'disposed-cold', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('c') },
        ]);
        const ledger = withHandleLedger(ctx);
        const sut = createPackRegistry(ledger.ctx);
        await sut.dispose();

        // Act
        const packs = await sut.all();
        const hit = await sut.lookup('0000000000000000000000000000000000000000' as ObjectId);

        // Assert — no scan may start after disposal: its packs would be
        // unreachable from refresh() and dispose(), so nothing could ever
        // close their handles.
        expect(packs).toEqual([]);
        expect(hit).toBeUndefined();
        expect(ledger.readdirCalls()).toBe(0);
        expect(ledger.opens()).toBe(0);
      });
    });
  });

  describe('Given a registry whose pack was read once before dispose()', () => {
    describe('When all() is called after disposal', () => {
      it('Then it returns the same retired set without a new scan or open', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'disposed-warm', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('w') },
        ]);
        const ledger = withHandleLedger(ctx);
        const sut = createPackRegistry(ledger.ctx);
        const before = await sut.all();
        await before[0]!.readSlice(0, 4);
        await sut.dispose();

        // Act
        const after = await sut.all();

        // Assert
        expect(after).toBe(before);
        expect(ledger.readdirCalls()).toBe(1);
        expect(ledger.opens()).toBe(1);
      });
    });
  });
});

describe('PackRegistry.dispose — idempotence', () => {
  describe('Given two packs that were each read once', () => {
    describe('When dispose() is awaited twice', () => {
      it('Then both handles are closed once and the second call resolves', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'dispose-twice-a', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('a') },
        ]);
        await writeSyntheticPack(ctx, 'dispose-twice-b', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('b') },
        ]);
        const ledger = withHandleLedger(ctx);
        const sut = createPackRegistry(ledger.ctx);
        const packs = await sut.all();
        await Promise.all(packs.map((pack) => pack.readSlice(0, 4)));
        await sut.dispose();

        // Act
        let thrown: unknown;
        try {
          await sut.dispose();
        } catch (error) {
          thrown = error;
        }

        // Assert
        expect(thrown).toBeUndefined();
        expect(ledger.closes()).toBe(2);
        expect(ledger.outstanding()).toBe(0);
      });
    });
  });
});

describe('RegisteredPack.readSlice — errno-mapped UNSUPPORTED_OPERATION', () => {
  describe('Given an fs whose openWithNoFollow rejects with UNSUPPORTED_OPERATION from errno mapping (operation "filesystem")', () => {
    describe('When readSlice is called', () => {
      it('Then the fault is rethrown instead of rerouting through the per-call fallback', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('errno-content');
        await writeSyntheticPack(ctx, 'errno-pack', [{ kind: 'base', type: 'blob', content }]);
        const ledger = withHandleLedger({
          ...ctx,
          fs: {
            ...ctx.fs,
            openWithNoFollow: async (): Promise<FileHandle> => {
              throw unsupportedOperation('filesystem', 'EMFILE');
            },
          },
        });
        const sut = createPackRegistry(ledger.ctx);
        const packs = await sut.all();

        // Act
        let caught: unknown;
        try {
          await packs[0]!.readSlice(0, 4);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        const data = (caught as { data?: { code?: string; operation?: string } }).data;
        expect(data?.code).toBe('UNSUPPORTED_OPERATION');
        expect(data?.operation).toBe('filesystem');
        expect(ledger.perCallReads()).toBe(0);
      });
    });
  });

  describe('Given an fs whose openWithNoFollow rejects once with an errno-mapped fault and then recovers', () => {
    describe('When readSlice is called again and dispose() is awaited', () => {
      it('Then the retry re-opens and succeeds and dispose() resolves cleanly', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('recovery-content');
        await writeSyntheticPack(ctx, 'recovery-pack', [{ kind: 'base', type: 'blob', content }]);
        let openCalls = 0;
        const ledger = withHandleLedger({
          ...ctx,
          fs: {
            ...ctx.fs,
            openWithNoFollow: async (path: string, mode: 'read' | 'write'): Promise<FileHandle> => {
              openCalls += 1;
              if (openCalls === 1) throw unsupportedOperation('filesystem', 'EMFILE');
              return ctx.fs.openWithNoFollow(path, mode);
            },
          },
        });
        const registry = createPackRegistry(ledger.ctx);
        const packs = await registry.all();
        const sut = packs[0]!;
        let firstError: unknown;
        try {
          await sut.readSlice(0, 4);
        } catch (error) {
          firstError = error;
        }

        // Act
        const bytes = await sut.readSlice(0, 4);
        let disposeError: unknown;
        try {
          await registry.dispose();
        } catch (error) {
          disposeError = error;
        }

        // Assert — the rejected open was never memoised: the second read
        // re-opened and succeeded, and dispose() closed the recovered handle
        // instead of replaying the stale fault.
        expect((firstError as { data?: { reason?: string } }).data?.reason).toBe('EMFILE');
        expect(bytes.length).toBeGreaterThan(0);
        expect(openCalls).toBe(2);
        expect(ledger.opens()).toBe(1);
        expect(disposeError).toBeUndefined();
        expect(ledger.outstanding()).toBe(0);
      });
    });
  });
});

describe('PackRegistry.lookup — header gate', () => {
  describe('Given a v3 pack whose header objectCount matches its index', () => {
    describe('When lookup resolves a hit and readObject reads the object', () => {
      it('Then the hit exposes a header() resolving the v3 header and the object round-trips', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('v3-header-content');
        const ids = await writeSyntheticPack(ctx, 'v3-header', [
          { kind: 'base', type: 'blob', content },
        ]);
        const id = ids[0] as ObjectId;
        const packPath = `${ctx.layout.gitDir}/objects/pack/pack-v3-header.pack`;
        await restampPackHeader(ctx, packPath, { version: 3 });
        const sut = createPackRegistry(ctx);

        // Act
        const hit = await sut.lookup(id);
        const header = await hit?.pack.header();
        const result = await readObject(ctx, id);

        // Assert
        expect(hit).toBeDefined();
        expect(header).toEqual({ version: 3, objectCount: 1 });
        expect(result.type).toBe('blob');
        expect((result as Blob).content).toEqual(content);
      });
    });
  });

  describe('Given a pack whose index does not claim the requested oid', () => {
    describe('When lookup is called', () => {
      it('Then resolves undefined without probing the header or logging a warning', async () => {
        // Arrange — the pack's header is itself invalid (v99); if the gate were
        // reached it would fail loudly, so a clean undefined here proves the
        // pack was never opened at all.
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('lazy-lookup-content');
        await writeSyntheticPack(ctx, 'lazy-lookup', [{ kind: 'base', type: 'blob', content }]);
        const packPath = `${ctx.layout.gitDir}/objects/pack/pack-lazy-lookup.pack`;
        await restampPackHeader(ctx, packPath, { version: 99 });
        const warn = vi.fn();
        const ledger = withHandleLedger({ ...ctx, logger: { warn } });
        const sut = createPackRegistry(ledger.ctx);
        const absentId = 'a'.repeat(40) as ObjectId;

        // Act
        const result = await sut.lookup(absentId);

        // Assert
        expect(result).toBeUndefined();
        expect(ledger.slices().filter((s) => s.path === packPath)).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a bad pack (invalid header) and a good pack both indexing the same oid, bad pack scanned first', () => {
    describe('When readObject is called for that oid', () => {
      it('Then it skips the bad pack, serves the object from the good pack, and warns exactly once naming the bad pack', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const goodContent = new TextEncoder().encode('sibling-good-content');
        const badContent = new TextEncoder().encode('sibling-bad-content-wrong-bytes');
        const goodIds = await writeSyntheticPack(ctx, 'sibling-good', [
          { kind: 'base', type: 'blob', content: goodContent },
        ]);
        const oidA = goodIds[0] as ObjectId;
        await writeSyntheticPack(ctx, 'sibling-bad', [
          { kind: 'base', type: 'blob', content: badContent, idOverride: oidA },
        ]);
        const badPackPath = `${ctx.layout.gitDir}/objects/pack/pack-sibling-bad.pack`;
        await restampPackHeader(ctx, badPackPath, { version: 99 });
        const orderedNames = ['pack-sibling-bad.idx', 'pack-sibling-good.idx'];
        const observedOrder: string[] = [];
        const warn = vi.fn();
        const wrapped: Context = {
          ...ctx,
          logger: { warn },
          fs: {
            ...ctx.fs,
            readdir: async (dir: string) => {
              const entries = await ctx.fs.readdir(dir);
              const byName = new Map(entries.map((entry) => [entry.name, entry]));
              const ordered = orderedNames.map((name) => byName.get(name)!);
              observedOrder.push(...ordered.map((entry) => entry.name));
              // The reordering above deliberately narrows the listing to the two
              // .idx entries; the sibling .pack files must still be present in
              // what scanPacks sees, or the scan-layer orphan filter excludes
              // both packs before the lookup-layer behaviour under test ever runs.
              const packSiblings = entries.filter((entry) => entry.name.endsWith('.pack'));
              return [...ordered, ...packSiblings];
            },
          },
        };
        const sut = readObject;

        // Act
        const result = await sut(wrapped, oidA);

        // Assert
        expect(observedOrder).toEqual(orderedNames);
        expect(result.type).toBe('blob');
        expect((result as Blob).content).toEqual(goodContent);
        expect(warn).toHaveBeenCalledTimes(1);
        const [message, context] = warn.mock.calls[0] ?? [];
        expect(message).toBe('packRegistry: skipping unusable pack');
        expect(context).toMatchObject({ pack: 'pack-sibling-bad', code: 'INVALID_PACK_HEADER' });
      });
    });
  });

  describe('Given a pack with an invalid header whose index claims the requested oid, and no sibling pack', () => {
    describe('When readObject is called', () => {
      it('Then rejects with OBJECT_NOT_FOUND after warning once', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('only-pack-content');
        const ids = await writeSyntheticPack(ctx, 'only-pack', [
          { kind: 'base', type: 'blob', content },
        ]);
        const id = ids[0] as ObjectId;
        const packPath = `${ctx.layout.gitDir}/objects/pack/pack-only-pack.pack`;
        await restampPackHeader(ctx, packPath, { version: 99 });
        const warn = vi.fn();
        const wrapped: Context = { ...ctx, logger: { warn } };
        const sut = readObject;

        // Act
        let caught: unknown;
        try {
          await sut(wrapped, id);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id });
        expect(warn).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a pack with an invalid header', () => {
    describe('When lookup(id) is called twice', () => {
      it('Then each call re-probes the header and warns again — no negative cache', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('no-negative-cache-content');
        const ids = await writeSyntheticPack(ctx, 'no-negative-cache', [
          { kind: 'base', type: 'blob', content },
        ]);
        const id = ids[0] as ObjectId;
        const packPath = `${ctx.layout.gitDir}/objects/pack/pack-no-negative-cache.pack`;
        await restampPackHeader(ctx, packPath, { version: 99 });
        const warn = vi.fn();
        const ledger = withHandleLedger({ ...ctx, logger: { warn } });
        const sut = createPackRegistry(ledger.ctx);

        // Act
        await sut.lookup(id);
        await sut.lookup(id);

        // Assert
        const probes = ledger
          .slices()
          .filter((s) => s.path === packPath && s.offset === 0 && s.length === PACK_HEADER_SIZE);
        expect(probes).toHaveLength(2);
        expect(warn).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Given a valid v2 pack', () => {
    describe('When lookup(id) is called twice', () => {
      it('Then the header is probed exactly once (memoised on success)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('positive-memo-content');
        const ids = await writeSyntheticPack(ctx, 'positive-memo', [
          { kind: 'base', type: 'blob', content },
        ]);
        const id = ids[0] as ObjectId;
        const packPath = `${ctx.layout.gitDir}/objects/pack/pack-positive-memo.pack`;
        const ledger = withHandleLedger(ctx);
        const sut = createPackRegistry(ledger.ctx);

        // Act
        await sut.lookup(id);
        await sut.lookup(id);

        // Assert
        const probes = ledger
          .slices()
          .filter((s) => s.path === packPath && s.offset === 0 && s.length === PACK_HEADER_SIZE);
        expect(probes).toHaveLength(1);
      });
    });
  });

  describe('Given a pack with a corrupted magic signature', () => {
    describe('When lookup is called', () => {
      it('Then skips the pack and warns with a reason mentioning the magic mismatch', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('bad-magic-content');
        const ids = await writeSyntheticPack(ctx, 'bad-magic', [
          { kind: 'base', type: 'blob', content },
        ]);
        const id = ids[0] as ObjectId;
        const packPath = `${ctx.layout.gitDir}/objects/pack/pack-bad-magic.pack`;
        await restampPackHeader(ctx, packPath, { magic: 0x50414358 }); // 'PACX'
        const warn = vi.fn();
        const sut = createPackRegistry({ ...ctx, logger: { warn } });

        // Act
        const result = await sut.lookup(id);

        // Assert
        expect(result).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
        const [, context] = warn.mock.calls[0] ?? [];
        expect((context as { reason?: string } | undefined)?.reason).toContain('magic');
      });
    });
  });

  describe('Given a pack file truncated to 8 bytes', () => {
    describe('When lookup is called', () => {
      it('Then skips the pack and warns with a reason mentioning truncation', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('short-pack-content');
        const ids = await writeSyntheticPack(ctx, 'short-pack', [
          { kind: 'base', type: 'blob', content },
        ]);
        const id = ids[0] as ObjectId;
        const packPath = `${ctx.layout.gitDir}/objects/pack/pack-short-pack.pack`;
        const bytes = await ctx.fs.read(packPath);
        await ctx.fs.write(packPath, bytes.subarray(0, 8));
        const warn = vi.fn();
        const sut = createPackRegistry({ ...ctx, logger: { warn } });

        // Act
        const result = await sut.lookup(id);

        // Assert
        expect(result).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
        const [, context] = warn.mock.calls[0] ?? [];
        expect((context as { reason?: string } | undefined)?.reason).toContain('truncated');
      });
    });
  });

  describe('Given a v2 pack whose header objectCount disagrees with its index by one', () => {
    describe('When lookup is called', () => {
      it('Then skips the pack and warns with a reason naming both counts', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('count-mismatch-content');
        const ids = await writeSyntheticPack(ctx, 'count-mismatch', [
          { kind: 'base', type: 'blob', content },
        ]);
        const id = ids[0] as ObjectId;
        const packPath = `${ctx.layout.gitDir}/objects/pack/pack-count-mismatch.pack`;
        await restampPackHeader(ctx, packPath, { objectCount: 2 });
        const warn = vi.fn();
        const sut = createPackRegistry({ ...ctx, logger: { warn } });

        // Act
        const result = await sut.lookup(id);

        // Assert
        expect(result).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
        const [, context] = warn.mock.calls[0] ?? [];
        expect((context as { reason?: string } | undefined)?.reason).toBe(
          'object count disagrees with index: pack 2, index 1',
        );
      });
    });
  });

  describe('Given a pack whose header probe rejects PERMISSION_DENIED for the .pack file', () => {
    describe('When readObject is called', () => {
      it('Then skips the pack, rejects with OBJECT_NOT_FOUND, and warns once', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('permission-denied-content');
        const ids = await writeSyntheticPack(ctx, 'permission-denied', [
          { kind: 'base', type: 'blob', content },
        ]);
        const id = ids[0] as ObjectId;
        const warn = vi.fn();
        const wrapped: Context = {
          ...ctx,
          logger: { warn },
          fs: {
            ...ctx.fs,
            readSlice: async (path: string, offset: number, length: number) => {
              if (path.endsWith('.pack')) throw permissionDenied(path);
              return ctx.fs.readSlice(path, offset, length);
            },
          },
        };
        const sut = readObject;

        // Act
        let caught: unknown;
        try {
          await sut(wrapped, id);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id });
        expect(warn).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a pack file unlinked between scan and probe (header probe rejects FILE_NOT_FOUND)', () => {
    describe('When readObject is called', () => {
      it('Then skips the pack, rejects with OBJECT_NOT_FOUND, and warns once', async () => {
        // Arrange — the .pack is still listed by readdir (the sibling check
        // sees it), but a concurrent repack removed it before the probe read.
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('unlinked-content');
        const ids = await writeSyntheticPack(ctx, 'unlinked-pack', [
          { kind: 'base', type: 'blob', content },
        ]);
        const id = ids[0] as ObjectId;
        const warn = vi.fn();
        const wrapped: Context = {
          ...ctx,
          logger: { warn },
          fs: {
            ...ctx.fs,
            readSlice: async (path: string, offset: number, length: number) => {
              if (path.endsWith('.pack')) throw fileNotFound(path);
              return ctx.fs.readSlice(path, offset, length);
            },
          },
        };
        const sut = readObject;

        // Act
        let caught: unknown;
        try {
          await sut(wrapped, id);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id });
        expect(warn).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a pack whose header probe rejects with an errno-mapped UNSUPPORTED_OPERATION fault', () => {
    describe('When lookup is called', () => {
      it('Then the fault propagates instead of being treated as skippable', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('emfile-content');
        const ids = await writeSyntheticPack(ctx, 'emfile-pack', [
          { kind: 'base', type: 'blob', content },
        ]);
        const id = ids[0] as ObjectId;
        const warn = vi.fn();
        const wrapped: Context = {
          ...ctx,
          logger: { warn },
          fs: {
            ...ctx.fs,
            readSlice: async (path: string, offset: number, length: number) => {
              if (path.endsWith('.pack')) throw unsupportedOperation('filesystem', 'EMFILE');
              return ctx.fs.readSlice(path, offset, length);
            },
          },
        };
        const sut = createPackRegistry(wrapped);

        // Act
        let caught: unknown;
        try {
          await sut.lookup(id);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'UNSUPPORTED_OPERATION',
          operation: 'filesystem',
          reason: 'EMFILE',
        });
        expect(warn).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a bad pack and a good pack indexing the same oid, bad pack scanned first', () => {
    describe('When lookup resolves the good hit, its bytes are read, and dispose() is awaited', () => {
      it('Then only the served pack ever opened a handle, and none is left outstanding', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const goodContent = new TextEncoder().encode('ledger-good-content');
        const badContent = new TextEncoder().encode('ledger-bad-content-wrong-bytes');
        const goodIds = await writeSyntheticPack(ctx, 'ledger-good', [
          { kind: 'base', type: 'blob', content: goodContent },
        ]);
        const oidA = goodIds[0] as ObjectId;
        await writeSyntheticPack(ctx, 'ledger-bad', [
          { kind: 'base', type: 'blob', content: badContent, idOverride: oidA },
        ]);
        const badPackPath = `${ctx.layout.gitDir}/objects/pack/pack-ledger-bad.pack`;
        await restampPackHeader(ctx, badPackPath, { version: 99 });
        const orderedNames = ['pack-ledger-bad.idx', 'pack-ledger-good.idx'];
        const ledger = withHandleLedger({
          ...ctx,
          fs: {
            ...ctx.fs,
            readdir: async (dir: string) => {
              const entries = await ctx.fs.readdir(dir);
              const byName = new Map(entries.map((entry) => [entry.name, entry]));
              const ordered = orderedNames.map((name) => byName.get(name)!);
              // Same sibling-preservation note as above: the narrowed listing must
              // still carry the .pack files or the scan-layer orphan filter drops
              // both packs before the lookup-layer skip logic under test runs.
              const packSiblings = entries.filter((entry) => entry.name.endsWith('.pack'));
              return [...ordered, ...packSiblings];
            },
          },
        });
        const sut = createPackRegistry(ledger.ctx);

        // Act
        const hit = await sut.lookup(oidA);
        await hit?.pack.readSlice(0, 4);
        await sut.dispose();

        // Assert
        expect(hit).toBeDefined();
        expect(ledger.opens()).toBe(1);
        expect(ledger.outstanding()).toBe(0);
      });
    });
  });
});
