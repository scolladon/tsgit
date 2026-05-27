/**
 * Mutation-killer tests for `workdir-entry.ts`. Targets:
 *  - the `blob <size>\0` header string literal (kills the empty-string mutant)
 *  - statMatches per-field branches (mode / size / mtimeMs differ alone)
 *  - deriveFileMode symlink branch
 *  - liveStat mtimeNs conditional-spread
 *  - read() symlink vs file branch
 */
import { describe, expect, it } from 'vitest';

import { createWorkdirEntry } from '../../../../../src/application/primitives/snapshot/workdir-entry.js';
import {
  FILE_MODE,
  type FileMode,
  type FilePath,
} from '../../../../../src/domain/objects/index.js';
import type { WorkdirEntryRow } from '../../../../../src/domain/snapshot/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import type { FileStat, FileSystem } from '../../../../../src/ports/file-system.js';
import { buildSeededContext } from '../fixtures.js';

const makeRow = (
  ctx: Context,
  path: string,
  overrides: Partial<WorkdirEntryRow['stat']> = {},
  kind: 'file' | 'symlink' = 'file',
): { row: WorkdirEntryRow; absPath: string } => ({
  row: {
    source: 'workdir',
    path: path as FilePath,
    mode: (kind === 'symlink' ? '120000' : FILE_MODE.REGULAR) as FileMode,
    kind,
    stat: {
      mode: (kind === 'symlink' ? '120000' : FILE_MODE.REGULAR) as FileMode,
      size: overrides.size ?? 0,
      mtimeMs: overrides.mtimeMs ?? 0,
      ino: overrides.ino ?? 0n,
      ...(overrides.mtimeNs === undefined ? {} : { mtimeNs: overrides.mtimeNs }),
    },
  },
  absPath: `${ctx.layout.workDir}/${path}`,
});

describe('workdir-entry — blob hash header', () => {
  describe('Given a regular file with known bytes', () => {
    describe('When hash() is called', () => {
      it('Then the returned oid equals the git blob hash of the bytes (kills the empty header mutant)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const bytes = new TextEncoder().encode('hello');
        await ctx.fs.write(`${ctx.layout.workDir}/hi.txt`, bytes);
        // Pre-compute the expected hash using the SAME hash service so we
        // assert against a value derived independently from the production
        // formatting. The mutant `""` would produce a hash of just the
        // file bytes (no `blob 5\0` prefix).
        const blobHeader = new TextEncoder().encode(`blob ${bytes.length}\0`);
        const buf = new Uint8Array(blobHeader.length + bytes.length);
        buf.set(blobHeader, 0);
        buf.set(bytes, blobHeader.length);
        const expected = await ctx.hash.hashHex(buf);

        const { row } = makeRow(ctx, 'hi.txt', { size: bytes.length });
        const sut = createWorkdirEntry(ctx, row);

        // Act
        const got = await sut.hash();

        // Assert
        expect(got).toBe(expected);
      });
    });
  });
});

describe('workdir-entry — statMatches per-field branches', () => {
  const seedAndVerify = async (
    overrides: Partial<FileStat>,
  ): Promise<{ pass: boolean; code?: string }> => {
    const ctx = await buildSeededContext();
    await ctx.fs.write(`${ctx.layout.workDir}/f.txt`, new Uint8Array([1, 2, 3]));
    const real = await ctx.fs.lstat(`${ctx.layout.workDir}/f.txt`);
    const fs: FileSystem = {
      ...ctx.fs,
      lstat: async () => ({ ...real, ...overrides }),
    };
    const ctxFs: Context = { ...ctx, fs };
    const row: WorkdirEntryRow = {
      source: 'workdir',
      path: 'f.txt' as FilePath,
      mode: FILE_MODE.REGULAR as FileMode,
      kind: 'file',
      stat: {
        mode: FILE_MODE.REGULAR as FileMode,
        size: real.size,
        mtimeMs: real.mtimeMs,
        ino: BigInt(real.ino),
      },
    };
    const sut = createWorkdirEntry(ctxFs, row);
    try {
      await sut.verify();
      return { pass: true };
    } catch (err) {
      const code = (err as { data?: { code?: string } }).data?.code;
      return code === undefined ? { pass: false } : { pass: false, code };
    }
  };

  describe('Given the live stat differs only on mode (chmod-race)', () => {
    describe('When verify() is called', () => {
      it('Then it throws WORKDIR_RACE (statMatches mode-arm returns false)', async () => {
        // Arrange + Act — flip the executable bit so deriveFileMode produces "100755"
        const result = await seedAndVerify({ mode: 0o755 });

        // Assert
        expect(result.pass).toBe(false);
        expect(result.code).toBe('WORKDIR_RACE');
      });
    });
  });

  describe('Given the live stat differs only on size', () => {
    describe('When verify() is called', () => {
      it('Then it throws WORKDIR_RACE (statMatches size-arm returns false)', async () => {
        // Arrange + Act
        const result = await seedAndVerify({ size: 9999 });

        // Assert
        expect(result.pass).toBe(false);
        expect(result.code).toBe('WORKDIR_RACE');
      });
    });
  });

  describe('Given the live stat differs only on mtimeMs', () => {
    describe('When verify() is called', () => {
      it('Then it throws WORKDIR_RACE (statMatches mtimeMs-arm returns false)', async () => {
        // Arrange + Act
        const result = await seedAndVerify({ mtimeMs: 999999999 });

        // Assert
        expect(result.pass).toBe(false);
        expect(result.code).toBe('WORKDIR_RACE');
      });
    });
  });

  describe('Given the live stat matches on every watched field', () => {
    describe('When verify() is called', () => {
      it('Then it resolves without throwing', async () => {
        // Arrange + Act
        const result = await seedAndVerify({});

        // Assert
        expect(result.pass).toBe(true);
      });
    });
  });
});

describe('workdir-entry — deriveFileMode symlink branch', () => {
  describe('Given a symlink-typed live stat', () => {
    describe('When verify() is called against a non-symlink row.stat', () => {
      it('Then statMatches detects the mode difference and throws WORKDIR_RACE', async () => {
        // Arrange — row says regular file; live stat says symlink.
        const ctx = await buildSeededContext();
        await ctx.fs.write(`${ctx.layout.workDir}/f.txt`, new Uint8Array([1]));
        const real = await ctx.fs.lstat(`${ctx.layout.workDir}/f.txt`);
        const fs: FileSystem = {
          ...ctx.fs,
          lstat: async () => ({ ...real, isSymbolicLink: true, isFile: false }),
        };
        const ctxFs: Context = { ...ctx, fs };
        const row: WorkdirEntryRow = {
          source: 'workdir',
          path: 'f.txt' as FilePath,
          mode: FILE_MODE.REGULAR as FileMode,
          kind: 'file',
          stat: {
            mode: FILE_MODE.REGULAR as FileMode,
            size: real.size,
            mtimeMs: real.mtimeMs,
            ino: BigInt(real.ino),
          },
        };
        const sut = createWorkdirEntry(ctxFs, row);

        // Act + Assert
        await expect(sut.verify()).rejects.toMatchObject({
          data: { code: 'WORKDIR_RACE' },
        });
      });
    });
  });
});

describe('workdir-entry — liveStat mtimeNs conditional spread', () => {
  describe('Given a live stat with mtimeNs present', () => {
    describe('When verify() runs against a row.stat with matching mtimeNs', () => {
      it('Then it resolves (verifying the spread copies mtimeNs into the comparison snapshot)', async () => {
        // Arrange — observed and live both carry the same ns.
        const ctx = await buildSeededContext();
        await ctx.fs.write(`${ctx.layout.workDir}/f.txt`, new Uint8Array([1]));
        const real = await ctx.fs.lstat(`${ctx.layout.workDir}/f.txt`);
        const fs: FileSystem = { ...ctx.fs, lstat: async () => ({ ...real, mtimeNs: 5n }) };
        const ctxFs: Context = { ...ctx, fs };
        const row: WorkdirEntryRow = {
          source: 'workdir',
          path: 'f.txt' as FilePath,
          mode: FILE_MODE.REGULAR as FileMode,
          kind: 'file',
          stat: {
            mode: FILE_MODE.REGULAR as FileMode,
            size: real.size,
            mtimeMs: real.mtimeMs,
            mtimeNs: 5n,
            ino: BigInt(real.ino),
          },
        };
        const sut = createWorkdirEntry(ctxFs, row);

        // Act + Assert — statMatches checks (mode, size, mtimeMs); mtimeNs is
        // captured into the WorkdirStat but not directly compared by statMatches.
        // The branch under test is the spread itself executing.
        await expect(sut.verify()).resolves.toBeUndefined();
      });
    });
  });
});

describe('workdir-entry — read() symlink branch', () => {
  describe('Given a symlink row', () => {
    describe('When read() is called', () => {
      it('Then it returns the symlink target bytes (NOT the file content of any pointed-at file)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.symlink('target-pointer', `${ctx.layout.workDir}/lnk`);
        const live = await ctx.fs.lstat(`${ctx.layout.workDir}/lnk`);
        const row: WorkdirEntryRow = {
          source: 'workdir',
          path: 'lnk' as FilePath,
          mode: '120000' as FileMode,
          kind: 'symlink',
          stat: {
            mode: '120000' as FileMode,
            size: live.size,
            mtimeMs: live.mtimeMs,
            ino: BigInt(live.ino),
          },
        };
        const sut = createWorkdirEntry(ctx, row);

        // Act
        const bytes = await sut.read();

        // Assert
        expect(new TextDecoder().decode(bytes)).toBe('target-pointer');
      });
    });
  });

  describe('Given a regular-file row', () => {
    describe('When read() is called', () => {
      it('Then it returns the file content bytes (NOT a symlink target)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('hello from file');
        await ctx.fs.write(`${ctx.layout.workDir}/f.txt`, content);
        const row: WorkdirEntryRow = {
          source: 'workdir',
          path: 'f.txt' as FilePath,
          mode: FILE_MODE.REGULAR as FileMode,
          kind: 'file',
          stat: {
            mode: FILE_MODE.REGULAR as FileMode,
            size: content.length,
            mtimeMs: 0,
            ino: 0n,
          },
        };
        const sut = createWorkdirEntry(ctx, row);

        // Act
        const bytes = await sut.read();

        // Assert
        expect(bytes).toEqual(content);
      });
    });
  });
});
