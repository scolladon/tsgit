import { describe, expect, it, vi } from 'vitest';
import * as configReadMod from '../../../../src/application/primitives/config-read.js';
import { enumerateObjects } from '../../../../src/application/primitives/enumerate-objects.js';
import { probeLooseOid } from '../../../../src/application/primitives/internal/loose-oid-cache.js';
import { packPositionMap } from '../../../../src/application/primitives/internal/pack-positions.js';
import { GIT_DEFAULT_DELTA_BASE_CACHE_LIMIT_BYTES } from '../../../../src/application/primitives/internal/resolve-delta-base-cache-limit.js';
import {
  createPackRegistry,
  isSkippableIdxFault,
  isSkippablePackFault,
  nextOffsetForEntry,
  type PackOffsetTable,
  type RegisteredPack,
} from '../../../../src/application/primitives/pack-registry.js';
import { getPackRegistry, readObject } from '../../../../src/application/primitives/read-object.js';
import { REASON_PACK_IDX_EXCEEDS_MAX } from '../../../../src/application/primitives/validators.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import {
  fileNotFound,
  notADirectory,
  permissionDenied,
  TsgitError,
  unsupportedOperation,
} from '../../../../src/domain/error.js';
import {
  type Blob,
  EMPTY_TREE_OID,
  type GitObject,
  type ObjectId,
  serializeHeader,
} from '../../../../src/domain/objects/index.js';
import type {
  BitmapCheck,
  MidxCheck,
  RevIndexCheck,
} from '../../../../src/domain/storage/error.js';
import {
  computeLooseObjectPath,
  entryOffsets,
  invalidMultiPackIndex,
  invalidPackBitmap,
  invalidPackRevIndex,
  lookupPackIndex,
  parsePackIndex,
  REASON_REV_INDEX_CORRUPT,
} from '../../../../src/domain/storage/index.js';
import { PACK_HEADER_SIZE } from '../../../../src/domain/storage/pack-entry.js';
import type { Context } from '../../../../src/ports/context.js';
import type { DirEntry, FileHandle, FileStat } from '../../../../src/ports/file-system.js';
import { buildMidx, type MidxSpec } from '../../domain/storage/arbitraries.js';
import { buildSeededContext, instrumentedContext } from './fixtures.js';
import { withHandleLedger } from './handle-ledger.js';
import {
  buildSyntheticPack,
  type EntrySpec,
  restampPackHeader,
  writeSyntheticPack,
  writeSyntheticRevIndex,
} from './pack-fixture.js';

vi.mock('../../../../src/domain/storage/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/domain/storage/index.js')>();
  return { ...actual, createLruCache: vi.fn(actual.createLruCache) };
});

const storage = await import('../../../../src/domain/storage/index.js');
const createLruCacheSpy = vi.mocked(storage.createLruCache);

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
        const sut = await createPackRegistry(ctx);

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
        const sut = await createPackRegistry(ctx);

        // Act
        const result = await sut.lookup('a'.repeat(40) as ObjectId);

        // Assert
        expect(result).toBeUndefined();
      });
    });
    describe('When fileNames() is called', () => {
      it('Then returns an empty set', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = await createPackRegistry(ctx);

        // Act
        const result = await sut.fileNames();

        // Assert
        expect(result).toEqual(new Set());
      });
    });
  });

  describe('Given a pack directory whose listing carries sibling marker files', () => {
    describe('When fileNames() is called', () => {
      it('Then returns exactly the regular-file names the scan saw — the same set hasRevIndex/hasBitmap consult', async () => {
        // Arrange — the SAME wrapped-readdir shape the oversized-.idx test
        // below uses, so this exercises the real scan path rather than a
        // second, hand-rolled listing mechanism.
        const ctx = await buildSeededContext();
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            readdir: async () => [
              dirEntry('pack-aaa.idx'),
              dirEntry('pack-aaa.pack'),
              dirEntry('pack-aaa.keep'),
              { ...dirEntry('subdir'), isFile: false, isDirectory: true },
            ],
          },
        };
        const sut = await createPackRegistry(wrapped);

        // Act
        const result = await sut.fileNames();

        // Assert — the directory entry is excluded, only regular files remain.
        expect(result).toEqual(new Set(['pack-aaa.idx', 'pack-aaa.pack', 'pack-aaa.keep']));
      });
    });
  });

  describe('Given a pack directory that exists but whose readdir rejects with FILE_NOT_FOUND', () => {
    describe('When all() is called', () => {
      it('Then returns an empty array', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const dir = `${ctx.layout.gitDir}/objects/pack`;
        await ctx.fs.mkdir(dir);
        const stubCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            readdir: async (path: string) => {
              if (path === dir) throw fileNotFound(dir);
              return ctx.fs.readdir(path);
            },
          },
        };
        const sut = await createPackRegistry(stubCtx);

        // Act
        const result = await sut.all();

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a pack directory that exists but whose readdir rejects with NOT_A_DIRECTORY', () => {
    describe('When all() is called', () => {
      it('Then returns an empty array', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const dir = `${ctx.layout.gitDir}/objects/pack`;
        await ctx.fs.mkdir(dir);
        const stubCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            readdir: async (path: string) => {
              if (path === dir) throw notADirectory(dir);
              return ctx.fs.readdir(path);
            },
          },
        };
        const sut = await createPackRegistry(stubCtx);

        // Act
        const result = await sut.all();

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a pack directory whose readdir rejects with a plain Error carrying no data.code', () => {
    describe('When all() is called', () => {
      it('Then that error propagates unchanged', async () => {
        // Arrange — the absence probe classifies structurally on `data.code`,
        // so a fault with no such shape is not absence and must surface.
        const ctx = await buildSeededContext();
        const dir = `${ctx.layout.gitDir}/objects/pack`;
        await ctx.fs.mkdir(dir);
        const raw = new Error('readdir exploded');
        const stubCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            readdir: async (path: string) => {
              if (path === dir) throw raw;
              return ctx.fs.readdir(path);
            },
          },
        };
        const sut = await createPackRegistry(stubCtx);

        // Act
        let caught: unknown;
        try {
          await sut.all();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBe(raw);
      });
    });
  });

  describe('Given a pack directory that exists but whose readdir rejects with PERMISSION_DENIED', () => {
    describe('When all() is called', () => {
      it('Then it resolves as if the directory were empty, and warns once with the code', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const dir = `${ctx.layout.gitDir}/objects/pack`;
        await ctx.fs.mkdir(dir);
        const warn = vi.fn();
        const stubCtx: Context = {
          ...ctx,
          logger: { warn },
          fs: {
            ...ctx.fs,
            readdir: async (path: string) => {
              if (path === dir) throw permissionDenied(dir);
              return ctx.fs.readdir(path);
            },
          },
        };
        const sut = await createPackRegistry(stubCtx);

        // Act
        const result = await sut.all();

        // Assert
        expect(result).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          'packRegistry: unreadable pack directory',
          expect.objectContaining({ code: 'PERMISSION_DENIED' }),
        );
      });
    });
  });

  describe('PackRegistry — pack directory listing', () => {
    describe('Given a registry whose gate and scan are both exercised', () => {
      describe('When assertLoadable() then lookup() run in sequence', () => {
        it('Then the pack directory is listed exactly once, shared by the gate and the scan', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          await writeSyntheticPack(ctx, 'shared-listing', [
            { kind: 'base', type: 'blob', content: new TextEncoder().encode('a') },
          ]);
          const { ctx: instrumented, calls } = instrumentedContext(ctx);
          const sut = await createPackRegistry(instrumented);

          // Act
          await sut.assertLoadable();
          await sut.lookup('a'.repeat(40) as ObjectId);

          // Assert
          const packDirReaddirCalls = calls().filter(
            (call) => call.method === 'readdir' && call.path.endsWith('/objects/pack'),
          );
          expect(packDirReaddirCalls).toHaveLength(1);
        });
      });
    });

    describe('Given a pack directory listing with no multi-pack-index entry', () => {
      describe('When assertLoadable() runs', () => {
        it('Then the flat midx path is never statted', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          await ctx.fs.mkdir(`${ctx.layout.gitDir}/objects/pack`);
          const { ctx: instrumented, calls } = instrumentedContext(ctx);
          const sut = await createPackRegistry(instrumented);

          // Act
          await sut.assertLoadable();

          // Assert
          const midxStats = calls().filter(
            (call) =>
              call.method === 'stat' && call.path.endsWith('/objects/pack/multi-pack-index'),
          );
          expect(midxStats).toEqual([]);
        });
      });
    });

    describe('Given a pack directory listing naming multi-pack-index', () => {
      describe('When assertLoadable() runs', () => {
        it('Then the flat midx path is statted exactly once', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          await writeMidxBytes(ctx, buildMidx(healthyMidxSpec()));
          const { ctx: instrumented, calls } = instrumentedContext(ctx);
          const sut = await createPackRegistry(instrumented);

          // Act
          await sut.assertLoadable();

          // Assert
          const midxStats = calls().filter(
            (call) =>
              call.method === 'stat' && call.path.endsWith('/objects/pack/multi-pack-index'),
          );
          expect(midxStats).toHaveLength(1);
        });
      });
    });

    describe('Given a pack directory that does not exist yet', () => {
      describe('When lookup runs twice', () => {
        it('Then both resolve as if the directory were empty and nothing is logged', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dir = `${ctx.layout.gitDir}/objects/pack`;
          const warn = vi.fn();
          const stubCtx: Context = {
            ...ctx,
            logger: { warn },
            fs: {
              ...ctx.fs,
              readdir: async (path: string) => {
                if (path === dir) throw fileNotFound(dir);
                return ctx.fs.readdir(path);
              },
            },
          };
          const sut = await createPackRegistry(stubCtx);

          // Act
          const first = await sut.lookup('a'.repeat(40) as ObjectId);
          const second = await sut.lookup('b'.repeat(40) as ObjectId);

          // Assert
          expect(first).toBeUndefined();
          expect(second).toBeUndefined();
          expect(warn).not.toHaveBeenCalled();
        });
      });
    });

    describe.each([
      ['NOT_A_DIRECTORY', () => notADirectory('/repo/.git/objects/pack')],
      ['PERMISSION_DENIED', () => permissionDenied('/repo/.git/objects/pack')],
      ['UNSUPPORTED_OPERATION', () => unsupportedOperation('filesystem', 'EIO')],
    ])('Given a pack directory whose readdir rejects with %s', (code, buildFault) => {
      describe('When lookup runs twice', () => {
        it('Then both resolve as if the directory were empty and exactly one warn carries the code', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dir = `${ctx.layout.gitDir}/objects/pack`;
          await ctx.fs.mkdir(dir);
          const warn = vi.fn();
          const stubCtx: Context = {
            ...ctx,
            logger: { warn },
            fs: {
              ...ctx.fs,
              readdir: async (path: string) => {
                if (path === dir) throw buildFault();
                return ctx.fs.readdir(path);
              },
            },
          };
          const sut = await createPackRegistry(stubCtx);

          // Act
          const first = await sut.lookup('a'.repeat(40) as ObjectId);
          const second = await sut.lookup('b'.repeat(40) as ObjectId);

          // Assert
          expect(first).toBeUndefined();
          expect(second).toBeUndefined();
          expect(warn).toHaveBeenCalledTimes(1);
          expect(warn).toHaveBeenCalledWith(
            'packRegistry: unreadable pack directory',
            expect.objectContaining({ code }),
          );
        });
      });
    });

    describe('Given a pack directory whose readdir rejects with PERMISSION_DENIED and no logger attached', () => {
      describe('When all() is called', () => {
        it('Then it resolves with an empty array', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const dir = `${ctx.layout.gitDir}/objects/pack`;
          await ctx.fs.mkdir(dir);
          const stubCtx: Context = {
            ...ctx,
            fs: {
              ...ctx.fs,
              readdir: async (path: string) => {
                if (path === dir) throw permissionDenied(dir);
                return ctx.fs.readdir(path);
              },
            },
          };
          const sut = await createPackRegistry(stubCtx);

          // Act
          const result = await sut.all();

          // Assert
          expect(result).toEqual([]);
        });
      });
    });
  });

  describe('Given a readdir entry with an unsafe name', () => {
    describe('When all() is called', () => {
      it.each([
        ['a slash (no dot-dot, no backslash)', 'pac/k.idx'],
        ['a backslash (no dot-dot, no slash)', 'pac\\k.idx'],
        ['a dot-dot (no slash, no backslash)', 'pa..k.idx'],
        ['a newline (a control character a log sink would honour)', 'pac\nk.idx'],
        ['a unit separator (0x1f, the last rejected code point)', 'pac\x1fk.idx'],
      ])('Then loadPack is never reached for the name carrying %s', async (_label, badName) => {
        // Arrange
        // Each bad name carries exactly ONE forbidden feature — one of the three
        // path substrings, or one control character — so a per-operand mutation
        // of `isSafePackName` (`&&` -> `||`, or any operand forced true) lets
        // that specific name through. The bad name's own sibling `.pack` is in
        // the listing, so the orphan filter cannot mask the guard: the ONLY
        // thing that can keep the bad `.idx` out of loadPack is `isSafePackName`
        // itself. loadPack's first op is `fs.stat`; tracking stat calls reveals
        // whether the unsafe entry was accepted.
        const ctx = await buildSeededContext();
        const statsSeen: string[] = [];
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            readdir: async (): Promise<ReadonlyArray<DirEntry>> => [
              dirEntry(badName),
              dirEntry(`${badName.slice(0, -'.idx'.length)}.pack`),
              dirEntry('pack-good.idx'),
              dirEntry('pack-good.pack'),
            ],
            stat: async (path: string): Promise<FileStat> => {
              if (!path.endsWith('.idx')) return ctx.fs.stat(path);
              statsSeen.push(path);
              return makeStat();
            },
            read: async (path: string): Promise<Uint8Array> => {
              if (!path.endsWith('.idx')) return ctx.fs.read(path);
              throw new Error('parse fail — intentional');
            },
          },
        };
        const sut = await createPackRegistry(wrapped);

        // Act
        let caught: unknown;
        try {
          await sut.all();
        } catch (error) {
          caught = error;
        }

        // Assert — good entry is statted; the unsafe one must have been filtered
        // out; and the plain (non-TsgitError) read failure propagates rather
        // than being laundered into a per-pack skip.
        expect(statsSeen.some((p) => p.includes('pack-good'))).toBe(true);
        expect(statsSeen.some((p) => p.includes(badName))).toBe(false);
        expect((caught as Error).message).toBe('parse fail — intentional');
      });
    });
  });

  describe('Given a readdir entry whose name contains a space (0x20, the first allowed code point)', () => {
    describe('When all() is called', () => {
      it('Then the entry passes the name guard and loadPack is reached', async () => {
        // Arrange — kills the `< 0x20` -> `<= 0x20` boundary mutant, which
        // would misclassify a space-bearing name as unsafe.
        const ctx = await buildSeededContext();
        const spacedName = 'pack sp.idx';
        const statsSeen: string[] = [];
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            readdir: async (): Promise<ReadonlyArray<DirEntry>> => [
              dirEntry(spacedName),
              dirEntry('pack sp.pack'),
            ],
            stat: async (path: string): Promise<FileStat> => {
              if (!path.endsWith('.idx')) return ctx.fs.stat(path);
              statsSeen.push(path);
              return makeStat();
            },
            read: async (path: string): Promise<Uint8Array> => {
              if (!path.endsWith('.idx')) return ctx.fs.read(path);
              throw new Error('parse fail — intentional');
            },
          },
        };
        const sut = await createPackRegistry(wrapped);

        // Act
        let caught: unknown;
        try {
          await sut.all();
        } catch (error) {
          caught = error;
        }

        // Assert — the spaced name was statted (the guard admitted it) and the
        // planted read failure propagated, proving loadPack genuinely ran.
        expect(statsSeen.some((p) => p.includes(spacedName))).toBe(true);
        expect((caught as Error).message).toBe('parse fail — intentional');
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
            readdir: async () => [
              { name: 'pack-bomb.idx', isFile: true, isDirectory: false, isSymbolicLink: false },
              { name: 'pack-bomb.pack', isFile: true, isDirectory: false, isSymbolicLink: false },
            ],
            stat: async (p: string) => {
              if (!p.endsWith('.idx')) return ctx.fs.stat(p);
              const base = await ctx.fs.stat(p).catch(() => undefined);
              return { ...(base ?? makeStat()), size: oversized };
            },
            read: async (path: string) => {
              reads.push(path);
              throw new Error('should not be reached');
            },
          },
        };
        const sut = await createPackRegistry(wrapped);

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
            readdir: async (): Promise<ReadonlyArray<DirEntry>> => [],
          },
        });
        const sut = await createPackRegistry(ledger.ctx);

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
            readdir: async (): Promise<ReadonlyArray<DirEntry>> => [],
          },
        });
        const sut = await createPackRegistry(ledger.ctx);
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
            readdir: async () => [
              { name: 'pack-toctou.idx', isFile: true, isDirectory: false, isSymbolicLink: false },
              { name: 'pack-toctou.pack', isFile: true, isDirectory: false, isSymbolicLink: false },
            ],
            stat: async (p: string) => {
              if (!p.endsWith('.idx')) return ctx.fs.stat(p);
              const base = await ctx.fs.stat(p).catch(() => undefined);
              return { ...(base ?? makeStat()), size: 1 };
            },
            read: async () => oversized,
          },
        };
        const sut = await createPackRegistry(wrapped);

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
        const sut = await getPackRegistry(wrapped);

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
        const sut = await getPackRegistry(ctx);

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
        const sut = await createPackRegistry(wrapped);

        // Act
        const packs = await sut.all();

        // Assert
        expect(packs).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
        const [, context] = warn.mock.calls[0] ?? [];
        // toStrictEqual: a { code, reason: undefined } leak from the
        // fault-context ternary must fail, not slip past a toEqual.
        expect(context).toStrictEqual({ idx: 'pack-h7-locked.idx', code: 'PERMISSION_DENIED' });
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
        const sut = await createPackRegistry(wrapped);

        // Act
        const packs = await sut.all();

        // Assert
        expect(packs).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
        const [, context] = warn.mock.calls[0] ?? [];
        expect(context).toStrictEqual({ idx: 'pack-h5-race.idx', code: 'FILE_NOT_FOUND' });
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
        const sut = await createPackRegistry({ ...ctx, logger: { warn } });

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
        const sut = await createPackRegistry(wrapped);

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
        const sut = await createPackRegistry({ ...ctx, logger: { warn } });
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
      it('Then the orphan is excluded from the generation, its object is not found, the survivor still reads, and warns twice naming the orphan (one re-scan retry)', async () => {
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
        const sut = await getPackRegistry(wrapped);

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
        // Assert — (iv) warns twice naming the orphan: `sut.all()`'s own
        // scan, plus the object-resolver's own full-miss re-scan retry
        // (pack-miss-rescan.ts) when reading the orphan oid re-scans and
        // finds the SAME orphan .idx again.
        expect(warn).toHaveBeenCalledTimes(2);
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
        const sut = await createPackRegistry(wrapped);

        // Act
        const packs = await sut.all();

        // Assert
        expect(packs).toEqual([]);
      });
    });
  });
});

describe('PackRegistry — lazy pack-index loading', () => {
  describe('Given two healthy packs', () => {
    describe('When createPackRegistry is called and nothing else', () => {
      it('Then no readdir and no .idx read has happened yet — only the repo-settings class check and one shared budget config read', async () => {
        // Arrange — construction validates the repo-settings class first
        // (its own coalesced stat), then resolves the delta-base cache's
        // byte budget (`core.deltaBaseCacheLimit`) and the pack window
        // cache's budget (`core.packedGitWindowSize`/`core.packedGitLimit`)
        // CONCURRENTLY, so their two `readConfig` calls share the SAME
        // in-flight coalesced stat instead of paying one each — the content
        // is read once, and the mtime-freshness stat runs exactly twice
        // total, not three times. The pack directory itself stays untouched
        // until the registry is actually consulted.
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'lazy-cold-a', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('a') },
        ]);
        await writeSyntheticPack(ctx, 'lazy-cold-b', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('b') },
        ]);
        const { ctx: instrumented, calls } = instrumentedContext(ctx);

        // Act
        await createPackRegistry(instrumented);

        // Assert
        expect(calls()).toEqual([
          { method: 'stat', path: '/repo/.git/config' },
          { method: 'readUtf8', path: '/repo/.git/config' },
          { method: 'stat', path: '/repo/.git/config' },
        ]);
      });
    });
  });

  describe('Given two healthy packs and cacheBudgets.deltaBaseCacheMaxBytes supplied', () => {
    describe('When createPackRegistry is called and nothing else', () => {
      it('Then the delta-base budget option reads no configuration, but the window budget still does', async () => {
        // Arrange — the option overrides the delta-base cache's own
        // `core.deltaBaseCacheLimit` config read (skipped entirely by its
        // `??` short-circuit), but the pack window cache has no equivalent
        // override option — it always resolves `core.packedGitWindowSize`/
        // `core.packedGitLimit`, paying one more mtime-freshness stat
        // against the same warm parse cache the repo-settings check filled.
        const base = await buildSeededContext();
        await writeSyntheticPack(base, 'lazy-cold-budget-a', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('a') },
        ]);
        const withBudget: Context = { ...base, cacheBudgets: { deltaBaseCacheMaxBytes: 2048 } };
        const { ctx: instrumented, calls } = instrumentedContext(withBudget);

        // Act
        await createPackRegistry(instrumented);

        // Assert
        expect(calls()).toEqual([
          { method: 'stat', path: '/repo/.git/config' },
          { method: 'readUtf8', path: '/repo/.git/config' },
          { method: 'stat', path: '/repo/.git/config' },
        ]);
      });
    });
  });

  describe('Given two healthy packs', () => {
    describe('When lookup forces the first scan', () => {
      it('Then the readdir precedes every .idx read — the .idx load left scanPacks', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const idsA = await writeSyntheticPack(ctx, 'lazy-order-a', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('a') },
        ]);
        await writeSyntheticPack(ctx, 'lazy-order-b', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('b') },
        ]);
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const sut = await createPackRegistry(instrumented);

        // Act
        await sut.lookup(idsA[0] as ObjectId);

        // Assert
        const readdirIndex = calls().findIndex((call) => call.method === 'readdir');
        const firstIdxReadIndex = calls().findIndex(
          (call) => call.method === 'read' && call.path.endsWith('.idx'),
        );
        expect(readdirIndex).toBeGreaterThanOrEqual(0);
        expect(firstIdxReadIndex).toBeGreaterThan(readdirIndex);
      });
    });
  });

  describe('Given two healthy packs and no multi-pack-index', () => {
    describe('When lookup is called for an id claimed by the first pack', () => {
      it('Then only the first .idx is read — the lazy loop stops at the first hit', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const idsA = await writeSyntheticPack(ctx, 'lazy-fallback-a', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('a') },
        ]);
        await writeSyntheticPack(ctx, 'lazy-fallback-b', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('b') },
        ]);
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const sut = await createPackRegistry(instrumented);

        // Act
        await sut.lookup(idsA[0] as ObjectId);

        // Assert
        const idxReads = calls()
          .filter((call) => call.method === 'read' && call.path.endsWith('.idx'))
          .map((call) => call.path);
        expect(idxReads).toEqual([`${ctx.layout.gitDir}/objects/pack/pack-lazy-fallback-a.idx`]);
      });
    });
  });

  describe('Given a healthy pack with two objects', () => {
    describe('When lookup is called twice for two different oids in the same pack', () => {
      it('Then exactly one .idx read serves both lookups', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'lazy-memoised', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('one') },
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('two') },
        ]);
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const sut = await createPackRegistry(instrumented);

        // Act
        await sut.lookup(ids[0] as ObjectId);
        await sut.lookup(ids[1] as ObjectId);

        // Assert
        const idxReads = calls().filter(
          (call) => call.method === 'read' && call.path.endsWith('.idx'),
        );
        expect(idxReads).toHaveLength(1);
      });
    });
  });

  describe('Given one healthy pack and one same-length garbage .idx', () => {
    describe('When all() is called', () => {
      it('Then all() lists only the healthy pack, identical to today', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'lazy-membership-healthy', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('good') },
        ]);
        await writeGarbageIdx(ctx, 'lazy-membership-garbage');
        const sut = await createPackRegistry(ctx);

        // Act
        const packs = await sut.all();

        // Assert
        expect(packs.map((pack) => pack.name)).toEqual(['pack-lazy-membership-healthy']);
      });
    });

    describe('When indexFaults() is called without any prior lookup or all()', () => {
      it('Then it reports the garbage index alone, at the index layer', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'lazy-complete-healthy', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('good') },
        ]);
        await writeGarbageIdx(ctx, 'lazy-complete-garbage');
        const sut = await createPackRegistry(ctx);

        // Act
        const faults = await sut.indexFaults();

        // Assert
        expect(faults).toHaveLength(1);
        expect(faults[0]!.layer).toBe('index');
        expect(faults[0]!.data.code).toBe('INVALID_PACK_INDEX');
      });
    });

    describe('When all(), then indexFaults(), then health() are each called in turn', () => {
      it('Then the unreadable-index warn fires exactly once', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'lazy-warn-once-healthy', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('good') },
        ]);
        await writeGarbageIdx(ctx, 'lazy-warn-once-garbage');
        const warn = vi.fn();
        const sut = await createPackRegistry({ ...ctx, logger: { warn } });

        // Act
        await sut.all();
        await sut.indexFaults();
        await sut.health();

        // Assert
        expect(warn).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given an .idx file whose stat reports > MAX_PACK_IDX_BYTES', () => {
    describe('When indexFaults() is called', () => {
      it('Then it reports the size-guard reason without ever issuing a read', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const reads: string[] = [];
        const oversized = 64 * 1024 * 1024 + 1;
        const wrapped: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            readdir: async () => [
              {
                name: 'pack-lazy-bomb.idx',
                isFile: true,
                isDirectory: false,
                isSymbolicLink: false,
              },
              {
                name: 'pack-lazy-bomb.pack',
                isFile: true,
                isDirectory: false,
                isSymbolicLink: false,
              },
            ],
            stat: async (p: string) => {
              if (!p.endsWith('.idx')) return ctx.fs.stat(p);
              const base = await ctx.fs.stat(p).catch(() => undefined);
              return { ...(base ?? makeStat()), size: oversized };
            },
            read: async (path: string) => {
              reads.push(path);
              throw new Error('should not be reached');
            },
          },
        };
        const sut = await createPackRegistry(wrapped);

        // Act
        const faults = await sut.indexFaults();

        // Assert
        expect(faults).toHaveLength(1);
        expect((faults[0]!.data as { reason?: string }).reason).toBe(REASON_PACK_IDX_EXCEEDS_MAX);
        expect(reads).toEqual([]);
      });
    });
  });

  describe('Given an .idx whose first read rejects with PERMISSION_DENIED and then recovers', () => {
    describe('When all() is called, refresh() runs, and all() is called again', () => {
      it('Then the pack returns to accessible and a second .idx read is issued', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'lazy-not-memoised', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('recover') },
        ]);
        const idxPath = `${ctx.layout.gitDir}/objects/pack/pack-lazy-not-memoised.idx`;
        let failNextIdxRead = true;
        const { ctx: instrumented, calls } = instrumentedContext({
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async (path: string) => {
              if (path === idxPath && failNextIdxRead) {
                failNextIdxRead = false;
                throw permissionDenied(path);
              }
              return ctx.fs.read(path);
            },
          },
        });
        const sut = await createPackRegistry(instrumented);

        // Act
        const before = await sut.all();
        sut.refresh();
        const after = await sut.all();

        // Assert
        expect(before).toEqual([]);
        expect(after.map((pack) => pack.name)).toEqual(['pack-lazy-not-memoised']);
        const idxReads = calls().filter((call) => call.method === 'read' && call.path === idxPath);
        expect(idxReads).toHaveLength(2);
      });
    });
  });

  describe('Given an .idx read that rejects with an errno-mapped UNSUPPORTED_OPERATION fault', () => {
    describe('When all() is called', () => {
      it('Then all() rejects instead of treating the fault as skippable', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'lazy-unrecognised-fault', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('u') },
        ]);
        const fault = unsupportedOperation('filesystem', 'EMFILE');
        const wrapped: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async (path: string) => {
              if (path.endsWith('.idx')) throw fault;
              return ctx.fs.read(path);
            },
          },
        };
        const sut = await createPackRegistry(wrapped);

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
      });
    });
  });

  describe('Given a pack whose header objectCount disagrees with its lazily loaded index', () => {
    describe('When health() is called', () => {
      it('Then health() reports the pack layer with a reason naming both counts', async () => {
        // Arrange — proves header() still awaits index() under the lazy load.
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'lazy-header-cross-check', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('h') },
        ]);
        const packPath = `${ctx.layout.gitDir}/objects/pack/pack-lazy-header-cross-check.pack`;
        await restampPackHeader(ctx, packPath, { objectCount: 2 });
        const sut = await createPackRegistry(ctx);

        // Act
        const result = await sut.health();

        // Assert
        const entry = result.unusable[0]!;
        expect(entry.layer).toBe('pack');
        expect((entry.data as { reason?: string }).reason).toBe(
          'object count disagrees with index: pack 2, index 1',
        );
      });
    });
  });

  describe('Given a healthy pack', () => {
    describe('When readObject reads its one packed object end to end', () => {
      it('Then the bytes round-trip unchanged through the lazily loaded index', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('lazy-round-trip-content');
        const ids = await writeSyntheticPack(ctx, 'lazy-round-trip', [
          { kind: 'base', type: 'blob', content },
        ]);
        const id = ids[0] as ObjectId;

        // Act
        const result = await readObject(ctx, id);

        // Assert
        expect(result.type).toBe('blob');
        expect((result as Blob).content).toEqual(content);
      });
    });
  });

  describe('Given a healthy pack that was looked up before dispose()', () => {
    describe('When dispose() runs and all() is called afterward', () => {
      it('Then all() returns the retired set without a new readdir', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'lazy-dispose-then-all', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('d') },
        ]);
        const id = ids[0] as ObjectId;
        const ledger = withHandleLedger(ctx);
        const sut = await createPackRegistry(ledger.ctx);
        await sut.lookup(id);
        const readdirCallsBeforeDispose = ledger.readdirCalls();

        // Act
        await sut.dispose();
        const packs = await sut.all();

        // Assert
        expect(packs.map((pack) => pack.name)).toEqual(['pack-lazy-dispose-then-all']);
        expect(ledger.readdirCalls()).toBe(readdirCallsBeforeDispose);
      });
    });
  });

  describe('Given a registry that never scanned', () => {
    describe('When dispose() runs and all() is called afterward', () => {
      it('Then all() resolves empty without ever scanning the pack directory', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'lazy-dispose-cold', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('c') },
        ]);
        const ledger = withHandleLedger(ctx);
        const sut = await createPackRegistry(ledger.ctx);

        // Act
        await sut.dispose();
        const packs = await sut.all();

        // Assert
        expect(packs).toEqual([]);
        expect(ledger.readdirCalls()).toBe(0);
      });
    });
  });
});

describe('PackRegistry.lookup — lazy index loading without a multi-pack-index', () => {
  describe('Given three healthy packs and no multi-pack-index', () => {
    describe('When lookup is called for an id claimed by the first pack', () => {
      it('Then exactly one .idx is read — the other two are never touched', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const idsA = await writeSyntheticPack(ctx, 'lazy3-a', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('a') },
        ]);
        await writeSyntheticPack(ctx, 'lazy3-b', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('b') },
        ]);
        await writeSyntheticPack(ctx, 'lazy3-c', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('c') },
        ]);
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const sut = await createPackRegistry(instrumented);

        // Act
        const hit = await sut.lookup(idsA[0] as ObjectId);

        // Assert
        expect(hit?.pack.name).toBe('pack-lazy3-a');
        const idxReads = calls()
          .filter((call) => call.method === 'read' && call.path.endsWith('.idx'))
          .map((call) => call.path);
        expect(idxReads).toEqual([`${ctx.layout.gitDir}/objects/pack/pack-lazy3-a.idx`]);
      });
    });
  });

  describe('Given the first pack of two carries a corrupt .idx and the second claims the requested oid', () => {
    describe('When lookup is called', () => {
      it('Then it warns once for the corrupt index and serves the hit from the second pack', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeGarbageIdx(ctx, 'lazy2-corrupt-a');
        const idsB = await writeSyntheticPack(ctx, 'lazy2-good-b', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('good') },
        ]);
        const warn = vi.fn();
        const sut = await createPackRegistry({ ...ctx, logger: { warn } });

        // Act
        const hit = await sut.lookup(idsB[0] as ObjectId);

        // Assert
        expect(hit?.pack.name).toBe('pack-lazy2-good-b');
        expect(warn).toHaveBeenCalledTimes(1);
        const [message, context] = warn.mock.calls[0] ?? [];
        expect(message).toBe('packRegistry: skipping unreadable pack index');
        expect(context).toMatchObject({ idx: 'pack-lazy2-corrupt-a.idx' });
      });
    });

    describe('When lookup is called, then health() is called', () => {
      it('Then health() warns nothing new for the .idx the lookup already warned about', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeGarbageIdx(ctx, 'lazy2-corrupt-c');
        const idsD = await writeSyntheticPack(ctx, 'lazy2-good-d', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('good') },
        ]);
        const warn = vi.fn();
        const sut = await createPackRegistry({ ...ctx, logger: { warn } });

        // Act
        await sut.lookup(idsD[0] as ObjectId);
        const health = await sut.health();

        // Assert — the same corrupt .idx the lazy lookup already warned about
        // is not warned a second time when health() forces the full scan.
        expect(health.accessible.map((pack) => pack.name)).toEqual(['pack-lazy2-good-d']);
        expect(warn).toHaveBeenCalledTimes(1);
      });
    });
  });
});

describe('resolveIndexes — ordered parallel load', () => {
  describe('Given four packs whose .idx reads complete in the reverse of candidate order', () => {
    describe('When all() is called', () => {
      it('Then the accessible list and the warn order both follow candidate order, not completion order', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeGarbageIdx(ctx, 'ord-a');
        await writeSyntheticPack(ctx, 'ord-b', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('b') },
        ]);
        await writeGarbageIdx(ctx, 'ord-c');
        await writeSyntheticPack(ctx, 'ord-d', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('d') },
        ]);
        const delayByIdxName: Readonly<Record<string, number>> = {
          'pack-ord-a.idx': 30,
          'pack-ord-b.idx': 20,
          'pack-ord-c.idx': 10,
          'pack-ord-d.idx': 0,
        };
        const delayed: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async (path: string) => {
              const delay = delayByIdxName[path.split('/').pop() ?? path];
              if (delay !== undefined) await new Promise((resolve) => setTimeout(resolve, delay));
              return ctx.fs.read(path);
            },
          },
        };
        const warn = vi.fn();
        const sut = await createPackRegistry({ ...delayed, logger: { warn } });

        // Act
        const packs = await sut.all();

        // Assert — pack-ord-d's read completes first and pack-ord-a's last,
        // yet both the accessible list and the warn order stay in candidate
        // (scan) order.
        expect(packs.map((pack) => pack.name)).toEqual(['pack-ord-b', 'pack-ord-d']);
        expect(warn.mock.calls.map(([, context]) => (context as { idx: string }).idx)).toEqual([
          'pack-ord-a.idx',
          'pack-ord-c.idx',
        ]);
      });
    });
  });
});

describe('resolveIndexes — fatal faults surface in candidate order', () => {
  describe('Given two packs whose .idx reads reject with different FATAL faults, the later candidate completing first', () => {
    describe('When all() is called', () => {
      it("Then the earlier candidate's fault surfaces, not whichever completed first", async () => {
        // Arrange — a fatal (non-skippable) fault must never escape a
        // worker mid-fan-out and win Promise.all's completion-order race;
        // it is captured as an outcome and rethrown during the ordered
        // walk, so the FIRST candidate's fault always wins regardless of
        // which read settles first.
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'fatal-order-a', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('a') },
        ]);
        await writeSyntheticPack(ctx, 'fatal-order-b', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('b') },
        ]);
        const delayByIdxName: Readonly<Record<string, number>> = {
          'pack-fatal-order-a.idx': 20,
          'pack-fatal-order-b.idx': 0,
        };
        const wrapped: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async (path: string) => {
              const name = path.split('/').pop() ?? path;
              const delay = delayByIdxName[name];
              if (delay !== undefined) await new Promise((resolve) => setTimeout(resolve, delay));
              if (name === 'pack-fatal-order-a.idx') {
                throw unsupportedOperation('idx-fault-a', 'boom-a');
              }
              if (name === 'pack-fatal-order-b.idx') {
                throw unsupportedOperation('idx-fault-b', 'boom-b');
              }
              return ctx.fs.read(path);
            },
          },
        };
        const sut = await createPackRegistry(wrapped);

        // Act
        let caught: unknown;
        try {
          await sut.all();
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert — pack-fatal-order-b's read completes first (0ms delay),
        // yet pack-fatal-order-a's fault (the earlier candidate) is what
        // surfaces.
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('UNSUPPORTED_OPERATION');
        if (data.code !== 'UNSUPPORTED_OPERATION') {
          expect.fail(`expected UNSUPPORTED_OPERATION, got ${data.code}`);
        }
        expect(data.operation).toBe('idx-fault-a');
      });
    });
  });
});

describe('PackRegistry.lookup — settled indexes walk synchronously', () => {
  describe("Given a registry whose generation already settled every pack's index", () => {
    describe('When lookup() misses every pack', () => {
      it("Then no pack's index() is called again — the settled snapshot is walked without a per-pack await", async () => {
        // Arrange — all() forces generation.indexed to settle; the spies
        // installed AFTER that only trip if lookup() re-invokes index()
        // itself, not merely because index() was ever called at all.
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'settled-miss-a', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('a') },
        ]);
        await writeSyntheticPack(ctx, 'settled-miss-b', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('b') },
        ]);
        const registry = await createPackRegistry(ctx);
        const packs = await registry.all();
        const indexSpies = packs.map((pack) => vi.spyOn(pack, 'index'));
        const missingId = 'ffffffffffffffffffffffffffffffffffffffff' as ObjectId;

        // Act
        const hit = await registry.lookup(missingId);

        // Assert
        expect(hit).toBeUndefined();
        for (const spy of indexSpies) {
          expect(spy).not.toHaveBeenCalled();
        }
      });
    });
  });

  describe('Given a no-midx registry whose unclaimed packs have all settled their own index() through a prior miss, with all()/health() never forced', () => {
    describe('When a further lookup runs', () => {
      it("Then it takes the settled walk passively — no pack's index() is called again", async () => {
        // Arrange — a genuine full miss walks EVERY unclaimed pack in
        // candidate order (none matches, so none short-circuits), settling
        // each one's own index() organically. all()/health() is never
        // called — the plain read-walk shape (log, checkout, diff).
        const ctx = await buildSeededContext();
        const packCount = 5;
        const ids: ObjectId[] = [];
        for (let p = 0; p < packCount; p += 1) {
          const [id] = await writeSyntheticPack(ctx, `settle-promote-${p}`, [
            {
              kind: 'base',
              type: 'blob',
              content: new TextEncoder().encode(`settle-promote-${p}`),
            },
          ]);
          ids.push(id as ObjectId);
        }
        const registry = await createPackRegistry(ctx);
        const missingId = 'f'.repeat(40) as ObjectId;
        await registry.lookup(missingId); // walks and settles every unclaimed pack

        const packs: RegisteredPack[] = [];
        for (const id of ids) {
          const hit = await registry.lookup(id);
          packs.push(hit!.pack);
        }
        const indexSpies = packs.map((pack) => vi.spyOn(pack, 'index'));

        // Act
        const missAgain = await registry.lookup(missingId);

        // Assert
        expect(missAgain).toBeUndefined();
        for (const spy of indexSpies) {
          expect(spy).not.toHaveBeenCalled();
        }
      });
    });
  });
});

describe('createPackRegistry — one config read for both cache budgets', () => {
  describe('Given a fresh registry construction', () => {
    describe('When createPackRegistry resolves', () => {
      it('Then the delta-base and window budgets share one coalesced config stat, not their own two', async () => {
        // Arrange — assertRepoSettingsValid's own pair (maxTreeDepth +
        // deltaBaseCacheLimit, fanned out via its own Promise.all) pays one
        // coalesced stat; reading the delta-base and window budgets
        // CONCURRENTLY must pay exactly one more — never a third,
        // sequential stat for the window budget alone.
        const ctx = await buildSeededContext();
        const statSpy = vi.spyOn(ctx.fs, 'stat');
        statSpy.mockClear();

        // Act
        await createPackRegistry(ctx);

        // Assert
        expect(statSpy).toHaveBeenCalledTimes(2);
      });
    });
  });
});

describe('PackRegistry.health — per-pack accessibility', () => {
  describe('Given one healthy pack', () => {
    describe('When health() is called', () => {
      it('Then the pack is accessible and nothing is unusable', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('health-healthy-content');
        await writeSyntheticPack(ctx, 'health-healthy', [{ kind: 'base', type: 'blob', content }]);
        const sut = await createPackRegistry(ctx);

        // Act
        const result = await sut.health();

        // Assert
        expect(result.accessible.map((pack) => pack.name)).toEqual(['pack-health-healthy']);
        expect(result.unusable).toEqual([]);
      });
    });
  });

  describe('Given a pack whose header reports an unsupported version', () => {
    describe('When health() is called', () => {
      it('Then the pack is unusable at the pack layer with the version reason', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('health-v99-content');
        await writeSyntheticPack(ctx, 'health-v99', [{ kind: 'base', type: 'blob', content }]);
        const packPath = `${ctx.layout.gitDir}/objects/pack/pack-health-v99.pack`;
        await restampPackHeader(ctx, packPath, { version: 99 });
        const sut = await createPackRegistry(ctx);

        // Act
        const result = await sut.health();

        // Assert
        expect(result.accessible).toEqual([]);
        expect(result.unusable).toHaveLength(1);
        const entry = result.unusable[0]!;
        expect(entry.layer).toBe('pack');
        expect(entry.data.code).toBe('INVALID_PACK_HEADER');
        expect((entry.data as { reason?: string }).reason).toContain(
          'unsupported version: expected 2 or 3, got 99',
        );
      });
    });
  });

  describe('Given a pack whose header objectCount disagrees with its index', () => {
    describe('When health() is called', () => {
      it('Then the pack is unusable with a reason naming both counts', async () => {
        // Arrange — isolates the header/index cross-check from parsePackHeader's
        // own throws (magic/version/truncation), which are distinct code paths.
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('health-count-mismatch-content');
        await writeSyntheticPack(ctx, 'health-count-mismatch', [
          { kind: 'base', type: 'blob', content },
        ]);
        const packPath = `${ctx.layout.gitDir}/objects/pack/pack-health-count-mismatch.pack`;
        await restampPackHeader(ctx, packPath, { objectCount: 2 });
        const sut = await createPackRegistry(ctx);

        // Act
        const result = await sut.health();

        // Assert
        expect(result.accessible).toEqual([]);
        const entry = result.unusable[0]!;
        expect(entry.layer).toBe('pack');
        expect((entry.data as { reason?: string }).reason).toBe(
          'object count disagrees with index: pack 2, index 1',
        );
      });
    });
  });

  describe('Given a pack with an invalid magic signature', () => {
    describe('When health() is called', () => {
      it('Then the pack is unusable with an invalid-magic reason', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('health-bad-magic-content');
        await writeSyntheticPack(ctx, 'health-bad-magic', [
          { kind: 'base', type: 'blob', content },
        ]);
        const packPath = `${ctx.layout.gitDir}/objects/pack/pack-health-bad-magic.pack`;
        await restampPackHeader(ctx, packPath, { magic: 0x5041435a });
        const sut = await createPackRegistry(ctx);

        // Act
        const result = await sut.health();

        // Assert
        const entry = result.unusable[0]!;
        expect(entry.layer).toBe('pack');
        expect((entry.data as { reason?: string }).reason).toContain('invalid magic');
      });
    });
  });

  describe('Given a pack file truncated below the 12-byte header', () => {
    describe('When health() is called', () => {
      it('Then the pack is unusable with a truncated reason', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('health-short-pack-content');
        await writeSyntheticPack(ctx, 'health-short-pack', [
          { kind: 'base', type: 'blob', content },
        ]);
        const packPath = `${ctx.layout.gitDir}/objects/pack/pack-health-short-pack.pack`;
        const bytes = await ctx.fs.read(packPath);
        await ctx.fs.write(packPath, bytes.slice(0, 8));
        const sut = await createPackRegistry(ctx);

        // Act
        const result = await sut.health();

        // Assert
        const entry = result.unusable[0]!;
        expect(entry.layer).toBe('pack');
        expect((entry.data as { reason?: string }).reason).toContain('truncated');
      });
    });
  });

  describe('Given the .pack file is missing when the header is probed', () => {
    describe('When health() is called', () => {
      it('Then the pack is unusable at the pack layer with FILE_NOT_FOUND', async () => {
        // Arrange — isolates the FILE_NOT_FOUND arm of isSkippableIoFault at the
        // pack layer, alone.
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('health-pack-missing-content');
        await writeSyntheticPack(ctx, 'health-pack-missing', [
          { kind: 'base', type: 'blob', content },
        ]);
        const wrapped: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            openWithNoFollow: async (path: string, mode: 'read' | 'write') => {
              if (path.endsWith('.pack')) throw fileNotFound(path);
              return ctx.fs.openWithNoFollow(path, mode);
            },
          },
        };
        const sut = await createPackRegistry(wrapped);

        // Act
        const result = await sut.health();

        // Assert
        const entry = result.unusable[0]!;
        expect(entry.layer).toBe('pack');
        expect(entry.data.code).toBe('FILE_NOT_FOUND');
      });
    });
  });

  describe('Given the .pack read rejects with PERMISSION_DENIED when the header is probed', () => {
    describe('When health() is called', () => {
      it('Then the pack is unusable at the pack layer with PERMISSION_DENIED', async () => {
        // Arrange — isolates the PERMISSION_DENIED arm of isSkippableIoFault at
        // the pack layer, alone.
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('health-pack-denied-content');
        await writeSyntheticPack(ctx, 'health-pack-denied', [
          { kind: 'base', type: 'blob', content },
        ]);
        const wrapped: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            openWithNoFollow: async (path: string, mode: 'read' | 'write') => {
              if (path.endsWith('.pack')) throw permissionDenied(path);
              return ctx.fs.openWithNoFollow(path, mode);
            },
          },
        };
        const sut = await createPackRegistry(wrapped);

        // Act
        const result = await sut.health();

        // Assert
        const entry = result.unusable[0]!;
        expect(entry.layer).toBe('pack');
        expect(entry.data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given an unparseable .idx with its sibling .pack present', () => {
    describe('When health() is called', () => {
      it('Then the pack is unusable at the index layer and absent from accessible', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeGarbageIdx(ctx, 'health-unparseable');
        const sut = await createPackRegistry(ctx);

        // Act
        const result = await sut.health();

        // Assert
        expect(result.accessible).toEqual([]);
        const entry = result.unusable[0]!;
        expect(entry.layer).toBe('index');
        expect(entry.data.code).toBe('INVALID_PACK_INDEX');
      });
    });
  });

  describe('Given the .idx read rejects with PERMISSION_DENIED', () => {
    describe('When health() is called', () => {
      it('Then the pack is unusable at the index layer with PERMISSION_DENIED', async () => {
        // Arrange — isolates the PERMISSION_DENIED arm of isSkippableIoFault at
        // the index layer, alone.
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('health-idx-denied-content');
        await writeSyntheticPack(ctx, 'health-idx-denied', [
          { kind: 'base', type: 'blob', content },
        ]);
        const wrapped: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async (path: string) => {
              if (path.endsWith('.idx')) throw permissionDenied(path);
              return ctx.fs.read(path);
            },
          },
        };
        const sut = await createPackRegistry(wrapped);

        // Act
        const result = await sut.health();

        // Assert
        const entry = result.unusable[0]!;
        expect(entry.layer).toBe('index');
        expect(entry.data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given the .idx vanishes between readdir and stat', () => {
    describe('When health() is called', () => {
      it('Then the pack is unusable at the index layer with FILE_NOT_FOUND', async () => {
        // Arrange — isolates the FILE_NOT_FOUND arm of isSkippableIoFault at the
        // index layer, alone.
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('health-idx-vanish-content');
        await writeSyntheticPack(ctx, 'health-idx-vanish', [
          { kind: 'base', type: 'blob', content },
        ]);
        const wrapped: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            stat: async (path: string) => {
              if (path.endsWith('.idx')) throw fileNotFound(path);
              return ctx.fs.stat(path);
            },
          },
        };
        const sut = await createPackRegistry(wrapped);

        // Act
        const result = await sut.health();

        // Assert
        const entry = result.unusable[0]!;
        expect(entry.layer).toBe('index');
        expect(entry.data.code).toBe('FILE_NOT_FOUND');
      });
    });
  });

  describe('Given an .idx whose stat reports > MAX_PACK_IDX_BYTES', () => {
    describe('When health() is called', () => {
      it('Then the pack is unusable at the index layer without issuing a read', async () => {
        // Arrange — kills the mutant where the pre-read size guard is removed:
        // without it, read() would be reached and a multi-GiB array allocated.
        const ctx = await buildSeededContext();
        const reads: string[] = [];
        const oversized = 64 * 1024 * 1024 + 1;
        const wrapped: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            readdir: async () => [
              {
                name: 'pack-health-oversize.idx',
                isFile: true,
                isDirectory: false,
                isSymbolicLink: false,
              },
              {
                name: 'pack-health-oversize.pack',
                isFile: true,
                isDirectory: false,
                isSymbolicLink: false,
              },
            ],
            stat: async (p: string) => {
              if (!p.endsWith('.idx')) return ctx.fs.stat(p);
              const base = await ctx.fs.stat(p).catch(() => undefined);
              return { ...(base ?? makeStat()), size: oversized };
            },
            read: async (path: string) => {
              reads.push(path);
              throw new Error('should not be reached');
            },
          },
        };
        const sut = await createPackRegistry(wrapped);

        // Act
        const result = await sut.health();

        // Assert
        expect(result.accessible).toEqual([]);
        const entry = result.unusable[0]!;
        expect(entry.layer).toBe('index');
        expect((entry.data as { reason?: string }).reason).toBe(REASON_PACK_IDX_EXCEEDS_MAX);
        expect(reads).toEqual([]);
      });
    });
  });

  describe('Given an orphaned .idx whose sibling .pack was never present', () => {
    describe('When health() is called', () => {
      it('Then the pack is absent from both accessible and unusable', async () => {
        // Arrange — the orphan and index-fault arms sit five lines apart in
        // loadCandidatePack and both must stay excluded from the report.
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('health-orphan-content');
        await writeSyntheticPack(ctx, 'health-orphan', [{ kind: 'base', type: 'blob', content }]);
        const packPath = `${ctx.layout.gitDir}/objects/pack/pack-health-orphan.pack`;
        await ctx.fs.rm(packPath);
        const sut = await createPackRegistry(ctx);

        // Act
        const result = await sut.health();

        // Assert
        expect(result.accessible).toEqual([]);
        expect(result.unusable).toEqual([]);
      });
    });
  });

  describe('Given a .pack file with no sibling .idx', () => {
    describe('When health() is called', () => {
      it('Then the pack is absent from both accessible and unusable', async () => {
        // Arrange — scanPacks only ever iterates .idx candidates, so a lone
        // .pack is never even considered.
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('health-idx-less-content');
        await writeSyntheticPack(ctx, 'health-idx-less', [{ kind: 'base', type: 'blob', content }]);
        const idxPath = `${ctx.layout.gitDir}/objects/pack/pack-health-idx-less.idx`;
        await ctx.fs.rm(idxPath);
        const sut = await createPackRegistry(ctx);

        // Act
        const result = await sut.health();

        // Assert
        expect(result.accessible).toEqual([]);
        expect(result.unusable).toEqual([]);
      });
    });
  });

  describe('Given an errno-mapped UNSUPPORTED_OPERATION fault probing the pack header', () => {
    describe('When health() is called', () => {
      it('Then health() rejects instead of reporting the pack as unusable', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('health-unsupported-pack-content');
        await writeSyntheticPack(ctx, 'health-unsupported-pack', [
          { kind: 'base', type: 'blob', content },
        ]);
        const fault = unsupportedOperation('filesystem', 'EMFILE');
        const wrapped: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            openWithNoFollow: async (path: string, mode: 'read' | 'write') => {
              if (path.endsWith('.pack')) throw fault;
              return ctx.fs.openWithNoFollow(path, mode);
            },
          },
        };
        const sut = await createPackRegistry(wrapped);

        // Act
        let caught: unknown;
        try {
          await sut.health();
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual(fault.data);
      });
    });
  });

  describe('Given an errno-mapped UNSUPPORTED_OPERATION fault reading the .idx', () => {
    describe('When health() is called', () => {
      it('Then health() rejects instead of reporting the pack as unusable', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('health-unsupported-idx-content');
        await writeSyntheticPack(ctx, 'health-unsupported-idx', [
          { kind: 'base', type: 'blob', content },
        ]);
        const fault = unsupportedOperation('filesystem', 'EMFILE');
        const wrapped: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async (path: string) => {
              if (path.endsWith('.idx')) throw fault;
              return ctx.fs.read(path);
            },
          },
        };
        const sut = await createPackRegistry(wrapped);

        // Act
        let caught: unknown;
        try {
          await sut.health();
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual(fault.data);
      });
    });
  });

  describe('Given a non-TsgitError rejection reading the .idx', () => {
    describe('When health() is called', () => {
      it('Then the plain error propagates instead of being treated as skippable', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('health-unexpected-error-content');
        await writeSyntheticPack(ctx, 'health-unexpected-error', [
          { kind: 'base', type: 'blob', content },
        ]);
        const wrapped: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async (path: string) => {
              if (path.endsWith('.idx')) throw new Error('boom');
              return ctx.fs.read(path);
            },
          },
        };
        const sut = await createPackRegistry(wrapped);

        // Act
        let caught: unknown;
        try {
          await sut.health();
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as Error).message).toBe('boom');
      });
    });
  });

  describe('Given a healthy pack', () => {
    describe('When health() is called, then lookup() resolves the same pack', () => {
      it('Then exactly one handle read is issued in total, sized to the cached window', async () => {
        // Arrange — health() warms pack.header()'s memo; a later lookup() must
        // reuse it rather than re-probing (requirement 10, no second gate).
        // The header read now goes through the pack window cache: a small
        // pack's window load is clamped to the whole (small) file, not to
        // PACK_HEADER_SIZE — the point of caching a window at offset 0 in
        // the first place.
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('health-memo-warm-content');
        const ids = await writeSyntheticPack(ctx, 'health-memo-warm', [
          { kind: 'base', type: 'blob', content },
        ]);
        const id = ids[0] as ObjectId;
        const packPath = `${ctx.layout.gitDir}/objects/pack/pack-health-memo-warm.pack`;
        const packFileSize = (await ctx.fs.stat(packPath)).size;
        const ledger = withHandleLedger(ctx);
        const sut = await createPackRegistry(ledger.ctx);

        // Act
        await sut.health();
        await sut.lookup(id);

        // Assert
        expect(ledger.slices()).toEqual([{ path: packPath, offset: 0, length: packFileSize }]);
      });
    });
  });

  describe('Given a pack whose header is invalid', () => {
    describe('When health() is called, then lookup() probes the same pack again', () => {
      it('Then the header is re-parsed and re-warned on the second probe — the memo clears on rejection', async () => {
        // Arrange — no negative cache: a rejected probe must not pin later
        // callers to a stale fault. The pack window cache serves the second
        // probe's bytes from the window health() already loaded, so a
        // single physical read now backs both probes — `warn`, not the
        // handle-read count, is what proves the header memo itself still
        // re-parses (and re-rejects) on every call.
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('health-no-negative-cache-content');
        const ids = await writeSyntheticPack(ctx, 'health-no-negative-cache', [
          { kind: 'base', type: 'blob', content },
        ]);
        const id = ids[0] as ObjectId;
        const packPath = `${ctx.layout.gitDir}/objects/pack/pack-health-no-negative-cache.pack`;
        await restampPackHeader(ctx, packPath, { version: 99 });
        const warn = vi.fn();
        const ledger = withHandleLedger({ ...ctx, logger: { warn } });
        const sut = await createPackRegistry(ledger.ctx);

        // Act
        await sut.health();
        await sut.lookup(id);

        // Assert
        expect(ledger.slices().filter((s) => s.path === packPath)).toHaveLength(1);
        expect(warn).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Given a pack whose header is invalid', () => {
    describe('When health() is called, then all() is called', () => {
      it('Then all() still lists the pack (requirement 9)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('health-all-unchanged-content');
        await writeSyntheticPack(ctx, 'health-all-unchanged', [
          { kind: 'base', type: 'blob', content },
        ]);
        const packPath = `${ctx.layout.gitDir}/objects/pack/pack-health-all-unchanged.pack`;
        await restampPackHeader(ctx, packPath, { version: 99 });
        const sut = await createPackRegistry(ctx);

        // Act
        await sut.health();
        const packs = await sut.all();

        // Assert
        expect(packs).toHaveLength(1);
        expect(packs[0]!.name).toBe('pack-health-all-unchanged');
      });
    });
  });

  describe('Given a disposed registry that already scanned one healthy pack', () => {
    describe('When health() is called', () => {
      it('Then it resolves against the peeked generation without a new readdir', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('health-disposed-content');
        await writeSyntheticPack(ctx, 'health-disposed', [{ kind: 'base', type: 'blob', content }]);
        const ledger = withHandleLedger(ctx);
        const sut = await createPackRegistry(ledger.ctx);
        await sut.all();
        await sut.dispose();
        const readdirCallsBeforeHealth = ledger.readdirCalls();

        // Act
        const result = await sut.health();

        // Assert
        expect(ledger.readdirCalls()).toBe(readdirCallsBeforeHealth);
        expect(result.accessible).toHaveLength(1);
        expect(result.unusable).toEqual([]);
      });
    });
  });

  describe('Given health() probed a pack before the registry is disposed', () => {
    describe('When dispose() runs', () => {
      it('Then no FileHandle is left outstanding (requirement 11)', async () => {
        // Arrange — health() only ever reads through ctx.fs.readSlice, never
        // opens a persistent handle, so dispose() must still close cleanly.
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('health-handle-ledger-content');
        await writeSyntheticPack(ctx, 'health-handle-ledger', [
          { kind: 'base', type: 'blob', content },
        ]);
        const ledger = withHandleLedger(ctx);
        const sut = await createPackRegistry(ledger.ctx);

        // Act
        await sut.health();
        await sut.dispose();

        // Assert
        expect(ledger.outstanding()).toBe(0);
      });
    });
  });

  describe('Given a healthy pack', () => {
    describe('When health() is called twice without a refresh', () => {
      it('Then the header is probed once per generation — the per-run cost contract', async () => {
        // Arrange
        const base = await buildSeededContext();
        const content = new TextEncoder().encode('health-memo-content');
        await writeSyntheticPack(base, 'health-memo', [{ kind: 'base', type: 'blob', content }]);
        const ledger = withHandleLedger(base);
        const sut = await createPackRegistry(ledger.ctx);

        // Act
        await sut.health();
        await sut.health();

        // Assert
        const headerProbes = ledger
          .slices()
          .filter((call) => call.path.endsWith('.pack') && call.offset === 0);
        expect(headerProbes).toHaveLength(1);
      });
    });
  });

  describe('Given a pack refused at the header gate, then repaired without a refresh', () => {
    describe('When health() is called again', () => {
      it('Then the memoised verdict still reports it unusable until refresh()', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('health-stability-content');
        await writeSyntheticPack(ctx, 'health-stability', [
          { kind: 'base', type: 'blob', content },
        ]);
        const packPath = `${ctx.layout.gitDir}/objects/pack/pack-health-stability.pack`;
        const goodPackBytes = await ctx.fs.read(packPath);
        await restampPackHeader(ctx, packPath, { version: 99 });
        const sut = await createPackRegistry(ctx);

        // Act
        const before = await sut.health();
        await ctx.fs.write(packPath, goodPackBytes);
        const repairedNoRefresh = await sut.health();
        sut.refresh();
        const repairedRefreshed = await sut.health();

        // Assert — one consistent verdict per generation, by design: the
        // report may not flap mid-run; refresh() is the only reset.
        expect(before.unusable).toHaveLength(1);
        expect(repairedNoRefresh.unusable).toHaveLength(1);
        expect(repairedRefreshed.unusable).toEqual([]);
        expect(repairedRefreshed.accessible).toHaveLength(1);
      });
    });
  });

  describe('Given a pack whose .idx was corrupt, then repaired, then refreshed', () => {
    describe('When health() is called before and after the repair', () => {
      it('Then the pack moves from unusable to accessible with nothing remembered as bad', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('health-refresh-content');
        await writeSyntheticPack(ctx, 'health-refresh', [{ kind: 'base', type: 'blob', content }]);
        const idxPath = `${ctx.layout.gitDir}/objects/pack/pack-health-refresh.idx`;
        const goodIdxBytes = await ctx.fs.read(idxPath);
        await ctx.fs.write(idxPath, garbageIdxBytes());
        const sut = await createPackRegistry(ctx);

        // Act
        const before = await sut.health();
        await ctx.fs.write(idxPath, goodIdxBytes);
        sut.refresh();
        const after = await sut.health();

        // Assert
        expect(before.accessible).toEqual([]);
        expect(before.unusable).toHaveLength(1);
        expect(before.unusable[0]!.layer).toBe('index');
        expect(after.unusable).toEqual([]);
        expect(after.accessible).toHaveLength(1);
        expect(after.accessible[0]!.name).toBe('pack-health-refresh');
      });
    });
  });

  describe('Given one pack with an invalid header and one pack with a corrupt .idx', () => {
    describe('When health() is called', () => {
      it('Then two unusable entries are reported, one per layer', async () => {
        // Arrange — kills an `ArrayDeclaration -> []` mutant and a
        // `break`-for-`continue` mutant in the pack-layer loop.
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('health-two-unusable-content');
        await writeSyntheticPack(ctx, 'health-two-unusable-pack', [
          { kind: 'base', type: 'blob', content },
        ]);
        const badPackPath = `${ctx.layout.gitDir}/objects/pack/pack-health-two-unusable-pack.pack`;
        await restampPackHeader(ctx, badPackPath, { version: 99 });
        await writeGarbageIdx(ctx, 'health-two-unusable-idx');
        const sut = await createPackRegistry(ctx);

        // Act
        const result = await sut.health();

        // Assert
        expect(result.accessible).toEqual([]);
        expect(result.unusable).toHaveLength(2);
        expect(result.unusable.map((entry) => entry.layer).sort()).toEqual(['index', 'pack']);
      });
    });
  });
});

describe('RegisteredPack.header — held handle', () => {
  describe('Given a pack whose persistent handle is already open', () => {
    describe('When header() is called', () => {
      it('Then it reads through the held handle: no path readSlice, no second openWithNoFollow', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'header-held-handle', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('h') },
        ]);
        const ledger = withHandleLedger(ctx);
        const registry = await createPackRegistry(ledger.ctx);
        const pack = (await registry.all())[0]!;
        await pack.readSlice(0, 4);

        // Act
        const header = await pack.header();

        // Assert
        expect(header).toEqual({ version: 2, objectCount: 1 });
        expect(ledger.opens()).toBe(1);
        expect(ledger.perCallReads()).toBe(0);
      });
    });
  });

  describe('Given an fs whose openWithNoFollow always throws UNSUPPORTED_OPERATION (browser-like)', () => {
    describe('When header() is called', () => {
      it('Then it attempts the handle once and still reads the header by path', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'header-browser-fallback', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('h') },
        ]);
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
        const openSpy = vi.spyOn(wrapped.fs, 'openWithNoFollow');
        const registry = await createPackRegistry(wrapped);
        const pack = (await registry.all())[0]!;

        // Act
        const header = await pack.header();

        // Assert
        expect(header).toEqual({ version: 2, objectCount: 1 });
        expect(openSpy).toHaveBeenCalledTimes(1);
      });
    });
  });
});

describe('nextOffsetForEntry', () => {
  describe('Given a table with sortedOffsets=[100, 500, 900], packFileSize=1000, trailerStart=980', () => {
    const table: PackOffsetTable = {
      kind: 'sorted',
      sortedOffsets: Float64Array.of(100, 500, 900),
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
          kind: 'sorted',
          sortedOffsets: Float64Array.of(400),
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
        // Arrange — the size now rides the held handle's fstat, so the fake
        // small size is planted on the handle returned for the .pack file,
        // not on ctx.fs.stat (which offsetTable no longer calls when a
        // handle is available). trailerStart = 10 - 20 = -10.
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
            openWithNoFollow: async (path: string, mode: 'read' | 'write') => {
              const handle = await ctx.fs.openWithNoFollow(path, mode);
              if (!path.endsWith('.pack')) return handle;
              return {
                ...handle,
                stat: async () => ({ ...(await handle.stat()), size: tinySize }),
              };
            },
          },
        };
        const registry = await createPackRegistry(wrappedCtx);
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
        // Arrange — the handle's own fstat reports exactly digestLength
        // bytes, so trailerStart = digestLength - digestLength = 0. The
        // `< 0` guard admits this boundary; a `<= 0` mutant would reject it
        // and throw.
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
            openWithNoFollow: async (path: string, mode: 'read' | 'write') => {
              const handle = await ctx.fs.openWithNoFollow(path, mode);
              if (!path.endsWith('.pack')) return handle;
              return {
                ...handle,
                stat: async () => ({ ...(await handle.stat()), size: digestLength }),
              };
            },
          },
        };
        const registry = await createPackRegistry(wrappedCtx);
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
      it('Then fstat runs against the pack handle exactly once (lazy cache)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content1 = new Uint8Array([10, 20, 30]);
        const content2 = new Uint8Array([40, 50, 60, 70]);
        await writeSyntheticPack(ctx, 'two-entry', [
          { kind: 'base', type: 'blob', content: content1 },
          { kind: 'base', type: 'blob', content: content2 },
        ]);
        const registry = await createPackRegistry(ctx);
        const packs = await registry.all();
        const pack = packs[0]!;

        // Replace the pack's handle with one whose stat() is counted — size
        // now rides the held handle's fstat, not ctx.fs.stat.
        let statCallCount = 0;
        const countingCtx = {
          ...ctx,
          fs: {
            ...ctx.fs,
            openWithNoFollow: async (path: string, mode: 'read' | 'write') => {
              const handle = await ctx.fs.openWithNoFollow(path, mode);
              if (!path.endsWith('.pack')) return handle;
              return {
                ...handle,
                stat: async () => {
                  statCallCount += 1;
                  return handle.stat();
                },
              };
            },
          },
        };
        const registry2 = await createPackRegistry(countingCtx);
        const packs2 = await registry2.all();
        const pack2 = packs2[0]!;
        const sut = pack2.offsetTable;

        // Act — call twice; only the first should hit fstat
        await sut();
        await sut();

        // Assert — fstat called exactly once across both offsetTable() calls
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
        const registry = await createPackRegistry(ctx);
        const packs = await registry.all();
        const pack = packs[0]!;
        const sut = pack.offsetTable;

        // Act
        const result = await sut();

        // Assert — two entries, offsets are in ascending order, both > 0
        const sortedOffsets = expectSortedOffsets(result);
        expect(sortedOffsets).toHaveLength(2);
        expect(sortedOffsets[0]!).toBeGreaterThan(0);
        expect(sortedOffsets[1]!).toBeGreaterThan(sortedOffsets[0]!);
      });
    });
  });

  describe('Given a cold pack obtained from all() with the stat counter reset', () => {
    describe('When 8 offsetTable() calls run under Promise.all', () => {
      it('Then fstat ran against the pack handle exactly once and all 8 results are the same object reference', async () => {
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
            openWithNoFollow: async (path: string, mode: 'read' | 'write') => {
              const handle = await ctx.fs.openWithNoFollow(path, mode);
              if (!path.endsWith('.pack')) return handle;
              return {
                ...handle,
                stat: async () => {
                  statCallCount += 1;
                  return handle.stat();
                },
              };
            },
          },
        };
        const registry = await createPackRegistry(countingCtx);
        const packs = await registry.all();
        const pack = packs[0]!;
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
      it('Then the size is fetched via one fstat call and both calls reject with INVALID_PACK_INDEX, reason containing "pack file too small"', async () => {
        // Arrange — the handle's fstat reports size=10 (< digestLength=20),
        // so trailerStart = 10 - 20 = -10 on every buildOffsetTable attempt.
        // The size itself is a SUCCESSFUL fstat, so sizeMemo caches it across
        // retries — unlike buildOffsetTable's own trailerStart guard, which
        // is not memoised and re-throws on every call.
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
            openWithNoFollow: async (path: string, mode: 'read' | 'write') => {
              const handle = await ctx.fs.openWithNoFollow(path, mode);
              if (!path.endsWith('.pack')) return handle;
              return {
                ...handle,
                stat: async () => {
                  statCallCount += 1;
                  return { ...(await handle.stat()), size: tinySize };
                },
              };
            },
          },
        };
        const registry = await createPackRegistry(wrappedCtx);
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

        // Assert — buildOffsetTable's own rejection is never memoised (both
        // calls throw), but the underlying size fetch succeeded, so sizeMemo
        // serves the second attempt from cache.
        expect(firstCaught).toBeDefined();
        expect(statCallCount).toBe(1);
        const data = (secondCaught as { data?: { code?: string; reason?: string } }).data;
        expect(data?.code).toBe('INVALID_PACK_INDEX');
        expect(data?.reason).toContain('pack file too small');
      });
    });
  });
});

describe('RegisteredPack.offsetTable — size through the handle', () => {
  describe('Given a pack whose persistent handle is already open', () => {
    describe('When offsetTable() is called', () => {
      it('Then no ctx.fs.stat(packPath) is issued', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'size-handle-reuse', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('s') },
        ]);
        const statSpy = vi.spyOn(ctx.fs, 'stat');
        const registry = await createPackRegistry(ctx);
        const pack = (await registry.all())[0]!;
        await pack.readSlice(0, 4);
        statSpy.mockClear();

        // Act
        await pack.offsetTable();

        // Assert
        expect(statSpy).not.toHaveBeenCalledWith(pack.packPath);
      });
    });
  });

  describe('Given the pack handle rejects with a non-UNSUPPORTED_OPERATION fault (permission denied)', () => {
    describe('When offsetTable() is called', () => {
      it('Then the fault propagates instead of falling back to a path stat', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'size-non-skippable', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('s') },
        ]);
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            openWithNoFollow: async (path: string) => {
              throw permissionDenied(path);
            },
          },
        };
        const registry = await createPackRegistry(wrapped);
        const pack = (await registry.all())[0]!;

        // Act
        let caught: unknown;
        try {
          await pack.offsetTable();
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given an fs whose openWithNoFollow always throws UNSUPPORTED_OPERATION (browser-like)', () => {
    describe('When offsetTable() is called', () => {
      it('Then it falls back to ctx.fs.stat(packPath) and still resolves', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'size-browser-fallback', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('s') },
        ]);
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
        const statSpy = vi.spyOn(wrapped.fs, 'stat');
        const registry = await createPackRegistry(wrapped);
        const pack = (await registry.all())[0]!;
        const directStat = await ctx.fs.stat(pack.packPath);

        // Act
        const result = await pack.offsetTable();

        // Assert
        expect(statSpy).toHaveBeenCalledWith(pack.packPath);
        expect(result.packFileSize).toBe(directStat.size);
      });
    });
  });

  describe('Given a pack whose persistent handle was already closed', () => {
    describe('When offsetTable() is called', () => {
      it('Then the size is fetched by path instead of reopening a handle', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'size-retired', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('s') },
        ]);
        const ledger = withHandleLedger(ctx);
        const registry = await createPackRegistry(ledger.ctx);
        const pack = (await registry.all())[0]!;
        await pack.readSlice(0, 4);
        await pack.close();
        const directStat = await ctx.fs.stat(pack.packPath);

        // Act
        const result = await pack.offsetTable();

        // Assert — no second open past the one already closed
        expect(ledger.opens()).toBe(1);
        expect(result.packFileSize).toBe(directStat.size);
      });
    });
  });

  describe("Given close() called while offsetTable()'s own size probe is mid-flight", () => {
    describe('When the probe resolves', () => {
      it('Then it never surfaces a raw, unmapped fault — close() waited for it', async () => {
        // Arrange — the handle's stat() only settles once released; it
        // inspects a `closed` flag flipped by this SAME handle's close() to
        // decide whether to throw the raw fault a real fstat-after-close
        // would (EBADF) — the shape close() must prevent by waiting for
        // every in-flight size probe before it ever calls handle.close().
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'size-race', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('race') },
        ]);
        let closed = false;
        let releaseStat: (() => void) | undefined;
        let statCalled: (() => void) | undefined;
        const statCalledPromise = new Promise<void>((resolve) => {
          statCalled = resolve;
        });
        const statGate = new Promise<void>((resolve) => {
          releaseStat = resolve;
        });
        const wrapped: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            openWithNoFollow: async (path: string, mode: 'read' | 'write') => {
              const handle = await ctx.fs.openWithNoFollow(path, mode);
              return {
                ...handle,
                stat: async () => {
                  statCalled?.();
                  await statGate;
                  if (closed) throw new Error('EBADF: bad file descriptor, fstat');
                  return handle.stat();
                },
                close: async () => {
                  closed = true;
                  await handle.close();
                },
              };
            },
          },
        };
        const registry = await createPackRegistry(wrapped);
        const pack = (await registry.all())[0]!;
        await pack.index(); // pre-warm indexMemo — offsetTable's own first await

        // Act
        const sizePending = pack.offsetTable();
        await statCalledPromise;
        const closePending = pack.close();
        // Flush every microtask close() can advance through on its own —
        // unprotected, it needs nothing from this test to reach
        // handle.close() and flip `closed`; protected, it stays blocked on
        // the still-pending size probe no matter how long this waits.
        await new Promise((resolve) => setTimeout(resolve, 0));
        releaseStat?.();
        let caught: unknown;
        try {
          await sizePending;
        } catch (error) {
          caught = error;
        }
        await closePending;

        // Assert
        expect(caught).toBeUndefined();
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
        const registry = await createPackRegistry(ctx);
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
        const registry = await createPackRegistry(ctx);
        const pack = (await registry.all())[0]!;
        const table = await pack.offsetTable();
        const entryOffset = expectSortedOffsets(table)[0]!;
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
        const registry = await createPackRegistry(wrapped);
        const pack = (await registry.all())[0]!;
        const table = await pack.offsetTable();
        const entryOffset = expectSortedOffsets(table)[0]!;
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
        const registry = await createPackRegistry(wrapped);
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

describe('RegisteredPack.readSlice — pack window cache (P8)', () => {
  describe('Given a delta chain read at a configured small window size', () => {
    describe('When every entry offset is read from tip to base', () => {
      it('Then handle reads stay within one window load per span segment', async () => {
        // Arrange — windowBytes=8192 is at least two 4 KiB pages, so a
        // request that crosses a window-aligned boundary is always rescued
        // by a page-aligned load (never bypassed): the number of distinct
        // windows touched is bounded by the span alone, independent of read
        // order.
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[core]\n\tpackedGitWindowSize = 8192\n',
        );
        const entries: EntrySpec[] = [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('chain-base') },
        ];
        for (let i = 1; i < 6; i += 1) {
          entries.push({
            kind: 'ofs-delta',
            baseIndex: i - 1,
            targetContent: Uint8Array.from({ length: 3000 }, () => Math.floor(Math.random() * 256)),
          });
        }
        const build = await buildSyntheticPack(ctx, entries);
        const base = `${ctx.layout.gitDir}/objects/pack/pack-delta-window-span`;
        await ctx.fs.write(`${base}.pack`, build.packBytes);
        await ctx.fs.write(`${base}.idx`, build.idxBytes);
        const ledger = withHandleLedger(ctx);
        const registry = await createPackRegistry(ledger.ctx);
        const pack = (await registry.all())[0]!;
        const readLength = 8;
        const span = build.offsets[build.offsets.length - 1]! + readLength - build.offsets[0]!;
        const maxHandleReads = Math.ceil(span / 8192) + 1;

        // Act — tip to base, the real delta-chain walk order.
        for (const offset of [...build.offsets].reverse()) {
          await pack.readSlice(offset, readLength);
        }

        // Assert
        const packPath = `${base}.pack`;
        const reads = ledger.slices().filter((s) => s.path === packPath);
        expect(reads.length).toBeLessThanOrEqual(maxHandleReads);
      });
    });
  });
});

describe('Given a window whose base lies past the pack file end', () => {
  describe('When readSlice is called at an offset far beyond the pack', () => {
    it('Then it resolves to an empty view instead of throwing a raw RangeError', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const content = new TextEncoder().encode('past-eof-content');
      await writeSyntheticPack(ctx, 'past-eof', [{ kind: 'base', type: 'blob', content }]);
      const registry = await createPackRegistry(ctx);
      const pack = (await registry.all())[0]!;

      // Act
      let caught: unknown;
      let result: Uint8Array | undefined;
      try {
        result = await pack.readSlice(1_000_000, 4);
      } catch (error) {
        caught = error;
      }

      // Assert
      expect(caught).toBeUndefined();
      expect(result).toBeDefined();
      expect(result?.byteLength).toBe(0);
    });
  });
});

describe('Given a registry that cached a pack window before refresh()', () => {
  describe('When the pack is rewritten under the same name and refresh() runs', () => {
    it('Then a read at the same offset serves the new bytes, not the stale window', async () => {
      // Arrange — both packs are single-entry, so the first entry always
      // starts at PACK_HEADER_SIZE=12, well inside the default 64 KiB
      // window: the cache key collides across the rewrite unless refresh()
      // clears it.
      const ctx = await buildSeededContext();
      await writeSyntheticPack(ctx, 'reused-name', [
        { kind: 'base', type: 'blob', content: new TextEncoder().encode('original-window-bytes') },
      ]);
      const registry = await createPackRegistry(ctx);
      const firstPack = (await registry.all())[0]!;
      await firstPack.readSlice(PACK_HEADER_SIZE, 10);

      // Act
      registry.refresh();
      await writeSyntheticPack(ctx, 'reused-name', [
        {
          kind: 'base',
          type: 'blob',
          content: new TextEncoder().encode('rewritten-window-bytes!!'),
        },
      ]);
      const secondPack = (await registry.all())[0]!;
      const result = await secondPack.readSlice(PACK_HEADER_SIZE, 10);

      // Assert
      const direct = await ctx.fs.readSlice(secondPack.packPath, PACK_HEADER_SIZE, 10);
      expect(Array.from(result)).toEqual(Array.from(direct));
    });
  });
});

describe('Given an outgoing pack whose window load is still in flight when refresh() runs', () => {
  describe('When a same-named successor pack is read after the late fill lands', () => {
    it("Then the successor's cached window is never overwritten by the outgoing pack's late fill", async () => {
      // Arrange — the handle wrapper never touches real pack bytes: the
      // FIRST opened handle (the outgoing pack) fills its window with 0xaa
      // once released from a gate; every later handle (a successor pack)
      // fills immediately with 0xbb. Only the window CACHE KEY decides which
      // value a read observes — the exact thing this fix scopes per pack
      // instance.
      const ctx = await buildSeededContext();
      await writeSyntheticPack(ctx, 'swap-late-fill', [
        { kind: 'base', type: 'blob', content: new TextEncoder().encode('irrelevant') },
      ]);
      let openCount = 0;
      let releaseFirstRead: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseFirstRead = resolve;
      });
      const wrapped: Context = {
        ...ctx,
        fs: {
          ...ctx.fs,
          openWithNoFollow: async (path: string, mode: 'read' | 'write') => {
            const handle = await ctx.fs.openWithNoFollow(path, mode);
            openCount += 1;
            const isFirstOpen = openCount === 1;
            const marker = isFirstOpen ? 0xaa : 0xbb;
            return {
              ...handle,
              read: async (buffer: Uint8Array, bufferOffset: number, length: number) => {
                if (isFirstOpen) await gate;
                buffer.fill(marker, bufferOffset, bufferOffset + length);
                return length;
              },
              stat: async () => ({ ...(await handle.stat()), size: 1_000_000 }),
            };
          },
        },
      };
      const registry = await createPackRegistry(wrapped);
      const outgoingPack = (await registry.all())[0]!;

      // Act — the outgoing pack's window fill starts, blocked on the gate.
      const stalePending = outgoingPack.readSlice(PACK_HEADER_SIZE, 4);
      registry.refresh();
      const successorPack = (await registry.all())[0]!;
      const freshRead = await successorPack.readSlice(PACK_HEADER_SIZE, 4);
      // The outgoing pack's late fill now resolves and writes into the
      // shared window cache.
      releaseFirstRead?.();
      await stalePending;
      const secondRead = await successorPack.readSlice(PACK_HEADER_SIZE, 4);

      // Assert
      expect(Array.from(freshRead)).toEqual([0xbb, 0xbb, 0xbb, 0xbb]);
      expect(Array.from(secondRead)).toEqual([0xbb, 0xbb, 0xbb, 0xbb]);
    });
  });
});

describe('Given a registry whose pack window cache holds a warmed window', () => {
  describe('When refresh() runs', () => {
    it('Then the pack window cache is cleared', async () => {
      // Arrange — the window cache is internal (not on the PackRegistry
      // surface); the createLruCache spy's own returned instance is the
      // only observable handle onto it, distinguished from deltaBaseCache's
      // call by argument count (windowCache passes only maxSizeBytes).
      const ctx = await buildSeededContext();
      await writeSyntheticPack(ctx, 'window-cache-refresh', [
        { kind: 'base', type: 'blob', content: new TextEncoder().encode('window-refresh-content') },
      ]);
      createLruCacheSpy.mockClear();
      const registry = await createPackRegistry(ctx);
      const windowCacheIndex = createLruCacheSpy.mock.calls.findIndex((call) => call.length === 1);
      const windowCache = createLruCacheSpy.mock.results[windowCacheIndex]!.value;
      const pack = (await registry.all())[0]!;
      await pack.readSlice(0, 4);
      expect(windowCache.entryCount).toBeGreaterThan(0);

      // Act
      registry.refresh();

      // Assert
      expect(windowCache.entryCount).toBe(0);
    });
  });

  describe('When dispose() is awaited', () => {
    it('Then the pack window cache is cleared', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      await writeSyntheticPack(ctx, 'window-cache-dispose', [
        { kind: 'base', type: 'blob', content: new TextEncoder().encode('window-dispose-content') },
      ]);
      createLruCacheSpy.mockClear();
      const registry = await createPackRegistry(ctx);
      const windowCacheIndex = createLruCacheSpy.mock.calls.findIndex((call) => call.length === 1);
      const windowCache = createLruCacheSpy.mock.results[windowCacheIndex]!.value;
      const pack = (await registry.all())[0]!;
      await pack.readSlice(0, 4);
      expect(windowCache.entryCount).toBeGreaterThan(0);

      // Act
      await registry.dispose();

      // Assert
      expect(windowCache.entryCount).toBe(0);
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
        const registry = await createPackRegistry(ledger.ctx);
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
        const registry = await createPackRegistry(ctx);
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
        const registry = await createPackRegistry(sut.ctx);
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
        const registry = await createPackRegistry(ctx);
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
        const registry = await createPackRegistry(ctx);
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
        const registry = await createPackRegistry(ledger.ctx);
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

describe('Given a registry whose delta-base cache holds an entry from an OFS chain read', () => {
  describe('When refresh() runs', () => {
    it('Then the delta-base cache is cleared', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const ids = await writeSyntheticPack(ctx, 'delta-cache-refresh', [
        { kind: 'base', type: 'blob', content: new TextEncoder().encode('base') },
        { kind: 'ofs-delta', baseIndex: 0, targetContent: new TextEncoder().encode('tip') },
      ]);
      const registry = await getPackRegistry(ctx);
      await readObject(ctx, ids[1] as ObjectId);
      expect(registry.deltaBaseCache.entryCount).toBeGreaterThan(0);

      // Act
      registry.refresh();

      // Assert
      expect(registry.deltaBaseCache.entryCount).toBe(0);
    });
  });

  describe('When dispose() is awaited', () => {
    it('Then the delta-base cache is cleared', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const ids = await writeSyntheticPack(ctx, 'delta-cache-dispose', [
        { kind: 'base', type: 'blob', content: new TextEncoder().encode('base') },
        { kind: 'ofs-delta', baseIndex: 0, targetContent: new TextEncoder().encode('tip') },
      ]);
      const registry = await getPackRegistry(ctx);
      await readObject(ctx, ids[1] as ObjectId);
      expect(registry.deltaBaseCache.entryCount).toBeGreaterThan(0);

      // Act
      await registry.dispose();

      // Assert
      expect(registry.deltaBaseCache.entryCount).toBe(0);
    });
  });
});

describe('Given the delta-base cache is created for a fresh registry', () => {
  describe('When createLruCache is called to build it', () => {
    it('Then it is given an entry cap, not just a byte cap', async () => {
      // Arrange — a byte cap alone admits unboundedly many small entries;
      // the entry cap is a second, independent defence.
      const ctx = await buildSeededContext();
      createLruCacheSpy.mockClear();

      // Act
      await createPackRegistry(ctx);

      // Assert
      const deltaBaseCall = createLruCacheSpy.mock.calls.find(
        (call) => call[0] === GIT_DEFAULT_DELTA_BASE_CACHE_LIMIT_BYTES,
      );
      expect(deltaBaseCall?.[1]).toBeDefined();
      expect(deltaBaseCall?.[1]).toBeGreaterThan(0);
    });
  });
});

describe('Given core.deltaBaseCacheLimit / cacheBudgets.deltaBaseCacheMaxBytes resolve the budget', () => {
  describe('When createPackRegistry resolves', () => {
    it.each([
      {
        label: 'a core.deltaBaseCacheLimit config key',
        config: '[core]\n\tdeltaBaseCacheLimit = 4m\n',
        cacheBudgets: undefined,
        expected: 4 * 1024 * 1024,
      },
      {
        label: 'an explicit cacheBudgets option, over a conflicting key',
        config: '[core]\n\tdeltaBaseCacheLimit = 4m\n',
        cacheBudgets: { deltaBaseCacheMaxBytes: 2048 },
        expected: 2048,
      },
      {
        label: 'neither set — the 96 MiB git default',
        config: '',
        cacheBudgets: undefined,
        expected: GIT_DEFAULT_DELTA_BASE_CACHE_LIMIT_BYTES,
      },
    ])(
      'Then deltaBaseCache.maxSize resolves from $label',
      async ({ config, cacheBudgets, expected }) => {
        // Arrange
        const base = await buildSeededContext();
        if (config !== '') await base.fs.writeUtf8(`${base.layout.gitDir}/config`, config);
        const ctx: Context = cacheBudgets === undefined ? base : { ...base, cacheBudgets };

        // Act
        const sut = await createPackRegistry(ctx);

        // Assert
        expect(sut.deltaBaseCache.maxSize).toBe(expected);
      },
    );
  });
});

describe('Given a malformed core.maxTreeDepth', () => {
  describe('When createPackRegistry is called', () => {
    it('Then throws CONFIG_BAD_NUMERIC_VALUE before scanning the pack directory', async () => {
      // Arrange
      const base = await buildSeededContext();
      await base.fs.writeUtf8(`${base.layout.gitDir}/config`, '[core]\n\tmaxTreeDepth = 2.5\n');
      let readdirCalled = false;
      const ctx: Context = {
        ...base,
        fs: {
          ...base.fs,
          readdir: async (path: string) => {
            readdirCalled = true;
            return base.fs.readdir(path);
          },
        },
      };

      // Act
      let caught: unknown;
      try {
        await createPackRegistry(ctx);
        expect.unreachable();
      } catch (error) {
        caught = error;
      }

      // Assert
      expect((caught as TsgitError).data.code).toBe('CONFIG_BAD_NUMERIC_VALUE');
      expect(readdirCalled).toBe(false);
    });
  });
});

describe('Given a freshly constructed registry', () => {
  describe('When refresh() runs after construction', () => {
    it('Then readConfig ran exactly twice (delta-base + window budgets) — only during construction, never on refresh', async () => {
      // Arrange — both derived caches resolve their config-backed budget
      // once, at construction; refresh() must not re-derive either.
      const ctx = await buildSeededContext();
      const spy = vi.spyOn(configReadMod, 'readConfig');

      // Act
      const sut = await createPackRegistry(ctx);
      sut.refresh();

      // Assert
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
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
        const registry = await createPackRegistry(ledger.ctx);
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
        const registry = await createPackRegistry(wrapped);
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
        const registry = await createPackRegistry(ledger.ctx);

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
        const registry = await createPackRegistry(slowClose);
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

describe('PackRegistry.settleRefresh', () => {
  describe('Given a refresh with outgoing handles', () => {
    describe('When settleRefresh is awaited', () => {
      it('Then every outgoing handle is closed, without disposing the registry', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'settle-refresh-drains', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('s') },
        ]);
        const ledger = withHandleLedger(ctx);
        // Delay the handle's close by a real turn so a settleRefresh() that
        // fails to drain refresh's fire-and-forget close batch observes it
        // still outstanding.
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
        const registry = await createPackRegistry(slowClose);
        const pack = (await registry.all())[0]!;
        await pack.readSlice(0, 4);

        // Act
        registry.refresh();
        await registry.settleRefresh();

        // Assert
        expect(ledger.outstanding()).toBe(0);
        expect(ledger.closes()).toBe(1);

        // Assert — the registry is still usable, unlike after dispose()
        const packsAfterRefresh = await registry.all();
        expect(packsAfterRefresh).toHaveLength(1);
      });
    });
  });

  describe('Given a registry that never scanned', () => {
    describe('When settleRefresh is awaited', () => {
      it('Then it resolves without triggering a readdir or a close', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ledger = withHandleLedger(ctx);
        const registry = await createPackRegistry(ledger.ctx);

        // Act
        await registry.settleRefresh();

        // Assert
        expect(ledger.readdirCalls()).toBe(0);
        expect(ledger.closes()).toBe(0);
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
        const registry = await createPackRegistry(ledger.ctx);
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
        const sut = await createPackRegistry(ledger.ctx);

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
        const sut = await createPackRegistry(ledger.ctx);

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
        const sut = await createPackRegistry(ledger.ctx);
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
        const sut = await createPackRegistry(ledger.ctx);

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
        const sut = await createPackRegistry(ledger.ctx);

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
      it('Then dispose resolves once the racing scan itself has settled, and a later read by the scan caller opens no handle', async () => {
        // Arrange — dispose() only ever needs the scan's raw candidate list to
        // close handles, never the lazily loaded .idx classification all() also
        // waits on, so a racing dispose() settles as soon as the scan itself has
        // produced that list — strictly before all()'s own promise, which pays
        // the extra .idx read before it can filter the accessible set.
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'gated-dispose', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('d') },
        ]);
        const ledger = withHandleLedger(ctx, { gateReaddir: true });
        const sut = await createPackRegistry(ledger.ctx);
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
        expect(order).toEqual(['dispose-resolved', 'scan-settled']);
        expect(ledger.opens()).toBe(0);
        expect(ledger.outstanding()).toBe(0);
      });
    });
  });

  describe('Given a gated scan whose call 0 is failed with a code-less error', () => {
    describe('When all() is awaited', () => {
      it('Then the rejection propagates and a second all() re-scans and resolves normally', async () => {
        // Arrange — a code-less error is a programming error, never folded
        // (`errorDataCode` finds no `data.code`), so it must still propagate
        // and clear the single-flight memo for the next caller to retry.
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'gated-retry', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('t') },
        ]);
        const ledger = withHandleLedger(ctx, { gateReaddir: true });
        const sut = await createPackRegistry(ledger.ctx);
        const err = new Error('readdir exploded');

        // Act
        const p1 = sut.all();
        await ledger.readdirGate.arrived(0);
        ledger.readdirGate.fail(0, err);
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
        expect(caught).toBe(err);
        expect(packs).toHaveLength(1);
      });
    });
  });

  describe('Given gated scans', () => {
    describe('When refresh() runs between two overlapping scans and the first is failed while the second settles', () => {
      it('Then the first scan rejects, the second resolves, and a third all() performs no further scan', async () => {
        // Arrange — a code-less error is never folded, so it still rejects
        // and clears the single-flight memo (see the sibling row above).
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'gated-identity', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('i') },
        ]);
        const ledger = withHandleLedger(ctx, { gateReaddir: true });
        const sut = await createPackRegistry(ledger.ctx);
        const err = new Error('readdir exploded');

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
        const sut = await createPackRegistry(ledger.ctx);
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
        const sut = await createPackRegistry(ledger.ctx);
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
        const sut = await createPackRegistry(ledger.ctx);
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
        const sut = await createPackRegistry(ledger.ctx);
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

  describe('Given a Context that only ever hit loose objects', () => {
    describe('When dispose() is called', () => {
      it('Then objects/pack is listed only once, by the gate assertLoadable already forced, and no handle opens', async () => {
        // Arrange — assertLoadable now shares the store gate's listing, so
        // it alone lists the pack directory once; dispose() never scans on
        // top of it, and it opens no pack handle either way.
        const ctx = await buildSeededContext();
        await writeMidxBytes(ctx, buildMidx(healthyMidxSpec()));
        const ledger = withHandleLedger(ctx);
        const sut = await createPackRegistry(ledger.ctx);
        await sut.assertLoadable();

        // Act
        await sut.dispose();

        // Assert
        expect(ledger.readdirCalls()).toBe(1);
        expect(ledger.opens()).toBe(0);
      });
    });
  });

  describe('Given a disposed registry', () => {
    describe('When assertLoadable() is called again', () => {
      it('Then it resolves without starting a new multi-pack-index load', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeMidxBytes(ctx, buildMidx(healthyMidxSpec()));
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const sut = await createPackRegistry(instrumented);
        await sut.dispose();

        // Act
        await sut.assertLoadable();

        // Assert — the gate was never forced: dispose() before any read
        // leaves it idle, and the terminal-disposal rule resolves it to the
        // empty load instead of starting a new multi-pack-index probe.
        const midxReads = calls().filter(
          (call) => call.method === 'read' && call.path.endsWith('multi-pack-index'),
        );
        expect(midxReads).toEqual([]);
        const readdirCalls = calls().filter((call) => call.method === 'readdir');
        expect(readdirCalls).toEqual([]);
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
        const sut = await createPackRegistry(ledger.ctx);
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
        const sut = await createPackRegistry(ledger.ctx);
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
        const registry = await createPackRegistry(ledger.ctx);
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
        const sut = await createPackRegistry(ctx);

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
        const sut = await createPackRegistry(ledger.ctx);
        const absentId = 'a'.repeat(40) as ObjectId;

        // Act
        const result = await sut.lookup(absentId);

        // Assert
        expect(result).toBeUndefined();
        expect(ledger.slices().filter((s) => s.path === packPath)).toEqual([]);
        // Guards the pin against a future probe-through-handle rewrite: the
        // slices ledger only observes ctx.fs.readSlice, so opens() must stay
        // zero for the laziness claim to remain meaningful.
        expect(ledger.opens()).toBe(0);
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
        const consultedIdxOrder: string[] = [];
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
              // The reordering above deliberately narrows the listing to the two
              // .idx entries; the sibling .pack files must still be present in
              // what scanPacks sees, or the scan-layer orphan filter excludes
              // both packs before the lookup-layer behaviour under test ever runs.
              const packSiblings = entries.filter((entry) => entry.name.endsWith('.pack'));
              return [...ordered, ...packSiblings];
            },
            stat: async (path: string) => {
              // Records the order the PRODUCTION scan consults the indexes —
              // stat is loadPack's first op per .idx — so the bad-pack-first
              // premise is observed, not restated from the fixture's own input.
              const name = path.split('/').pop() ?? path;
              if (name.endsWith('.idx')) consultedIdxOrder.push(name);
              return ctx.fs.stat(path);
            },
          },
        };
        const sut = readObject;

        // Act
        const result = await sut(wrapped, oidA);

        // Assert
        expect(consultedIdxOrder).toEqual(orderedNames);
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
      it('Then rejects with OBJECT_NOT_FOUND after warning twice (one re-scan retry)', async () => {
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

        // Assert — the header-probe fault is skippable (warn + fold to a
        // miss), so the object-resolver's own full-miss re-scan retry
        // (pack-miss-rescan.ts) runs a SECOND generation, which re-probes
        // the same still-invalid header and warns again.
        expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id });
        expect(warn).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Given a pack with an invalid header', () => {
    describe('When lookup(id) is called twice', () => {
      it('Then each call re-parses the header and warns again — no negative cache at the parse level', async () => {
        // Arrange — the header MEMO self-clears on rejection (no negative
        // cache), so parsePackHeader really does run again on the second
        // call. The pack window cache is a separate, lower layer that
        // caches raw bytes regardless of parse outcome: the first call's
        // window load already covers offset 0, so the second call's
        // re-parse is served from that cached window with no second handle
        // read — one physical read, two independent parse attempts.
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
        const sut = await createPackRegistry(ledger.ctx);

        // Act
        await sut.lookup(id);
        await sut.lookup(id);

        // Assert
        const probes = ledger.slices().filter((s) => s.path === packPath && s.offset === 0);
        expect(probes).toHaveLength(1);
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
        const sut = await createPackRegistry(ledger.ctx);

        // Act
        await sut.lookup(id);
        await sut.lookup(id);

        // Assert — the pack window cache's window load, not a bare
        // PACK_HEADER_SIZE read, is what actually reaches the handle.
        const probes = ledger.slices().filter((s) => s.path === packPath && s.offset === 0);
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
        const sut = await createPackRegistry({ ...ctx, logger: { warn } });

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
        const sut = await createPackRegistry({ ...ctx, logger: { warn } });

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
        const sut = await createPackRegistry({ ...ctx, logger: { warn } });

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
      it('Then skips the pack, rejects with OBJECT_NOT_FOUND, and warns twice (one re-scan retry)', async () => {
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
            openWithNoFollow: async (path: string, mode: 'read' | 'write') => {
              if (path.endsWith('.pack')) throw permissionDenied(path);
              return ctx.fs.openWithNoFollow(path, mode);
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

        // Assert — the header-probe fault is skippable (warn + fold to a
        // miss), so the object-resolver's own full-miss re-scan retry
        // (pack-miss-rescan.ts) runs a SECOND generation, which re-probes
        // the same still-broken pack and warns again.
        expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id });
        expect(warn).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Given a pack file unlinked between scan and probe (header probe rejects FILE_NOT_FOUND)', () => {
    describe('When readObject is called', () => {
      it('Then skips the pack, rejects with OBJECT_NOT_FOUND, and warns twice (one re-scan retry)', async () => {
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
            openWithNoFollow: async (path: string, mode: 'read' | 'write') => {
              if (path.endsWith('.pack')) throw fileNotFound(path);
              return ctx.fs.openWithNoFollow(path, mode);
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

        // Assert — the header-probe fault is skippable (warn + fold to a
        // miss), so the object-resolver's own full-miss re-scan retry
        // (pack-miss-rescan.ts) runs a SECOND generation, which re-probes
        // the same still-unlinked pack and warns again.
        expect((caught as TsgitError).data).toEqual({ code: 'OBJECT_NOT_FOUND', id });
        expect(warn).toHaveBeenCalledTimes(2);
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
            openWithNoFollow: async (path: string, mode: 'read' | 'write') => {
              if (path.endsWith('.pack')) throw unsupportedOperation('filesystem', 'EMFILE');
              return ctx.fs.openWithNoFollow(path, mode);
            },
          },
        };
        const sut = await createPackRegistry(wrapped);

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
      it('Then both probed packs opened a handle for their header, and none is left outstanding', async () => {
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
        const sut = await createPackRegistry(ledger.ctx);

        // Act
        const hit = await sut.lookup(oidA);
        await hit?.pack.readSlice(0, 4);
        await sut.dispose();

        // Assert — the header probe now rides the same held handle as every
        // other read, so the skipped bad pack opens one too; dispose() still
        // closes both.
        expect(hit).toBeDefined();
        expect(ledger.opens()).toBe(2);
        expect(ledger.outstanding()).toBe(0);
      });
    });
  });
});

function midxPath(ctx: Context): string {
  return `${ctx.layout.gitDir}/objects/pack/multi-pack-index`;
}

async function writeMidxBytes(ctx: Context, bytes: Uint8Array): Promise<void> {
  await ctx.fs.write(midxPath(ctx), bytes);
}

function healthyMidxSpec(overrides: Partial<MidxSpec> = {}): MidxSpec {
  return {
    version: 1,
    hashVersion: 1,
    digestLength: 20,
    numBaseFiles: 0,
    packNames: [],
    entries: [],
    ...overrides,
  };
}

/** Flip the first signature byte ('M' → 0x00) — a structurally self-inconsistent midx. */
function flipMidxSignature(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  copy[0] = 0;
  return copy;
}

function truncateMidxTo8(bytes: Uint8Array): Uint8Array {
  return bytes.slice(0, 8);
}

function findMidxChunkRowIndex(bytes: Uint8Array, id: string): number {
  const numChunks = bytes[6]!;
  const decoder = new TextDecoder();
  for (let i = 0; i < numChunks + 1; i += 1) {
    const rowStart = 12 + i * 12;
    if (decoder.decode(bytes.subarray(rowStart, rowStart + 4)) === id) return i;
  }
  throw new Error(`chunk ${id} not present in fixture`);
}

/** Shrinks chunk `id`'s declared size by adjusting the offset of the row
 *  immediately after it in the chunk table. */
function shrinkMidxChunkAfter(bytes: Uint8Array, id: string, delta: number): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  const nextRowStart = 12 + (findMidxChunkRowIndex(copy, id) + 1) * 12;
  const low = view.getUint32(nextRowStart + 8);
  view.setUint32(nextRowStart + 8, low + delta);
  return copy;
}

describe('PackRegistry — multi-pack-index degradation', () => {
  describe('Given an INVALID_MULTI_PACK_INDEX error for each MidxCheck member', () => {
    describe("When checked against the registry's per-.idx and per-pack allow-lists", () => {
      it.each<MidxCheck>([
        'size',
        'signature',
        'version',
        'hash-version',
        'chunk-table',
        'required-chunk',
        'fanout',
        'chunk-length',
        'pack-names',
        'pack-int-id',
        'large-offset',
      ])('Then neither isSkippableIdxFault nor isSkippablePackFault admits check=%s', (check) => {
        // Arrange
        const err = invalidMultiPackIndex(check, 'test reason');

        // Act + Assert
        expect(isSkippableIdxFault(err)).toBe(false);
        expect(isSkippablePackFault(err)).toBe(false);
      });
    });
  });

  describe('Given a structurally self-inconsistent flat multi-pack-index beside a perfectly healthy pack', () => {
    describe('When lookup is called', () => {
      it('Then lookup rejects with INVALID_MULTI_PACK_INDEX and the matching check', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'midx-escapes', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('escapes') },
        ]);
        await writeMidxBytes(ctx, flipMidxSignature(buildMidx(healthyMidxSpec())));
        const sut = await createPackRegistry(ctx);

        // Act
        let caught: unknown;
        try {
          await sut.lookup('a'.repeat(40) as ObjectId);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('INVALID_MULTI_PACK_INDEX');
        if (data.code !== 'INVALID_MULTI_PACK_INDEX') {
          expect.fail(`expected INVALID_MULTI_PACK_INDEX, got ${data.code}`);
        }
        expect(data.check).toBe('signature');
      });
    });
  });

  describe('Given a repo with a healthy pack and a merely-unusable multi-pack-index', () => {
    describe('When lookup is called', () => {
      it.each<{
        label: string;
        reasonFragment: string;
        corrupt: (bytes: Uint8Array) => Uint8Array;
      }>([
        { label: 'size', reasonFragment: 'too short', corrupt: (bytes) => bytes.slice(0, 8) },
        {
          label: 'chunk-table',
          reasonFragment: 'chunk table',
          corrupt: (bytes) => bytes.slice(0, 20),
        },
        {
          label: 'hash-version',
          reasonFragment: 'hash version 2',
          corrupt: (bytes) => {
            const copy = bytes.slice();
            copy[5] = 2;
            return copy;
          },
        },
        {
          label: 'chunk-length',
          reasonFragment: 'OIDF',
          corrupt: (bytes) => shrinkMidxChunkAfter(bytes, 'OIDF', -4),
        },
      ])(
        'Then lookup resolves via the .idx scan with exactly one warn ($label)',
        async ({ corrupt, reasonFragment }) => {
          // Arrange
          const ctx = await buildSeededContext();
          const ids = await writeSyntheticPack(ctx, 'midx-tier-b', [
            { kind: 'base', type: 'blob', content: new TextEncoder().encode('tier-b') },
          ]);
          await writeMidxBytes(ctx, corrupt(buildMidx(healthyMidxSpec())));
          const warn = vi.fn();
          const sut = await createPackRegistry({ ...ctx, logger: { warn } });

          // Act
          const hit = await sut.lookup(ids[0] as ObjectId);

          // Assert — the reason fragment pins WHICH gate fired, so two rows
          // collapsing onto one guard cannot pass unnoticed.
          expect(hit).toBeDefined();
          expect(warn).toHaveBeenCalledTimes(1);
          expect(warn).toHaveBeenCalledWith(
            'packRegistry: discarding unusable multi-pack-index',
            expect.objectContaining({ reason: expect.stringContaining(reasonFragment) }),
          );
        },
      );
    });
  });

  describe('Given ctx.fs.read rejects for the midx path', () => {
    describe('When lookup is called', () => {
      it.each([
        ['FILE_NOT_FOUND', (path: string) => new TsgitError({ code: 'FILE_NOT_FOUND', path })],
        [
          'PERMISSION_DENIED',
          (path: string) => new TsgitError({ code: 'PERMISSION_DENIED', path }),
        ],
      ])('Then lookup resolves via the .idx scan with one warn (%s)', async (_label, makeError) => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'midx-io-fault', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('io') },
        ]);
        await writeMidxBytes(ctx, buildMidx(healthyMidxSpec()));
        const flatPath = midxPath(ctx);
        const warn = vi.fn();
        const wrapped: Context = {
          ...ctx,
          logger: { warn },
          fs: {
            ...ctx.fs,
            read: async (path: string) =>
              path === flatPath ? Promise.reject(makeError(path)) : ctx.fs.read(path),
          },
        };
        const sut = await createPackRegistry(wrapped);

        // Act
        const hit = await sut.lookup(ids[0] as ObjectId);

        // Assert
        expect(hit).toBeDefined();
        expect(warn).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given ctx.fs.read rejects with an errno-mapped UNSUPPORTED_OPERATION fault for the midx path', () => {
    describe('When lookup is called', () => {
      it('Then lookup rejects and .data matches exactly', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'midx-unrecognised', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('u') },
        ]);
        await writeMidxBytes(ctx, buildMidx(healthyMidxSpec()));
        const flatPath = midxPath(ctx);
        const fault = unsupportedOperation('filesystem', 'EMFILE');
        const wrapped: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: async (path: string) =>
              path === flatPath ? Promise.reject(fault) : ctx.fs.read(path),
          },
        };
        const sut = await createPackRegistry(wrapped);

        // Act
        let caught: unknown;
        try {
          await sut.lookup('a'.repeat(40) as ObjectId);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual(fault.data);
      });
    });
  });

  /** The Tier-A rows all use the flipped-signature fixture: assert the exact
   *  fault, not merely "it threw" — a re-tiered check or a foreign error class
   *  passing a bare toThrow() is the silent failure these rows exist to catch. */
  async function expectMidxSignatureRejection(promise: Promise<unknown>): Promise<void> {
    // Captured outside the try so a non-rejecting promise fails with the
    // intended message, matching expectRefusal/expectRejectsWithCheck.
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }
    if (caught === undefined) {
      expect.fail('expected the promise to reject');
    }
    const data = (caught as TsgitError).data;
    expect(data.code).toBe('INVALID_MULTI_PACK_INDEX');
    if (data.code === 'INVALID_MULTI_PACK_INDEX') {
      expect(data.check).toBe('signature');
    }
  }

  describe('Given a repo with a loose object and a structurally self-inconsistent multi-pack-index', () => {
    describe('When readObject is called for the loose object', () => {
      it('Then it rejects — a broken multi-pack-index denies loose reads too', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeObject(ctx, blob('loose-denied'));
        await writeMidxBytes(ctx, flipMidxSignature(buildMidx(healthyMidxSpec())));

        // Act + Assert
        await expectMidxSignatureRejection(readObject(ctx, id));
      });
    });
  });

  describe('Given the same repo with a merely-unusable multi-pack-index instead', () => {
    describe('When readObject is called for the loose object', () => {
      it('Then the loose object still reads', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeObject(ctx, blob('loose-control'));
        await writeMidxBytes(ctx, truncateMidxTo8(buildMidx(healthyMidxSpec())));

        // Act
        const result = await readObject(ctx, id);

        // Assert
        expect(result.type).toBe('blob');
      });
    });
  });

  describe('Given a structurally self-inconsistent multi-pack-index', () => {
    describe('When readObject is called for the empty-tree oid', () => {
      it('Then it rejects — the gate precedes the empty-tree short-circuit', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeMidxBytes(ctx, flipMidxSignature(buildMidx(healthyMidxSpec())));

        // Act + Assert
        await expectMidxSignatureRejection(readObject(ctx, EMPTY_TREE_OID));
      });
    });

    describe('When readObject is called for an oid already warmed in ctx.deltaCache', () => {
      it('Then it rejects — the gate precedes the deltaCache probe', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = 'c'.repeat(40) as ObjectId;
        const cachedContent = new TextEncoder().encode('hello');
        ctx.deltaCache.set(id, { type: 'blob', content: cachedContent }, cachedContent.length);
        await writeMidxBytes(ctx, flipMidxSignature(buildMidx(healthyMidxSpec())));

        // Act + Assert
        await expectMidxSignatureRejection(readObject(ctx, id, { verifyHash: false }));
      });
    });
  });

  describe('Given a structurally self-inconsistent flat multi-pack-index', () => {
    describe('When lookup is called three times', () => {
      it('Then all three reject and the midx is re-read on every attempt', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeMidxBytes(ctx, flipMidxSignature(buildMidx(healthyMidxSpec())));
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const sut = await createPackRegistry(instrumented);

        // Act
        for (let i = 0; i < 3; i += 1) {
          await expectMidxSignatureRejection(sut.lookup('a'.repeat(40) as ObjectId));
        }

        // Assert
        const midxReads = calls().filter(
          (call) => call.method === 'read' && call.path.endsWith('multi-pack-index'),
        );
        expect(midxReads).toHaveLength(3);
      });
    });
  });

  describe('Given a structurally self-inconsistent flat multi-pack-index, repaired without calling refresh()', () => {
    describe('When lookup is called again', () => {
      it('Then the repaired midx is picked up and lookup succeeds', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'midx-recovery', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('recover') },
        ]);
        await writeMidxBytes(ctx, flipMidxSignature(buildMidx(healthyMidxSpec())));
        const sut = await createPackRegistry(ctx);
        await expectMidxSignatureRejection(sut.lookup(ids[0] as ObjectId));

        // Act — repair in place, no refresh()
        await writeMidxBytes(ctx, buildMidx(healthyMidxSpec()));
        const hit = await sut.lookup(ids[0] as ObjectId);

        // Assert
        expect(hit).toBeDefined();
      });
    });
  });

  describe('Given a healthy pack with no midx, then a broken midx is added and refresh() is called', () => {
    describe('When lookup is called before and after refresh()', () => {
      it('Then the pre-refresh lookup succeeds and the post-refresh lookup rejects', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'midx-one-generation', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('gen') },
        ]);
        const sut = await createPackRegistry(ctx);
        const before = await sut.lookup(ids[0] as ObjectId);
        await writeMidxBytes(ctx, flipMidxSignature(buildMidx(healthyMidxSpec())));

        // Act
        sut.refresh();

        // Assert
        expect(before).toBeDefined();
        await expectMidxSignatureRejection(sut.lookup(ids[0] as ObjectId));
      });
    });
  });

  describe('Given two healthy packs and a healthy multi-pack-index', () => {
    describe('When a loose object is read', () => {
      it('Then assertLoadable lists objects/pack once for the shared listing, reads the midx once, and consults every unclaimed pack index before the loose fallback', async () => {
        // Arrange — an empty midx (`packNames: []`) claims neither pack, so
        // pack-first buffered reads must rule BOTH out via their own `.idx`
        // before falling to the loose copy — the price a mixed store pays
        // for consulting packs first, matching git's own find_pack_entry.
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'midx-assert-a', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('a') },
        ]);
        await writeSyntheticPack(ctx, 'midx-assert-b', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('b') },
        ]);
        await writeMidxBytes(ctx, buildMidx(healthyMidxSpec()));
        const looseId = await writeObject(ctx, blob('loose-only'));
        const { ctx: instrumented, calls } = instrumentedContext(ctx);

        // Act
        const result = await readObject(instrumented, looseId);

        // Assert
        expect(result.type).toBe('blob');
        const idxReads = calls().filter(
          (call) => call.method === 'read' && call.path.endsWith('.idx'),
        );
        expect(idxReads.map((call) => call.path)).toEqual([
          `${ctx.layout.gitDir}/objects/pack/pack-midx-assert-a.idx`,
          `${ctx.layout.gitDir}/objects/pack/pack-midx-assert-b.idx`,
        ]);
        const midxReads = calls().filter(
          (call) => call.method === 'read' && call.path.endsWith('multi-pack-index'),
        );
        expect(midxReads).toHaveLength(1);
        const packDirReaddirCalls = calls().filter(
          (call) => call.method === 'readdir' && call.path.endsWith('/objects/pack'),
        );
        expect(packDirReaddirCalls).toHaveLength(1);
      });
    });
  });

  describe('Given a registry whose gate has resolved but whose scan never ran', () => {
    describe('When refresh() is called and a read follows', () => {
      it('Then the multi-pack-index is probed again and the shared listing is re-read', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeMidxBytes(ctx, buildMidx(healthyMidxSpec()));
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const sut = await createPackRegistry(instrumented);
        await sut.assertLoadable();

        // Act
        sut.refresh();
        await sut.assertLoadable();

        // Assert — refresh() clears the listing alongside the gate, so the
        // second assertLoadable() re-lists objects/pack exactly as the
        // first one did.
        const readdirCalls = calls().filter((call) => call.method === 'readdir');
        expect(readdirCalls).toHaveLength(2);
        const midxReads = calls().filter(
          (call) => call.method === 'read' && call.path.endsWith('multi-pack-index'),
        );
        expect(midxReads).toHaveLength(2);
      });
    });
  });

  describe('Given a registry with a populated scan', () => {
    describe('When refresh() is called', () => {
      it('Then both the multi-pack-index and the pack directory are re-read on the next lookup', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'refresh-repopulate', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('repopulate') },
        ]);
        await writeMidxBytes(ctx, buildMidx(healthyMidxSpec()));
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const sut = await createPackRegistry(instrumented);
        await sut.all();

        // Act
        sut.refresh();
        await sut.all();

        // Assert
        const midxReads = calls().filter(
          (call) => call.method === 'read' && call.path.endsWith('multi-pack-index'),
        );
        expect(midxReads).toHaveLength(2);
        const readdirCalls = calls().filter((call) => call.method === 'readdir');
        expect(readdirCalls).toHaveLength(2);
      });
    });
  });

  describe('Given a healthy multi-pack-index and a pack whose bytes were read before dispose()', () => {
    describe('When dispose is called', () => {
      it('Then opens() equals closes() — the midx itself contributes no FileHandle', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'midx-handle-lifecycle', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('handle') },
        ]);
        await writeMidxBytes(ctx, buildMidx(healthyMidxSpec()));
        const ledger = withHandleLedger(ctx);
        const sut = await createPackRegistry(ledger.ctx);
        const pack = (await sut.all())[0]!;
        await pack.readSlice(0, 4);

        // Act
        await sut.dispose();

        // Assert
        expect(ledger.outstanding()).toBe(0);
      });
    });
  });

  describe('Given a repo with a healthy pack and no multi-pack-index', () => {
    describe("When lookup is called for that pack's only object", () => {
      it('Then at most two extra exists/stat presence probes are made and the lookup succeeds unchanged', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'midx-no-regression', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('regress') },
        ]);
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const sut = await createPackRegistry(instrumented);

        // Act
        const hit = await sut.lookup(ids[0] as ObjectId);

        // Assert
        expect(hit).toBeDefined();
        const presenceProbes = calls().filter(
          (call) =>
            (call.method === 'exists' || call.method === 'stat') &&
            call.path.includes('multi-pack-index'),
        );
        expect(presenceProbes.length).toBeLessThanOrEqual(2);
      });
    });
  });
});

describe('PackRegistry.midxHealth() — unresolved-pack reporting', () => {
  describe('Given an unresolved PNAM entry without an .idx suffix, containing a space (0x20)', () => {
    describe('When midxHealth is called', () => {
      it('Then the space is kept literal - the lower printable bound is inclusive', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeMidxBytes(ctx, buildMidx(healthyMidxSpec({ packNames: ['pack-x y'] })));
        const sut = await createPackRegistry(ctx);

        // Act
        const health = await sut.midxHealth();

        // Assert
        expect(health.unresolvedPacks).toHaveLength(1);
        expect(health.unresolvedPacks[0]?.pack).toBe('pack-x y');
      });
    });
  });

  describe('Given an unresolved PNAM entry without an .idx suffix, containing a tilde (0x7e)', () => {
    describe('When midxHealth is called', () => {
      it('Then the tilde is kept literal - the upper printable bound is inclusive', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeMidxBytes(ctx, buildMidx(healthyMidxSpec({ packNames: ['pack-x~y'] })));
        const sut = await createPackRegistry(ctx);

        // Act
        const health = await sut.midxHealth();

        // Assert
        expect(health.unresolvedPacks).toHaveLength(1);
        expect(health.unresolvedPacks[0]?.pack).toBe('pack-x~y');
      });
    });
  });

  describe('Given an unresolved PNAM entry without an .idx suffix, containing a DEL byte (0x7f)', () => {
    describe('When midxHealth is called', () => {
      it('Then the byte is hex-escaped - one past the upper printable bound', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeMidxBytes(ctx, buildMidx(healthyMidxSpec({ packNames: ['pack-xy'] })));
        const sut = await createPackRegistry(ctx);

        // Act
        const health = await sut.midxHealth();

        // Assert
        expect(health.unresolvedPacks).toHaveLength(1);
        expect(health.unresolvedPacks[0]?.pack).toBe('pack-x\\u007fy');
      });
    });
  });

  describe('Given an unresolved PNAM entry without an .idx suffix, containing a backslash (0x5c)', () => {
    describe('When midxHealth is called', () => {
      it('Then the byte is hex-escaped - never left ambiguous with a real escape sequence', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeMidxBytes(ctx, buildMidx(healthyMidxSpec({ packNames: ['pack-x\\y'] })));
        const sut = await createPackRegistry(ctx);

        // Act
        const health = await sut.midxHealth();

        // Assert
        expect(health.unresolvedPacks).toHaveLength(1);
        expect(health.unresolvedPacks[0]?.pack).toBe('pack-x\\u005cy');
      });
    });
  });

  describe('Given an unresolved PNAM name exactly at the finding name budget (256 chars)', () => {
    describe('When midxHealth is called', () => {
      it('Then no truncation marker is appended - the cap is exclusive', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const name = 'a'.repeat(256);
        await writeMidxBytes(ctx, buildMidx(healthyMidxSpec({ packNames: [name] })));
        const sut = await createPackRegistry(ctx);

        // Act
        const health = await sut.midxHealth();

        // Assert
        expect(health.unresolvedPacks).toHaveLength(1);
        expect(health.unresolvedPacks[0]?.pack).toBe(name);
        expect(health.unresolvedPacks[0]?.pack.length).toBe(256);
      });
    });
  });

  describe('Given two unresolved PNAM entries in one layer', () => {
    describe('When midxHealth is called', () => {
      it('Then each position is base plus its own packIndex, not base minus it', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeMidxBytes(
          ctx,
          buildMidx(healthyMidxSpec({ packNames: ['pack-first.idx', 'pack-second.idx'] })),
        );
        const sut = await createPackRegistry(ctx);

        // Act
        const health = await sut.midxHealth();

        // Assert
        const positions = health.unresolvedPacks.map((entry) => entry.position).sort();
        expect(positions).toEqual([0, 1]);
      });
    });
  });

  describe('Given a bound pack whose header probe rejects with a non-skippable fault', () => {
    describe('When midxHealth is called', () => {
      it('Then the fault propagates instead of marking the entry unresolved', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeSingleBlobPack(ctx, 'boom', 'boom-content');
        await writeMidxBytes(
          ctx,
          buildMidx(
            healthyMidxSpec({
              packNames: ['pack-boom.idx'],
              entries: [{ id, packIndex: 0, offset: PACK_HEADER_SIZE }],
            }),
          ),
        );
        const packPath = `${ctx.layout.gitDir}/objects/pack/pack-boom.pack`;
        const wrapped: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            openWithNoFollow: async (path: string, mode: 'read' | 'write') =>
              path === packPath
                ? Promise.reject(new Error('boom'))
                : ctx.fs.openWithNoFollow(path, mode),
          },
        };
        const sut = await createPackRegistry(wrapped);

        // Act
        let caught: unknown;
        try {
          await sut.midxHealth();
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as Error).message).toBe('boom');
      });
    });
  });
});

function packsDirOf(ctx: Context): string {
  return `${ctx.layout.gitDir}/objects/pack`;
}

/** Writes a single-blob pack under `pack-<name>`; the one entry always sits
 *  at `PACK_HEADER_SIZE` — the only offset a one-entry pack can have. */
async function writeSingleBlobPack(ctx: Context, name: string, content: string): Promise<ObjectId> {
  const ids = await writeSyntheticPack(ctx, name, [
    { kind: 'base', type: 'blob', content: new TextEncoder().encode(content) },
  ]);
  return ids[0] as ObjectId;
}

/** Hand-writes an incremental multi-pack-index chain (base → tip, matching
 *  the on-disk chain-manifest order) from fully-specified layer specs — the
 *  trailer is never verified on read, so the digest naming each layer file
 *  needs no relationship to that layer's real bytes. */
async function writeMidxChain(
  ctx: Context,
  layers: ReadonlyArray<{ readonly digest: string; readonly spec: MidxSpec }>,
): Promise<void> {
  const dir = packsDirOf(ctx);
  const chainText = `${layers.map((layer) => layer.digest).join('\n')}\n`;
  await ctx.fs.writeUtf8(`${dir}/multi-pack-index.d/multi-pack-index-chain`, chainText);
  for (const layer of layers) {
    await ctx.fs.write(
      `${dir}/multi-pack-index.d/multi-pack-index-${layer.digest}.midx`,
      buildMidx(layer.spec),
    );
  }
}

/** Rewrites a one-large-offset-entry midx's sole OOFF row to reference LOFF
 *  row 1, one past the single row the LOFF chunk actually carries. */
function forceLargeOffsetRowOutOfRange(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  const rowIndex = findMidxChunkRowIndex(copy, 'OOFF');
  const rowStart = 12 + rowIndex * 12;
  const ooffStart = view.getUint32(rowStart + 4) * 0x100000000 + view.getUint32(rowStart + 8);
  view.setUint32(ooffStart + 4, 0x80000000 | 1);
  return copy;
}

describe('PackRegistry.lookup — multi-pack-index authority', () => {
  describe('Given three healthy packs and a healthy multi-pack-index naming all three', () => {
    describe('When lookup is called for each packed oid', () => {
      it('Then every hit matches the same {pack, offset} the .idx loop alone would return', async () => {
        // Arrange
        const noMidx = await buildSeededContext();
        const idA = await writeSingleBlobPack(noMidx, 'A', 'same-answer-a');
        const idB = await writeSingleBlobPack(noMidx, 'B', 'same-answer-b');
        const idC = await writeSingleBlobPack(noMidx, 'C', 'same-answer-c');
        const control = await createPackRegistry(noMidx);

        const withMidx = await buildSeededContext();
        await writeSingleBlobPack(withMidx, 'A', 'same-answer-a');
        await writeSingleBlobPack(withMidx, 'B', 'same-answer-b');
        await writeSingleBlobPack(withMidx, 'C', 'same-answer-c');
        await writeMidxBytes(
          withMidx,
          buildMidx(
            healthyMidxSpec({
              packNames: ['pack-A.idx', 'pack-B.idx', 'pack-C.idx'],
              entries: [
                { id: idA, packIndex: 0, offset: PACK_HEADER_SIZE },
                { id: idB, packIndex: 1, offset: PACK_HEADER_SIZE },
                { id: idC, packIndex: 2, offset: PACK_HEADER_SIZE },
              ],
            }),
          ),
        );
        const sut = await createPackRegistry(withMidx);

        // Act + Assert
        for (const id of [idA, idB, idC]) {
          const expected = await control.lookup(id);
          const hit = await sut.lookup(id);
          expect(hit?.offset).toBe(expected?.offset);
          expect(hit?.pack.name).toBe(expected?.pack.name);
        }
      });
    });
  });

  describe('Given three healthy packs and a healthy multi-pack-index, one lookup for the middle pack', () => {
    describe('When lookup is called once', () => {
      it('Then exactly one .idx read is recorded — the hit pack, not all three', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const idA = await writeSingleBlobPack(ctx, 'A', 'read-count-a');
        const idB = await writeSingleBlobPack(ctx, 'B', 'read-count-b');
        const idC = await writeSingleBlobPack(ctx, 'C', 'read-count-c');
        await writeMidxBytes(
          ctx,
          buildMidx(
            healthyMidxSpec({
              packNames: ['pack-A.idx', 'pack-B.idx', 'pack-C.idx'],
              entries: [
                { id: idA, packIndex: 0, offset: PACK_HEADER_SIZE },
                { id: idB, packIndex: 1, offset: PACK_HEADER_SIZE },
                { id: idC, packIndex: 2, offset: PACK_HEADER_SIZE },
              ],
            }),
          ),
        );
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const sut = await createPackRegistry(instrumented);

        // Act
        const hit = await sut.lookup(idB);

        // Assert
        expect(hit?.pack.name).toBe('pack-B');
        const idxReads = calls().filter(
          (call) => call.method === 'read' && call.path.endsWith('.idx'),
        );
        expect(idxReads).toHaveLength(1);
        expect(idxReads[0]?.path).toBe(`${ctx.layout.gitDir}/objects/pack/pack-B.idx`);
      });
    });
  });

  describe('Given a duplicate in an UNCLAIMED pack, with the midx assigning the oid to a claimed pack whose header is broken', () => {
    describe('When lookup is called for that oid', () => {
      it('Then the unclaimed duplicate serves it — git still walks packs the midx does not name', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('duplicate-blob');
        const idsA = await writeSyntheticPack(ctx, 'A', [{ kind: 'base', type: 'blob', content }]);
        await writeSyntheticPack(ctx, 'B', [{ kind: 'base', type: 'blob', content }]);
        const dupId = idsA[0] as ObjectId;
        await restampPackHeader(ctx, `${ctx.layout.gitDir}/objects/pack/pack-A.pack`, {
          version: 99,
        });
        await writeMidxBytes(
          ctx,
          buildMidx(
            healthyMidxSpec({
              packNames: ['pack-A.idx'],
              entries: [{ id: dupId, packIndex: 0, offset: PACK_HEADER_SIZE }],
            }),
          ),
        );
        const sut = await createPackRegistry(ctx);

        // Act
        const hit = await sut.lookup(dupId);

        // Assert
        expect(hit?.pack.name).toBe('pack-B');
      });
    });
  });

  describe('Given a midx claiming pack-A while an UNCLAIMED pack-B has a corrupt .idx', () => {
    describe('When lookup misses the midx twice in a row', () => {
      it('Then both lookups miss, pack-B is skipped per-pack, and the warn fires once per generation', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const idsA = await writeSyntheticPack(ctx, 'A', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('claimed') },
        ]);
        const idsB = await writeSyntheticPack(ctx, 'B', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('unclaimed-corrupt') },
        ]);
        await ctx.fs.write(`${ctx.layout.gitDir}/objects/pack/pack-B.idx`, new Uint8Array(8));
        await writeMidxBytes(
          ctx,
          buildMidx(
            healthyMidxSpec({
              packNames: ['pack-A.idx'],
              entries: [{ id: idsA[0] as ObjectId, packIndex: 0, offset: PACK_HEADER_SIZE }],
            }),
          ),
        );
        const warn = vi.fn();
        const sut = await createPackRegistry({ ...ctx, logger: { warn } });

        // Act
        const first = await sut.lookup(idsB[0] as ObjectId);
        const second = await sut.lookup(idsB[0] as ObjectId);

        // Assert
        expect(first).toBeUndefined();
        expect(second).toBeUndefined();
        const skipWarns = warn.mock.calls.filter(
          (call) => call[0] === 'packRegistry: skipping unreadable pack index',
        );
        expect(skipWarns).toHaveLength(1);
        expect(skipWarns[0]?.[1]).toMatchObject({
          idx: 'pack-B.idx',
          code: 'INVALID_PACK_INDEX',
        });
      });
    });
  });

  describe('Given a midx claiming pack-A while an UNCLAIMED pack-B has a broken pack header', () => {
    describe('When lookup is called for an oid only pack-B holds', () => {
      it('Then the miss is reported — the unclaimed fallback never returns a header-broken hit', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const idsA = await writeSyntheticPack(ctx, 'A', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('claimed') },
        ]);
        const idsB = await writeSyntheticPack(ctx, 'B', [
          {
            kind: 'base',
            type: 'blob',
            content: new TextEncoder().encode('unclaimed-broken-header'),
          },
        ]);
        await restampPackHeader(ctx, `${ctx.layout.gitDir}/objects/pack/pack-B.pack`, {
          version: 99,
        });
        await writeMidxBytes(
          ctx,
          buildMidx(
            healthyMidxSpec({
              packNames: ['pack-A.idx'],
              entries: [{ id: idsA[0] as ObjectId, packIndex: 0, offset: PACK_HEADER_SIZE }],
            }),
          ),
        );
        const sut = await createPackRegistry(ctx);

        // Act
        const hit = await sut.lookup(idsB[0] as ObjectId);

        // Assert
        expect(hit).toBeUndefined();
      });
    });
  });

  describe('Given a duplicate in a CLAIMED sibling pack, with the midx assigning the oid to the claimed pack whose header is broken', () => {
    describe('When lookup is called for that oid', () => {
      it('Then it is missing — a claimed sibling is never consulted as a second chance', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('duplicate-blob');
        const idsA = await writeSyntheticPack(ctx, 'A', [{ kind: 'base', type: 'blob', content }]);
        await writeSyntheticPack(ctx, 'B', [{ kind: 'base', type: 'blob', content }]);
        const dupId = idsA[0] as ObjectId;
        await restampPackHeader(ctx, `${ctx.layout.gitDir}/objects/pack/pack-A.pack`, {
          version: 99,
        });
        await writeMidxBytes(
          ctx,
          buildMidx(
            healthyMidxSpec({
              packNames: ['pack-A.idx', 'pack-B.idx'],
              entries: [{ id: dupId, packIndex: 0, offset: PACK_HEADER_SIZE }],
            }),
          ),
        );
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const sut = await createPackRegistry(instrumented);

        // Act
        const hit = await sut.lookup(dupId);

        // Assert
        expect(hit).toBeUndefined();
        const packBReads = calls().filter(
          (call) => call.method === 'read' && call.path.includes('pack-B'),
        );
        expect(packBReads).toEqual([]);
      });
    });
  });

  describe('Given the same repository shape with no multi-pack-index present', () => {
    describe('When lookup is called for the duplicated oid', () => {
      it('Then it resolves via the healthy pack — the .idx loop skips the still-broken one', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('duplicate-blob-control');
        const idsA = await writeSyntheticPack(ctx, 'A', [{ kind: 'base', type: 'blob', content }]);
        await writeSyntheticPack(ctx, 'B', [{ kind: 'base', type: 'blob', content }]);
        const dupId = idsA[0] as ObjectId;
        await restampPackHeader(ctx, `${ctx.layout.gitDir}/objects/pack/pack-A.pack`, {
          version: 99,
        });
        const sut = await createPackRegistry(ctx);

        // Act
        const hit = await sut.lookup(dupId);

        // Assert
        expect(hit?.pack.name).toBe('pack-B');
      });
    });
  });

  describe('Given a multi-pack-index naming packs A and B, and pack C written after', () => {
    describe('When lookup is called for an oid only pack C holds', () => {
      it('Then it resolves normally — the .idx loop is not filtered for a pack the midx never claimed', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const idA = await writeSingleBlobPack(ctx, 'A', 'unclaimed-a');
        const idB = await writeSingleBlobPack(ctx, 'B', 'unclaimed-b');
        await writeMidxBytes(
          ctx,
          buildMidx(
            healthyMidxSpec({
              packNames: ['pack-A.idx', 'pack-B.idx'],
              entries: [
                { id: idA, packIndex: 0, offset: PACK_HEADER_SIZE },
                { id: idB, packIndex: 1, offset: PACK_HEADER_SIZE },
              ],
            }),
          ),
        );
        const idC = await writeSingleBlobPack(ctx, 'C', 'unclaimed-c');
        const sut = await createPackRegistry(ctx);

        // Act
        const hit = await sut.lookup(idC);

        // Assert
        expect(hit?.pack.name).toBe('pack-C');
        expect(hit?.offset).toBe(PACK_HEADER_SIZE);
      });
    });
  });

  describe('Given a multi-pack-index PNAM entry renamed to a name no file on disk carries', () => {
    describe('When lookup is called for the oid that entry claims', () => {
      it('Then it falls through and resolves via the ordinary .idx scan, with one warn', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const idA = await writeSingleBlobPack(ctx, 'A', 'unresolvable-pnam');
        await writeMidxBytes(
          ctx,
          buildMidx(
            healthyMidxSpec({
              packNames: ['pack-Z.idx'],
              entries: [{ id: idA, packIndex: 0, offset: PACK_HEADER_SIZE }],
            }),
          ),
        );
        const warn = vi.fn();
        const sut = await createPackRegistry({ ...ctx, logger: { warn } });

        // Act
        const hit = await sut.lookup(idA);

        // Assert
        expect(hit?.pack.name).toBe('pack-A');
        expect(warn).toHaveBeenCalledTimes(1);
        const [message, context] = warn.mock.calls[0] ?? [];
        expect(message).toBe(
          'packRegistry: multi-pack-index names a pack this scan did not register',
        );
        expect(context).toEqual({ pack: 'pack-Z.idx' });
      });
    });
  });

  describe('Given a multi-pack-index PNAM entry that fails isSafePackName', () => {
    describe('When lookup is called for the oid that entry claims', () => {
      it.each([
        ['a name containing "/"', 'pack-A/evil.idx'],
        ['a name containing ".."', '../pack-A.idx'],
      ])('Then it binds to undefined and constructs no path from %s', async (_label, badName) => {
        // Arrange — the guard's ONLY distinct observable is the logger: the
        // exact-key binding map already misses a hostile name, so the fs
        // ledger alone cannot tell the guard from the map. The guard is what
        // keeps the raw hostile bytes out of the unregistered-name warn.
        const warn = vi.fn();
        const ctx = await buildSeededContext();
        const idA = await writeSingleBlobPack(ctx, 'A', 'unsafe-pnam');
        await writeMidxBytes(
          ctx,
          buildMidx(
            healthyMidxSpec({
              packNames: [badName],
              entries: [{ id: idA, packIndex: 0, offset: PACK_HEADER_SIZE }],
            }),
          ),
        );
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const logging: Context = { ...instrumented, logger: { warn } };
        const sut = await createPackRegistry(logging);

        // Act
        const hit = await sut.lookup(idA);

        // Assert
        expect(hit?.pack.name).toBe('pack-A');
        const suspectCalls = calls().filter((call) => call.path.includes(badName));
        expect(suspectCalls).toEqual([]);
        const warnedWithHostileName = warn.mock.calls.some((call) =>
          JSON.stringify(call).includes(badName),
        );
        expect(warnedWithHostileName).toBe(false);
      });
    });
  });

  describe('Given a multi-pack-index that claims a pack but omits an oid that pack holds', () => {
    describe('When lookup is called for that oid', () => {
      it('Then it is missing — the .idx loop skips the claimed pack, and the midx has no entry for it', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const idA = await writeSingleBlobPack(ctx, 'A', 'claimed-but-omitted');
        await writeMidxBytes(
          ctx,
          buildMidx(healthyMidxSpec({ packNames: ['pack-A.idx'], entries: [] })),
        );
        const sut = await createPackRegistry(ctx);

        // Act
        const hit = await sut.lookup(idA);

        // Assert
        expect(hit).toBeUndefined();
      });
    });
  });

  describe('Given a multi-pack-index PNAM entry naming an orphaned .idx (its .pack removed)', () => {
    describe('When lookup is called for the orphan-only oid', () => {
      it('Then it is missing — the scan excluded that pack before the midx could claim it', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const orphanId = await writeSingleBlobPack(ctx, 'orphan', 'excluded-pack');
        await ctx.fs.rm(`${ctx.layout.gitDir}/objects/pack/pack-orphan.pack`);
        await writeMidxBytes(
          ctx,
          buildMidx(
            healthyMidxSpec({
              packNames: ['pack-orphan.idx'],
              entries: [{ id: orphanId, packIndex: 0, offset: PACK_HEADER_SIZE }],
            }),
          ),
        );
        const sut = await createPackRegistry(ctx);

        // Act
        const hit = await sut.lookup(orphanId);

        // Assert
        expect(hit).toBeUndefined();
      });
    });
  });

  describe('Given a two-layer chain where each layer names a different pack', () => {
    describe('When lookup is called for an oid the newer layer claims', () => {
      it("Then it resolves through that layer's own packNames, not a global list", async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const idA = await writeSingleBlobPack(ctx, 'A', 'chain-layer-a');
        const idB = await writeSingleBlobPack(ctx, 'B', 'chain-layer-b');
        await writeMidxChain(ctx, [
          {
            digest: '1'.repeat(40),
            spec: healthyMidxSpec({
              packNames: ['pack-A.idx'],
              entries: [{ id: idA, packIndex: 0, offset: PACK_HEADER_SIZE }],
            }),
          },
          {
            digest: '2'.repeat(40),
            spec: healthyMidxSpec({
              packNames: ['pack-B.idx'],
              entries: [{ id: idB, packIndex: 0, offset: PACK_HEADER_SIZE }],
            }),
          },
        ]);
        const sut = await createPackRegistry(ctx);

        // Act
        const hit = await sut.lookup(idB);

        // Assert
        expect(hit?.pack.name).toBe('pack-B');
      });
    });
  });

  describe('Given a two-layer chain where both layers list the same oid at different offsets', () => {
    describe('When lookup is called for that oid', () => {
      it("Then the newest layer's entry wins", async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSingleBlobPack(ctx, 'A', 'newest-first');
        const sharedId = 'd'.repeat(40) as ObjectId;
        await writeMidxChain(ctx, [
          {
            digest: '1'.repeat(40),
            spec: healthyMidxSpec({
              packNames: ['pack-A.idx'],
              entries: [{ id: sharedId, packIndex: 0, offset: 1000 }],
            }),
          },
          {
            digest: '2'.repeat(40),
            spec: healthyMidxSpec({
              packNames: ['pack-A.idx'],
              entries: [{ id: sharedId, packIndex: 0, offset: 2000 }],
            }),
          },
        ]);
        const sut = await createPackRegistry(ctx);

        // Act
        const hit = await sut.lookup(sharedId);

        // Assert
        expect(hit?.offset).toBe(2000);
      });
    });
  });

  describe('Given a multi-pack-index entry whose pack-int-id is out of range for its own PNAM', () => {
    describe('When lookup is called for that oid', () => {
      it("Then it rejects with check 'pack-int-id' — a deferred Tier-A fault, not a miss", async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const idA = await writeSingleBlobPack(ctx, 'A', 'pack-int-id-oob');
        await writeMidxBytes(
          ctx,
          buildMidx(
            healthyMidxSpec({
              packNames: ['pack-A.idx'],
              entries: [{ id: idA, packIndex: 5, offset: PACK_HEADER_SIZE }],
            }),
          ),
        );
        const sut = await createPackRegistry(ctx);

        // Act
        let caught: unknown;
        try {
          await sut.lookup(idA);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('INVALID_MULTI_PACK_INDEX');
        if (data.code !== 'INVALID_MULTI_PACK_INDEX') {
          expect.fail(`expected INVALID_MULTI_PACK_INDEX, got ${data.code}`);
        }
        expect(data.check).toBe('pack-int-id');
      });
    });
  });

  describe('Given a multi-pack-index whose LOFF row index is out of range for its own count', () => {
    describe('When lookup is called for that oid', () => {
      it("Then it rejects with check 'large-offset' — a deferred Tier-A fault, not a miss", async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const idA = await writeSingleBlobPack(ctx, 'A', 'large-offset-oob');
        const healthyBytes = buildMidx(
          healthyMidxSpec({
            packNames: ['pack-A.idx'],
            entries: [{ id: idA, packIndex: 0, offset: 0x80000001 }],
          }),
        );
        await writeMidxBytes(ctx, forceLargeOffsetRowOutOfRange(healthyBytes));
        const sut = await createPackRegistry(ctx);

        // Act
        let caught: unknown;
        try {
          await sut.lookup(idA);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }

        // Assert
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('INVALID_MULTI_PACK_INDEX');
        if (data.code !== 'INVALID_MULTI_PACK_INDEX') {
          expect.fail(`expected INVALID_MULTI_PACK_INDEX, got ${data.code}`);
        }
        expect(data.check).toBe('large-offset');
      });
    });
  });

  describe('Given a multi-pack-index claiming every registered pack', () => {
    describe('When all is called', () => {
      it('Then it still lists every pack — all() is not filtered by claimedNames', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const idA = await writeSingleBlobPack(ctx, 'A', 'all-unfiltered-a');
        const idB = await writeSingleBlobPack(ctx, 'B', 'all-unfiltered-b');
        await writeMidxBytes(
          ctx,
          buildMidx(
            healthyMidxSpec({
              packNames: ['pack-A.idx', 'pack-B.idx'],
              entries: [
                { id: idA, packIndex: 0, offset: PACK_HEADER_SIZE },
                { id: idB, packIndex: 1, offset: PACK_HEADER_SIZE },
              ],
            }),
          ),
        );
        const sut = await createPackRegistry(ctx);

        // Act
        const packs = await sut.all();

        // Assert
        expect(packs.map((pack) => pack.name).sort()).toEqual(['pack-A', 'pack-B']);
      });
    });
  });

  describe('Given identical packs, one repo with a multi-pack-index claiming everything and one without', () => {
    describe('When enumerateObjects is called on both', () => {
      it('Then the id sets are identical — the midx does not narrow the enumeration universe', async () => {
        // Arrange
        const withMidx = await buildSeededContext();
        const idA = await writeSingleBlobPack(withMidx, 'A', 'enumerate-a');
        const idB = await writeSingleBlobPack(withMidx, 'B', 'enumerate-b');
        await writeMidxBytes(
          withMidx,
          buildMidx(
            healthyMidxSpec({
              packNames: ['pack-A.idx', 'pack-B.idx'],
              entries: [
                { id: idA, packIndex: 0, offset: PACK_HEADER_SIZE },
                { id: idB, packIndex: 1, offset: PACK_HEADER_SIZE },
              ],
            }),
          ),
        );

        const withoutMidx = await buildSeededContext();
        await writeSingleBlobPack(withoutMidx, 'A', 'enumerate-a');
        await writeSingleBlobPack(withoutMidx, 'B', 'enumerate-b');

        // Act
        const idsWithMidx = await enumerateObjects(withMidx);
        const idsWithoutMidx = await enumerateObjects(withoutMidx);

        // Assert
        expect(idsWithMidx).toEqual(idsWithoutMidx);
      });
    });
  });

  describe('Given a healthy pack and a broken pack, with and without a multi-pack-index claiming both', () => {
    describe('When health is called on both', () => {
      it('Then the reports are identical and the midx contributes no entry of its own', async () => {
        // Arrange
        const withMidx = await buildSeededContext();
        const idA = await writeSingleBlobPack(withMidx, 'A', 'health-a');
        const idB = await writeSingleBlobPack(withMidx, 'B', 'health-b');
        await restampPackHeader(withMidx, `${withMidx.layout.gitDir}/objects/pack/pack-B.pack`, {
          version: 99,
        });
        await writeMidxBytes(
          withMidx,
          buildMidx(
            healthyMidxSpec({
              packNames: ['pack-A.idx', 'pack-B.idx'],
              entries: [
                { id: idA, packIndex: 0, offset: PACK_HEADER_SIZE },
                { id: idB, packIndex: 1, offset: PACK_HEADER_SIZE },
              ],
            }),
          ),
        );

        const withoutMidx = await buildSeededContext();
        await writeSingleBlobPack(withoutMidx, 'A', 'health-a');
        await writeSingleBlobPack(withoutMidx, 'B', 'health-b');
        await restampPackHeader(
          withoutMidx,
          `${withoutMidx.layout.gitDir}/objects/pack/pack-B.pack`,
          { version: 99 },
        );

        // Act
        const healthWithMidx = await (await createPackRegistry(withMidx)).health();
        const healthWithoutMidx = await (await createPackRegistry(withoutMidx)).health();

        // Assert
        expect(healthWithMidx.accessible.map((pack) => pack.name)).toEqual(
          healthWithoutMidx.accessible.map((pack) => pack.name),
        );
        expect(healthWithMidx.unusable).toEqual(healthWithoutMidx.unusable);
        expect(healthWithMidx.unusable).toHaveLength(1);
        expect(healthWithMidx.unusable[0]?.name).toBe('pack-B');
      });
    });
  });

  describe('Given a healthy multi-pack-index naming a pack with two objects', () => {
    describe('When lookup is called twice, once per object in that pack', () => {
      it('Then the pack header is read only once — the header memo is shared across midx-routed lookups', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'shared', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('header-memo-1') },
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('header-memo-2') },
        ]);
        const idxBytes = await ctx.fs.read(`${ctx.layout.gitDir}/objects/pack/pack-shared.idx`);
        const index = parsePackIndex(idxBytes, 20);
        const id0 = ids[0] as ObjectId;
        const id1 = ids[1] as ObjectId;
        const offset0 = lookupPackIndex(index, id0)!;
        const offset1 = lookupPackIndex(index, id1)!;
        await writeMidxBytes(
          ctx,
          buildMidx(
            healthyMidxSpec({
              packNames: ['pack-shared.idx'],
              entries: [
                { id: id0, packIndex: 0, offset: offset0 },
                { id: id1, packIndex: 0, offset: offset1 },
              ],
            }),
          ),
        );
        const ledger = withHandleLedger(ctx);
        const sut = await createPackRegistry(ledger.ctx);

        // Act
        await sut.lookup(id0);
        await sut.lookup(id1);

        // Assert
        const headerReads = ledger
          .slices()
          .filter(
            (call) =>
              call.offset === 0 &&
              call.path === `${ctx.layout.gitDir}/objects/pack/pack-shared.pack`,
          );
        expect(headerReads).toHaveLength(1);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// PACK REVERSE INDEX — hasRevIndex discovery, revIndex() memoisation
// ---------------------------------------------------------------------------

async function writeOneObjectPack(ctx: Context, name: string): Promise<void> {
  await writeSyntheticPack(ctx, name, [
    { kind: 'base', type: 'blob', content: new TextEncoder().encode(name) },
  ]);
}

describe('RegisteredPack.hasRevIndex', () => {
  describe('Given a pack whose .rev sibling is present in the scan listing', () => {
    describe('When all() is called', () => {
      it('Then hasRevIndex is true for that pack', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeOneObjectPack(ctx, 'rev-present');
        await writeSyntheticRevIndex(ctx, 'rev-present', [0]);
        const sut = await createPackRegistry(ctx);

        // Act
        const [pack] = await sut.all();

        // Assert
        expect(pack?.hasRevIndex).toBe(true);
      });
    });
  });

  describe('Given a pack with no .rev sibling in the scan listing', () => {
    describe('When all() is called', () => {
      it('Then hasRevIndex is false for that pack', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeOneObjectPack(ctx, 'rev-absent');
        const sut = await createPackRegistry(ctx);

        // Act
        const [pack] = await sut.all();

        // Assert
        expect(pack?.hasRevIndex).toBe(false);
      });
    });
  });

  describe('Given a pack whose .rev sibling is only a symlink in the scan listing', () => {
    describe('When all() is called', () => {
      it('Then hasRevIndex is false — a symlinked .rev is not present', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeOneObjectPack(ctx, 'rev-symlink');
        const wrapped = {
          ...ctx,
          fs: {
            ...ctx.fs,
            readdir: async (path: string): Promise<ReadonlyArray<DirEntry>> => [
              ...(await ctx.fs.readdir(path)),
              {
                name: 'pack-rev-symlink.rev',
                isFile: false,
                isDirectory: false,
                isSymbolicLink: true,
              },
            ],
          },
        };
        const sut = await createPackRegistry(wrapped);

        // Act
        const [pack] = await sut.all();

        // Assert
        expect(pack?.hasRevIndex).toBe(false);
      });
    });
  });
});

describe('RegisteredPack.revIndex', () => {
  describe('Given a pack with a present, valid .rev', () => {
    describe('When revIndex() is called twice concurrently', () => {
      it('Then exactly one .rev read serves both calls', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeOneObjectPack(ctx, 'rev-single-flight');
        await writeSyntheticRevIndex(ctx, 'rev-single-flight', [0]);
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const sut = await createPackRegistry(instrumented);
        const [pack] = await sut.all();

        // Act
        await Promise.all([pack!.revIndex(), pack!.revIndex()]);

        // Assert
        const revReads = calls().filter(
          (call) => call.method === 'readSlice' && call.path.endsWith('.rev'),
        );
        expect(revReads).toHaveLength(1);
      });
    });
  });

  describe('Given a pack whose .rev is rewritten between two scans', () => {
    describe('When revIndex() is called before and after refresh()', () => {
      it('Then the second call observes the newly-written bytes, not a stale memo', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeOneObjectPack(ctx, 'rev-refresh');
        await writeSyntheticRevIndex(ctx, 'rev-refresh', [0]);
        const sut = await createPackRegistry(ctx);
        const [before] = await sut.all();
        const firstLoad = await before!.revIndex();

        // Act
        await writeSyntheticRevIndex(ctx, 'rev-refresh', [0], { magic: 0 });
        sut.refresh();
        const [after] = await sut.all();
        const secondLoad = await after!.revIndex();

        // Assert
        expect(firstLoad.kind).toBe('usable');
        expect(secondLoad.kind).toBe('refused');
      });
    });
  });
});

describe('PackRegistry — pack reverse-index degradation', () => {
  describe('Given an INVALID_PACK_REV_INDEX error for each RevIndexCheck member', () => {
    describe("When checked against the registry's per-.idx and per-pack allow-lists", () => {
      it.each<RevIndexCheck>(['size', 'signature', 'version', 'hash-id'])(
        'Then neither isSkippableIdxFault nor isSkippablePackFault admits check=%s',
        (check) => {
          // Arrange
          const err = invalidPackRevIndex(check, 'test reason');

          // Act + Assert
          expect(isSkippableIdxFault(err)).toBe(false);
          expect(isSkippablePackFault(err)).toBe(false);
        },
      );
    });
  });
});

describe('PackRegistry — bitmap degradation', () => {
  describe('Given an INVALID_PACK_BITMAP error for each BitmapCheck member', () => {
    describe("When checked against the registry's per-.idx and per-pack allow-lists", () => {
      it.each<BitmapCheck>(['size', 'signature', 'version', 'options', 'stream', 'entry'])(
        'Then neither isSkippableIdxFault nor isSkippablePackFault admits check=%s',
        (check) => {
          // Arrange — the bitmap health pass never parses, so no code path
          // ever constructs one of these beyond the loader's own size gate,
          // but every member must still be closed out of both allow-lists:
          // reusing either would launder a bitmap fault into "skip this
          // pack" and could drop a healthy pack from the generation.
          const err = invalidPackBitmap(check, 'test reason');

          // Act + Assert
          expect(isSkippableIdxFault(err)).toBe(false);
          expect(isSkippablePackFault(err)).toBe(false);
        },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// PACK OFFSET TABLE — the .rev accelerator (buildOffsetTable)
// ---------------------------------------------------------------------------

const revAccelEnc = new TextEncoder();

/**
 * Object count for the describes below — small and arbitrary. The
 * object-count threshold that used to gate the `.rev` accelerator is
 * retired: a present, loadable `.rev` now wins at any pack size, so there is
 * no crossover left to clear. The arms themselves are covered far more
 * cheaply in `internal/pack-offset-table.test.ts`, which needs no pack on
 * disk; what these still prove is the REGISTRY wiring — that `offsetTable()`
 * reaches the artefact and memoises one read.
 */
const ACCEL_OBJECTS = 4;

const revAccelEntries = (n: number, prefix: string) =>
  Array.from({ length: n }, (_unused, i) => ({
    kind: 'base' as const,
    type: 'blob' as const,
    content: revAccelEnc.encode(`${prefix}-${i}`),
  }));

const revAccelIdxPath = (ctx: Context, name: string): string =>
  `${ctx.layout.gitDir}/objects/pack/pack-${name}.idx`;

/** The pack-position map the pack's own `.idx` implies — a correct `.rev` body. */
async function revAccelCorrectBody(ctx: Context, name: string): Promise<Uint32Array> {
  const idxBytes = await ctx.fs.read(revAccelIdxPath(ctx, name));
  return packPositionMap(parsePackIndex(idxBytes, 20));
}

/** `entryOffsets` for a written pack's `.idx` — the sort's own raw input. */
async function revAccelRawOffsets(ctx: Context, name: string): Promise<ReadonlyArray<number>> {
  const idxBytes = await ctx.fs.read(revAccelIdxPath(ctx, name));
  return entryOffsets(parsePackIndex(idxBytes, 20));
}

/** The expected offset table, in the same `Float64Array` shape the no-`.rev`
 *  fallback produces — sorted independently of the production code, so the
 *  oracle stays a comparison rather than a copy of the sort under test. */
function ascendingSortOf(raw: ReadonlyArray<number>): Float64Array {
  return Float64Array.from([...raw].sort((a, b) => a - b));
}

/**
 * Throws PERMISSION_DENIED for a path ending in `.rev`, delegating everything
 * else. `loadPackRevIndex` reads the artefact through `readSlice` (a single
 * bounded read, not a `stat`-then-`read` pair), so `readSlice` — not `stat` —
 * is the call this fixture must intercept for the simulated fault to reach
 * the loader at all.
 */
function withUnreadableRev(ctx: Context): Context {
  return {
    ...ctx,
    fs: {
      ...ctx.fs,
      readSlice: async (path: string, offset: number, length: number) => {
        if (path.endsWith('.rev')) throw permissionDenied(path);
        return ctx.fs.readSlice(path, offset, length);
      },
    },
  };
}

/**
 * Narrows a resolved table to its no-`.rev` fallback arm and returns the
 * materialised offsets — every describe below that inspects `sortedOffsets`
 * directly is asserting the FALLBACK, never the lazy `.rev`-backed arm (which
 * has no array to inspect by construction).
 */
function expectSortedOffsets(table: PackOffsetTable): Float64Array {
  if (table.kind !== 'sorted') {
    expect.unreachable(`expected the sorted fallback table, got kind=${table.kind}`);
  }
  return table.sortedOffsets;
}

describe('RegisteredPack.offsetTable — the .rev accelerator, identity', () => {
  describe('Given a synthetic pack with a healthy .rev, and the same pack with the .rev deleted', () => {
    describe('When offsetTable() is called on each', () => {
      it('Then the .rev arm answers lazily and nextOffsetForEntry agrees with the sorted arm for every entry', async () => {
        // Arrange
        const entries = revAccelEntries(5, 'identity');
        const withRev = await buildSeededContext();
        await writeSyntheticPack(withRev, 'identity-pack', entries);
        await writeSyntheticRevIndex(
          withRev,
          'identity-pack',
          await revAccelCorrectBody(withRev, 'identity-pack'),
        );
        const withoutRev = await buildSeededContext();
        await writeSyntheticPack(withoutRev, 'identity-pack', entries);
        const raw = await revAccelRawOffsets(withoutRev, 'identity-pack');

        // Act
        const [withRevPack] = await (await createPackRegistry(withRev)).all();
        const [withoutRevPack] = await (await createPackRegistry(withoutRev)).all();
        const withRevTable = await withRevPack!.offsetTable();
        const withoutRevTable = await withoutRevPack!.offsetTable();

        // Assert — a usable .rev never materialises a sorted table
        expect(withRevTable.kind).toBe('lazy');
        expect(withoutRevTable.kind).toBe('sorted');
        for (const offset of raw) {
          expect(nextOffsetForEntry(withRevTable, offset)).toBe(
            nextOffsetForEntry(withoutRevTable, offset),
          );
        }
      });
    });
  });

  describe('Given a 200-entry pack with a healthy .rev, offsets out of index order', () => {
    describe('When offsetTable() is called', () => {
      it('Then nextOffsetForEntry matches the sort baseline for every entry', async () => {
        // Arrange
        const entries = revAccelEntries(200, 'scale');
        const withRev = await buildSeededContext();
        await writeSyntheticPack(withRev, 'scale-pack', entries);
        await writeSyntheticRevIndex(
          withRev,
          'scale-pack',
          await revAccelCorrectBody(withRev, 'scale-pack'),
        );
        const baseline = await buildSeededContext();
        await writeSyntheticPack(baseline, 'scale-pack', entries);
        const raw = await revAccelRawOffsets(baseline, 'scale-pack');

        // Act
        const [pack] = await (await createPackRegistry(withRev)).all();
        const [baselinePack] = await (await createPackRegistry(baseline)).all();
        const table = await pack!.offsetTable();
        const baselineTable = await baselinePack!.offsetTable();

        // Assert
        expect(table.kind).toBe('lazy');
        for (const offset of raw) {
          expect(nextOffsetForEntry(table, offset)).toBe(nextOffsetForEntry(baselineTable, offset));
        }
      });
    });
  });
});

describe('RegisteredPack.offsetTable — the .rev accelerator, fallback', () => {
  describe('Given a pack with no .rev sibling', () => {
    describe('When offsetTable() is called', () => {
      it('Then sortedOffsets equals the sort, and the read still resolves objects', async () => {
        // Arrange
        const entries = revAccelEntries(4, 'fallback-absent');
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'fallback-absent', entries);
        const expected = ascendingSortOf(await revAccelRawOffsets(ctx, 'fallback-absent'));

        // Act
        const [pack] = await (await getPackRegistry(ctx)).all();
        const result = await pack!.offsetTable();

        // Assert
        expect(expectSortedOffsets(result)).toEqual(expected);
        const object = await readObject(ctx, ids[0] as ObjectId);
        expect((object as Blob).content).toEqual(revAccelEnc.encode('fallback-absent-0'));
      });
    });
  });

  describe('Given a pack whose present .rev is unreadable', () => {
    describe('When offsetTable() is called', () => {
      it('Then sortedOffsets equals the sort, and the read still resolves objects', async () => {
        // Arrange
        const entries = revAccelEntries(4, 'fallback-unreadable');
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'fallback-unreadable', entries);
        await writeSyntheticRevIndex(
          ctx,
          'fallback-unreadable',
          await revAccelCorrectBody(ctx, 'fallback-unreadable'),
        );
        const expected = ascendingSortOf(await revAccelRawOffsets(ctx, 'fallback-unreadable'));
        const wrapped = withUnreadableRev(ctx);

        // Act
        const [pack] = await (await getPackRegistry(wrapped)).all();
        const result = await pack!.offsetTable();

        // Assert
        expect(expectSortedOffsets(result)).toEqual(expected);
        const object = await readObject(wrapped, ids[0] as ObjectId);
        expect((object as Blob).content).toEqual(revAccelEnc.encode('fallback-unreadable-0'));
      });
    });
  });

  describe('Given a pack whose .rev is refused for a bad magic', () => {
    describe('When offsetTable() is called', () => {
      it('Then sortedOffsets equals the sort, and the read still resolves objects', async () => {
        // Arrange
        const entries = revAccelEntries(4, 'fallback-bad-magic');
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'fallback-bad-magic', entries);
        await writeSyntheticRevIndex(
          ctx,
          'fallback-bad-magic',
          await revAccelCorrectBody(ctx, 'fallback-bad-magic'),
          { magic: 0 },
        );
        const expected = ascendingSortOf(await revAccelRawOffsets(ctx, 'fallback-bad-magic'));

        // Act
        const [pack] = await (await getPackRegistry(ctx)).all();
        const result = await pack!.offsetTable();

        // Assert
        expect(expectSortedOffsets(result)).toEqual(expected);
        const object = await readObject(ctx, ids[0] as ObjectId);
        expect((object as Blob).content).toEqual(revAccelEnc.encode('fallback-bad-magic-0'));
      });
    });
  });

  describe('Given a pack whose .rev is refused for a wrong size', () => {
    describe('When offsetTable() is called', () => {
      it('Then sortedOffsets equals the sort, and the read still resolves objects', async () => {
        // Arrange
        const entries = revAccelEntries(4, 'fallback-wrong-size');
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'fallback-wrong-size', entries);
        await writeSyntheticRevIndex(
          ctx,
          'fallback-wrong-size',
          await revAccelCorrectBody(ctx, 'fallback-wrong-size'),
          { appendBytes: 4 },
        );
        const expected = ascendingSortOf(await revAccelRawOffsets(ctx, 'fallback-wrong-size'));

        // Act
        const [pack] = await (await getPackRegistry(ctx)).all();
        const result = await pack!.offsetTable();

        // Assert
        expect(expectSortedOffsets(result)).toEqual(expected);
        const object = await readObject(ctx, ids[0] as ObjectId);
        expect((object as Blob).content).toEqual(revAccelEnc.encode('fallback-wrong-size-0'));
      });
    });
  });

  describe('Given a pack whose on-disk .rev is longer than the exact formula and no longer starts with RIDX', () => {
    describe('When offsetTable() is called', () => {
      it('Then the bounded read refuses it for its SIZE, not its signature, and sortedOffsets equals the sort', async () => {
        // Arrange — the read asks for exactly one byte past the formula, so an
        // oversized file comes back one byte longer than the formula allows
        // and is refused on the length it came back with. The trailing bytes
        // also stop it being a reverse index at all, which is what tells the
        // two refusals apart: the loader's own gate reports the SIZE fault,
        // while `parsePackRevIndex` — reached only if that gate is gone —
        // reports the signature first.
        const entries = revAccelEntries(ACCEL_OBJECTS, 'fallback-oversized');
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'fallback-oversized', entries);
        await writeSyntheticRevIndex(
          ctx,
          'fallback-oversized',
          await revAccelCorrectBody(ctx, 'fallback-oversized'),
        );
        const revPath = `${ctx.layout.gitDir}/objects/pack/pack-fallback-oversized.rev`;
        const exact = await ctx.fs.read(revPath);
        const oversized = new Uint8Array(exact.length + 4);
        oversized.set(exact, 0);
        new DataView(oversized.buffer).setUint32(0, 0);
        await ctx.fs.write(revPath, oversized);
        const expected = ascendingSortOf(await revAccelRawOffsets(ctx, 'fallback-oversized'));
        const warn = vi.fn();
        const wrapped: Context = { ...ctx, logger: { warn } };

        // Act
        const [pack] = await (await getPackRegistry(wrapped)).all();
        const result = await pack!.offsetTable();

        // Assert
        expect(expectSortedOffsets(result)).toEqual(expected);
        expect(warn).toHaveBeenCalledTimes(1);
        const [, context] = warn.mock.calls[0] ?? [];
        // The reason, not the refusal: without the length gate these bytes
        // reach `parsePackRevIndex`, which refuses them for their signature —
        // a DIFFERENT reason under the same code.
        expect((context as { reason?: string } | undefined)?.reason).toBe(REASON_REV_INDEX_CORRUPT);
        expect((context as { rev?: string } | undefined)?.rev).toBe('pack-fallback-oversized.rev');
      });
    });
  });
});

describe('RegisteredPack.offsetTable — the .rev accelerator, logging', () => {
  describe('Given a pack whose .rev is refused', () => {
    describe('When offsetTable() is called', () => {
      it('Then ctx.logger.warn is called once with the artefact name', async () => {
        // Arrange
        const entries = revAccelEntries(ACCEL_OBJECTS, 'log-refused');
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'log-refused', entries);
        await writeSyntheticRevIndex(
          ctx,
          'log-refused',
          await revAccelCorrectBody(ctx, 'log-refused'),
          { magic: 0 },
        );
        const warn = vi.fn();
        const wrapped = { ...ctx, logger: { warn } };

        // Act
        const [pack] = await (await getPackRegistry(wrapped)).all();
        await pack!.offsetTable();

        // Assert
        expect(warn).toHaveBeenCalledTimes(1);
        const [, context] = warn.mock.calls[0] ?? [];
        expect((context as { rev?: string } | undefined)?.rev).toBe('pack-log-refused.rev');
      });
    });
  });

  describe('Given a pack whose present .rev is unreadable', () => {
    describe('When offsetTable() is called', () => {
      it('Then ctx.logger.warn is never called', async () => {
        // Arrange
        const entries = revAccelEntries(3, 'log-unreadable');
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'log-unreadable', entries);
        await writeSyntheticRevIndex(
          ctx,
          'log-unreadable',
          await revAccelCorrectBody(ctx, 'log-unreadable'),
        );
        const warn = vi.fn();
        const wrapped = { ...withUnreadableRev(ctx), logger: { warn } };

        // Act
        const [pack] = await (await getPackRegistry(wrapped)).all();
        await pack!.offsetTable();

        // Assert
        expect(warn).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a pack with no .rev sibling', () => {
    describe('When offsetTable() is called', () => {
      it('Then ctx.logger.warn is never called', async () => {
        // Arrange
        const entries = revAccelEntries(3, 'log-absent');
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'log-absent', entries);
        const warn = vi.fn();
        const wrapped = { ...ctx, logger: { warn } };

        // Act
        const [pack] = await (await getPackRegistry(wrapped)).all();
        await pack!.offsetTable();

        // Assert
        expect(warn).not.toHaveBeenCalled();
      });
    });
  });
});

describe('RegisteredPack.offsetTable — the .rev accelerator, out-of-range body', () => {
  describe('Given a pack whose .rev body[0] is one past its last index position, restamped', () => {
    describe('When offsetTable() is called', () => {
      it('Then it answers lazily — the corrupt position is discovered per query, not at build time', async () => {
        // Arrange
        const entries = revAccelEntries(ACCEL_OBJECTS, 'oob');
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'oob-pack', entries);
        const correct = await revAccelCorrectBody(ctx, 'oob-pack');
        const outOfRange = [correct.length, ...correct.slice(1)];
        await writeSyntheticRevIndex(ctx, 'oob-pack', outOfRange);

        // Act
        const [pack] = await (await getPackRegistry(ctx)).all();
        const result = await pack!.offsetTable();

        // Assert — no eager scan of the body ran, so building the table alone
        // cannot yet know the stored position is out of range.
        expect(result.kind).toBe('lazy');
      });
    });

    describe('When every object is read through it', () => {
      it('Then each one still resolves correctly — a touched corrupt position degrades that query to the sort, not a throw', async () => {
        // Arrange
        const entries = revAccelEntries(ACCEL_OBJECTS, 'oob-read');
        const ctx = await buildSeededContext();
        const ids = await writeSyntheticPack(ctx, 'oob-read-pack', entries);
        const correct = await revAccelCorrectBody(ctx, 'oob-read-pack');
        const outOfRange = [correct.length, ...correct.slice(1)];
        await writeSyntheticRevIndex(ctx, 'oob-read-pack', outOfRange);

        // Act + Assert — first, last and a middle object rather than all of
        // them: the claim is that a corrupt position never breaks a read,
        // and a bad `nextOffsetForEntry` bound shows up at the ends.
        for (const i of [0, ids.length >> 1, ids.length - 1]) {
          const object = await readObject(ctx, ids[i] as ObjectId);
          expect((object as Blob).content).toEqual(revAccelEnc.encode(`oob-read-${i}`));
        }
      });
    });
  });
});

describe('RegisteredPack.offsetTable — the .rev accelerator, read count', () => {
  describe('Given a pack with a healthy .rev', () => {
    describe('When offsetTable() is called', () => {
      it('Then the .rev is read exactly once', async () => {
        // Arrange
        const entries = revAccelEntries(ACCEL_OBJECTS, 'count-present');
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'count-present', entries);
        await writeSyntheticRevIndex(
          ctx,
          'count-present',
          await revAccelCorrectBody(ctx, 'count-present'),
        );
        const { ctx: instrumented, calls } = instrumentedContext(ctx);

        // Act
        const [pack] = await (await getPackRegistry(instrumented)).all();
        await pack!.offsetTable();

        // Assert
        const revReads = calls().filter(
          (call) => call.method === 'readSlice' && call.path.endsWith('.rev'),
        );
        expect(revReads).toHaveLength(1);
      });
    });
  });

  describe('Given a pack with no .rev sibling', () => {
    describe('When offsetTable() is called', () => {
      it('Then the .rev is never read', async () => {
        // Arrange
        const entries = revAccelEntries(3, 'count-absent');
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'count-absent', entries);
        const { ctx: instrumented, calls } = instrumentedContext(ctx);

        // Act
        const [pack] = await (await getPackRegistry(instrumented)).all();
        await pack!.offsetTable();

        // Assert
        const revReads = calls().filter(
          (call) => call.method === 'readSlice' && call.path.endsWith('.rev'),
        );
        expect(revReads).toHaveLength(0);
      });
    });
  });
});

describe('RegisteredPack.offsetTable — the .rev accelerator, single-flight', () => {
  describe('Given a pack with a healthy .rev', () => {
    describe('When offsetTable() is called twice concurrently', () => {
      it('Then exactly one .rev read serves both calls', async () => {
        // Arrange
        const entries = revAccelEntries(ACCEL_OBJECTS, 'single-flight-offset');
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'single-flight-offset', entries);
        await writeSyntheticRevIndex(
          ctx,
          'single-flight-offset',
          await revAccelCorrectBody(ctx, 'single-flight-offset'),
        );
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const [pack] = await (await getPackRegistry(instrumented)).all();

        // Act
        await Promise.all([pack!.offsetTable(), pack!.offsetTable()]);

        // Assert
        const revReads = calls().filter(
          (call) => call.method === 'readSlice' && call.path.endsWith('.rev'),
        );
        expect(revReads).toHaveLength(1);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// PACK POSITIONS — packPositions(), the bitmap closure tier's mapping memo
// ---------------------------------------------------------------------------

describe('RegisteredPack.packPositions', () => {
  describe('Given a pack with a healthy .rev, and the same pack with the .rev absent', () => {
    describe('When packPositions() is called on each', () => {
      it('Then both agree with packPositionMap(index) element-wise', async () => {
        // Arrange
        const entries = revAccelEntries(6, 'positions-identity');
        const withRev = await buildSeededContext();
        await writeSyntheticPack(withRev, 'positions-identity', entries);
        await writeSyntheticRevIndex(
          withRev,
          'positions-identity',
          await revAccelCorrectBody(withRev, 'positions-identity'),
        );
        const withoutRev = await buildSeededContext();
        await writeSyntheticPack(withoutRev, 'positions-identity', entries);
        const idxBytes = await withoutRev.fs.read(
          revAccelIdxPath(withoutRev, 'positions-identity'),
        );
        const expected = packPositionMap(parsePackIndex(idxBytes, 20));

        // Act
        const [withRevPack] = await (await createPackRegistry(withRev)).all();
        const [withoutRevPack] = await (await createPackRegistry(withoutRev)).all();
        const withRevPositions = await withRevPack!.packPositions();
        const withoutRevPositions = await withoutRevPack!.packPositions();

        // Assert
        expect(withRevPositions).toEqual(expected);
        expect(withoutRevPositions).toEqual(expected);
      });
    });
  });

  describe('Given a pack whose .rev is refused for a bad magic', () => {
    describe('When packPositions() is called', () => {
      it('Then it falls back to packPositionMap(index)', async () => {
        // Arrange
        const entries = revAccelEntries(5, 'positions-refused');
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'positions-refused', entries);
        await writeSyntheticRevIndex(
          ctx,
          'positions-refused',
          await revAccelCorrectBody(ctx, 'positions-refused'),
          { magic: 0 },
        );
        const idxBytes = await ctx.fs.read(revAccelIdxPath(ctx, 'positions-refused'));
        const expected = packPositionMap(parsePackIndex(idxBytes, 20));

        // Act
        const [pack] = await (await getPackRegistry(ctx)).all();
        const result = await pack!.packPositions();

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given a .rev body[0] out of range for a 10-object pack, restamped', () => {
    describe('When packPositions() is called', () => {
      it('Then it falls back to packPositionMap(index) rather than propagate the out-of-range value', async () => {
        // Arrange
        const entries = revAccelEntries(10, 'positions-oob');
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'positions-oob', entries);
        const correct = await revAccelCorrectBody(ctx, 'positions-oob');
        const outOfRange = [correct.length, ...correct.slice(1)];
        await writeSyntheticRevIndex(ctx, 'positions-oob', outOfRange);
        const idxBytes = await ctx.fs.read(revAccelIdxPath(ctx, 'positions-oob'));
        const expected = packPositionMap(parsePackIndex(idxBytes, 20));

        // Act
        const [pack] = await (await getPackRegistry(ctx)).all();
        const result = await pack!.packPositions();

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given a pack whose present .rev is unreadable', () => {
    describe('When packPositions() is called', () => {
      it('Then it falls back to packPositionMap(index)', async () => {
        // Arrange
        const entries = revAccelEntries(4, 'positions-unreadable');
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'positions-unreadable', entries);
        await writeSyntheticRevIndex(
          ctx,
          'positions-unreadable',
          await revAccelCorrectBody(ctx, 'positions-unreadable'),
        );
        const idxBytes = await ctx.fs.read(revAccelIdxPath(ctx, 'positions-unreadable'));
        const expected = packPositionMap(parsePackIndex(idxBytes, 20));
        const wrapped = withUnreadableRev(ctx);

        // Act
        const [pack] = await (await getPackRegistry(wrapped)).all();
        const result = await pack!.packPositions();

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given a pack with a healthy .rev', () => {
    describe('When packPositions() and offsetTable() are both called', () => {
      it('Then the .rev is read exactly once for the whole pack', async () => {
        // Arrange
        const entries = revAccelEntries(4, 'positions-single-read');
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'positions-single-read', entries);
        await writeSyntheticRevIndex(
          ctx,
          'positions-single-read',
          await revAccelCorrectBody(ctx, 'positions-single-read'),
        );
        const { ctx: instrumented, calls } = instrumentedContext(ctx);

        // Act
        const [pack] = await (await getPackRegistry(instrumented)).all();
        await Promise.all([pack!.packPositions(), pack!.offsetTable()]);

        // Assert
        const revReads = calls().filter(
          (call) => call.method === 'readSlice' && call.path.endsWith('.rev'),
        );
        expect(revReads).toHaveLength(1);
      });
    });
  });

  describe('Given a pack whose .rev is refused', () => {
    describe('When packPositions() is called', () => {
      it('Then ctx.logger.warn is never called — the fallback is silent here, unlike offsetTable', async () => {
        // Arrange
        const entries = revAccelEntries(3, 'positions-log-refused');
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'positions-log-refused', entries);
        await writeSyntheticRevIndex(
          ctx,
          'positions-log-refused',
          await revAccelCorrectBody(ctx, 'positions-log-refused'),
          { magic: 0 },
        );
        const warn = vi.fn();
        const wrapped = { ...ctx, logger: { warn } };

        // Act
        const [pack] = await (await getPackRegistry(wrapped)).all();
        await pack!.packPositions();

        // Assert
        expect(warn).not.toHaveBeenCalled();
      });
    });
  });
});

// ---------------------------------------------------------------------------
// THE .rev FALLBACK'S OWN WARNS — the message and the artefact name both,
// and the exact position at which a stored value stops naming this pack.
// ---------------------------------------------------------------------------

const REV_REFUSED_WARN = 'packRegistry: discarding unusable pack reverse index';

describe('RegisteredPack.offsetTable — what the fallback warns say', () => {
  describe('Given a pack whose .rev is refused', () => {
    describe('When offsetTable() is called', () => {
      it('Then the warn names the discard and the artefact in one message', async () => {
        // Arrange
        const entries = revAccelEntries(ACCEL_OBJECTS, 'warn-refused');
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'warn-refused', entries);
        await writeSyntheticRevIndex(
          ctx,
          'warn-refused',
          await revAccelCorrectBody(ctx, 'warn-refused'),
          { magic: 0 },
        );
        const warn = vi.fn();
        const wrapped = { ...ctx, logger: { warn } };

        // Act
        const [pack] = await (await getPackRegistry(wrapped)).all();
        await pack!.offsetTable();

        // Assert
        expect(warn).toHaveBeenCalledTimes(1);
        const [message, context] = warn.mock.calls[0] ?? [];
        expect(message).toBe(REV_REFUSED_WARN);
        expect((context as { rev?: string } | undefined)?.rev).toBe('pack-warn-refused.rev');
      });
    });
  });

  describe('Given a .rev whose first stored position is exactly the pack object count', () => {
    describe('When offsetTable() is called', () => {
      it('Then it never warns — the corrupt position is not read until a query touches it, not at build time', async () => {
        // Arrange — one past the last valid index position, the boundary
        // `offsetAtPackPosition` has to refuse rather than read `undefined`
        // off the end of the index. Unlike a REFUSED artefact (caught eagerly
        // by the one load `resolveOffsetTable` always pays), an out-of-range
        // STORED VALUE inside an otherwise well-formed `.rev` is invisible
        // until a successor lookup's binary search happens to touch it — no
        // full-body scan runs here to find it up front.
        const entries = revAccelEntries(ACCEL_OBJECTS, 'warn-oob');
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'warn-oob', entries);
        const correct = await revAccelCorrectBody(ctx, 'warn-oob');
        await writeSyntheticRevIndex(ctx, 'warn-oob', [correct.length, ...correct.slice(1)]);
        const warn = vi.fn();
        const wrapped = { ...ctx, logger: { warn } };

        // Act
        const [pack] = await (await getPackRegistry(wrapped)).all();
        const result = await pack!.offsetTable();

        // Assert
        expect(result.kind).toBe('lazy');
        expect(warn).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a .rev whose first stored position is exactly the pack object count', () => {
    describe('When packPositions() is called', () => {
      it('Then it falls back to packPositionMap(index) rather than store the boundary value', async () => {
        // Arrange
        const entries = revAccelEntries(6, 'positions-boundary');
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'positions-boundary', entries);
        const correct = await revAccelCorrectBody(ctx, 'positions-boundary');
        await writeSyntheticRevIndex(ctx, 'positions-boundary', [
          correct.length,
          ...correct.slice(1),
        ]);
        const idxBytes = await ctx.fs.read(revAccelIdxPath(ctx, 'positions-boundary'));
        const expected = packPositionMap(parsePackIndex(idxBytes, 20));

        // Act
        const [pack] = await (await getPackRegistry(ctx)).all();
        const result = await pack!.packPositions();

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});

describe('PackRegistry.reprepare', () => {
  describe('Given a registered pack with a warm window and a warm delta-base cache entry, and an unchanged pack directory', () => {
    describe('When reprepare() runs and a subsequent read touches the same pack', () => {
      it('Then the .idx is never re-read, no new handle opens, and the window/delta-base cache stay warm', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'reprepare-warm', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('warm-bytes') },
        ]);
        const ledger = withHandleLedger(ctx);
        const { ctx: instrumented, calls } = instrumentedContext(ledger.ctx);
        const registry = await createPackRegistry(instrumented);
        const [pack] = await registry.all();
        await pack!.readSlice(PACK_HEADER_SIZE, 4); // warms the handle + window cache
        registry.deltaBaseCache.set(
          'warm-key',
          { type: 3, content: new Uint8Array([1, 2, 3]), chainDepth: 0 },
          32,
        );
        const opensBeforeReprepare = ledger.opens();
        const slicesBeforeReprepare = ledger.slices().length;
        const baseline = calls().length;

        // Act
        await registry.reprepare();
        const [packAfter] = await registry.all();
        const readAfter = await packAfter!.readSlice(PACK_HEADER_SIZE, 4);

        // Assert — the SAME instance is reused, not a fresh construction.
        expect(packAfter).toBe(pack);
        // Assert — reprepare() itself re-lists the directory once.
        const readdirCalls = calls()
          .slice(baseline)
          .filter((call) => call.method === 'readdir');
        expect(readdirCalls).toHaveLength(1);
        // Assert — no .idx read anywhere in this whole flow, from either the
        // reprepare's own re-scan or the subsequent read.
        const idxReads = calls()
          .slice(baseline)
          .filter((call) => call.method === 'read' && call.path.endsWith('.idx'));
        expect(idxReads).toHaveLength(0);
        // Assert — no new handle opened and no new low-level slice read: the
        // second readSlice at the same offset serves straight from the warm
        // window cache.
        expect(ledger.opens()).toBe(opensBeforeReprepare);
        expect(ledger.slices()).toHaveLength(slicesBeforeReprepare);
        expect(Array.from(readAfter)).toHaveLength(4);
        // Assert — the delta-base cache entry survives reprepare(), unlike refresh().
        expect(registry.deltaBaseCache.has('warm-key')).toBe(true);
      });
    });
  });

  describe('Given two registered packs, one of which is deleted from disk', () => {
    describe('When reprepare() runs and settleRefresh() is awaited', () => {
      it('Then the vanished pack is retired (its handle closed) and no longer listed by all()', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'reprepare-keep', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('keep') },
        ]);
        await writeSyntheticPack(ctx, 'reprepare-vanish', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('vanish') },
        ]);
        const ledger = withHandleLedger(ctx);
        const registry = await createPackRegistry(ledger.ctx);
        const packs = await registry.all();
        const vanishing = packs.find((pack) => pack.name === 'pack-reprepare-vanish')!;
        const keeping = packs.find((pack) => pack.name === 'pack-reprepare-keep')!;
        await vanishing.readSlice(PACK_HEADER_SIZE, 4); // opens its handle
        await keeping.readSlice(PACK_HEADER_SIZE, 4); // opens its handle too
        const dir = `${ctx.layout.gitDir}/objects/pack`;
        await ctx.fs.rm(`${dir}/${vanishing.name}.pack`);
        await ctx.fs.rm(`${dir}/${vanishing.name}.idx`);

        // Act
        await registry.reprepare();
        await registry.settleRefresh();

        // Assert — only the vanished pack's handle closes; the reused,
        // still-live keeper's handle is never touched by reprepare().
        const after = await registry.all();
        expect(after.map((pack) => pack.name)).toEqual([keeping.name]);
        expect(ledger.closes()).toBe(1);
        expect(ledger.outstanding()).toBe(1);
        // Assert — the keeper still serves straight from its OWN warm
        // handle: a fresh readSlice opens no new one.
        const opensBefore = ledger.opens();
        await keeping.readSlice(PACK_HEADER_SIZE, 4);
        expect(ledger.opens()).toBe(opensBefore);
      });
    });
  });

  describe('Given a reprepare() in flight when a refresh() lands on the same synchronous turn', () => {
    describe('When lookup() runs and every in-flight operation settles', () => {
      it('Then dispose leaves no handle outstanding and the live generation holds no retired instance', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const [id] = await writeSyntheticPack(ctx, 'reprepare-refresh-race', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('race') },
        ]);
        const ledger = withHandleLedger(ctx);
        const registry = await createPackRegistry(ledger.ctx);
        const [g0Pack] = await registry.all(); // establishes G0 — no handle open yet

        // Act — reprepare() captures G0 and yields at its first await;
        // refresh() then runs to completion on this SAME synchronous turn,
        // clearing the scan before reprepare()'s continuation ever resumes.
        // lookup() triggers the fresh scan refresh() left for the next
        // reader, so reprepare()'s later resumption must recognise that its
        // own captured generation was superseded and bail rather than reuse
        // G0's now-retired instance in a scan of its own.
        const rep = registry.reprepare();
        registry.refresh();
        const hit = await registry.lookup(id as ObjectId);
        await hit!.pack.readSlice(PACK_HEADER_SIZE, 4);
        await rep;
        await registry.settleRefresh();

        // Assert — the live generation never resurrects the retired G0 instance.
        const raced = await registry.all();
        expect(raced).not.toContain(g0Pack);

        // Assert — every handle this race opened is reachable from the live
        // generation, so a full dispose() closes it: nothing is orphaned.
        await registry.dispose();
        expect(ledger.outstanding()).toBe(0);
      });
    });
  });

  describe('Given a loaded multi-pack-index bound to a registered pack', () => {
    describe('When reprepare() runs for two successive full-object misses', () => {
      it('Then the multi-pack-index is never re-statted or re-read', async () => {
        // Arrange — assertLoadable() forces the ONE midx load every read
        // already pays ahead of a loose-vs-pack branch; reprepare() must
        // keep that settled load rather than tearing it down, the way
        // `refresh()` deliberately does.
        const ctx = await buildSeededContext();
        const idA = await writeSingleBlobPack(ctx, 'A', 'midx-keep-a');
        await writeMidxBytes(
          ctx,
          buildMidx(
            healthyMidxSpec({
              packNames: ['pack-A.idx'],
              entries: [{ id: idA, packIndex: 0, offset: PACK_HEADER_SIZE }],
            }),
          ),
        );
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const registry = await createPackRegistry(instrumented);
        await registry.assertLoadable();
        const baseline = calls().length;

        // Act — two miss re-scans, mirroring rescanOnFullMiss's own
        // per-wave call to reprepare().
        await registry.reprepare();
        await registry.reprepare();

        // Assert
        const midxCalls = calls()
          .slice(baseline)
          .filter((call) => call.path.endsWith('/objects/pack/multi-pack-index'));
        expect(midxCalls).toEqual([]);
      });
    });
  });

  describe('Given a loaded multi-pack-index bound to one pack, and a second pack appearing after it loaded', () => {
    describe('When reprepare() runs and the new pack is looked up', () => {
      it('Then the new pack is found even though the kept midx does not name it', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const idA = await writeSingleBlobPack(ctx, 'A', 'midx-keep-existing');
        await writeMidxBytes(
          ctx,
          buildMidx(
            healthyMidxSpec({
              packNames: ['pack-A.idx'],
              entries: [{ id: idA, packIndex: 0, offset: PACK_HEADER_SIZE }],
            }),
          ),
        );
        const registry = await createPackRegistry(ctx);
        await registry.assertLoadable();

        // Act — a pack the kept midx has never heard of appears on disk;
        // scanPacks's own `bindMidx` re-binds the KEPT midx set against the
        // NEW pack listing, so the newcomer becomes a non-midx candidate
        // rather than an invisible one.
        const idB = await writeSingleBlobPack(ctx, 'B', 'midx-keep-new');
        await registry.reprepare();
        const hit = await registry.lookup(idB);

        // Assert
        expect(hit?.pack.name).toBe('pack-B');
      });
    });
  });

  describe('Given a probe that cached an empty fanout listing for an id, and its loose file is later written directly to disk', () => {
    describe('When resolveObject is called again for that id', () => {
      it("Then it resolves via a re-scan that drops just that id's cached fanout listing", async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('late-direct-loose-write');
        const header = serializeHeader('blob', content.length);
        const bytes = new Uint8Array(header.length + content.length);
        bytes.set(header, 0);
        bytes.set(content, header.length);
        const id = (await ctx.hash.hashHex(bytes)) as ObjectId;
        // An UNRELATED prefix, warmed up front — proves the miss's own
        // forget pass drops only the MISSED id's own prefix, never the
        // whole session's fanout cache.
        const idPrefix = id.slice(0, 2);
        const differentNibble = ((Number.parseInt(idPrefix[0]!, 16) + 1) % 16).toString(16);
        const unrelatedPrefix = `${differentNibble}${idPrefix[1]}`;
        const unrelatedId = `${unrelatedPrefix}${'0'.repeat(38)}` as ObjectId;
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        await probeLooseOid(instrumented, unrelatedId);
        const unrelatedDir = `${ctx.layout.gitDir}/objects/${unrelatedPrefix}`;
        const baseline = calls().length;

        // Probe: the first read misses everywhere, caching the (empty)
        // fanout listing for id's own prefix.
        await expect(readObject(instrumented, id)).rejects.toMatchObject({
          data: { code: 'OBJECT_NOT_FOUND' },
        });
        // Write straight through ctx.fs.write, bypassing writeObject (which
        // would invalidate the cache itself via invalidateLooseOid).
        const loosePath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`;
        const compressed = await ctx.compressor.deflate(bytes);
        await instrumented.fs.write(loosePath, compressed);

        // Act
        const result = await readObject(instrumented, id);

        // Assert
        expect(result.type).toBe('blob');
        expect((result as Blob).content).toEqual(content);
        // Assert — re-probing the unrelated prefix costs no further
        // readdir: its cached (warm) listing survived the miss's forget
        // pass untouched.
        await probeLooseOid(instrumented, unrelatedId);
        const unrelatedReaddirCalls = calls()
          .slice(baseline)
          .filter((call) => call.method === 'readdir' && call.path === unrelatedDir);
        expect(unrelatedReaddirCalls).toEqual([]);
      });
    });
  });

  describe('Given a registered pack and N sequential full misses for distinct absent ids', () => {
    describe('When resolveObject is called once per id, in sequence', () => {
      it('Then the pack directory is listed once per miss and the pack .idx is never re-read', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await writeSyntheticPack(ctx, 'sequential-miss-anchor', [
          { kind: 'base', type: 'blob', content: new TextEncoder().encode('anchor') },
        ]);
        // Build the registry against the INSTRUMENTED context from the
        // start — readObject's session-keyed registry memo would otherwise
        // keep closing over the uninstrumented ctx.fs a registry built
        // before instrumentation captured.
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const registry = await getPackRegistry(instrumented);
        await registry.all(); // warm the initial scan + .idx before counting
        const baseline = calls().length;
        const packDir = `${ctx.layout.gitDir}/objects/pack`;
        const MISS_COUNT = 20;
        const missingIds = Array.from(
          { length: MISS_COUNT },
          (_unused, i) => `${i.toString(16).padStart(2, '0')}${'0'.repeat(38)}` as ObjectId,
        );

        // Act
        for (const id of missingIds) {
          await expect(readObject(instrumented, id)).rejects.toMatchObject({
            data: { code: 'OBJECT_NOT_FOUND' },
          });
        }

        // Assert
        const readdirCalls = calls()
          .slice(baseline)
          .filter((call) => call.method === 'readdir' && call.path === packDir);
        expect(readdirCalls).toHaveLength(MISS_COUNT);
        const idxReads = calls()
          .slice(baseline)
          .filter((call) => call.method === 'read' && call.path.endsWith('.idx'));
        expect(idxReads).toHaveLength(0);
      });
    });
  });
});
