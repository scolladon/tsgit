import { describe, expect, it } from 'vitest';

import { createWorkdirEntry } from '../../../../../src/application/primitives/snapshot/workdir-entry.js';
import type { FileMode, FilePath } from '../../../../../src/domain/objects/index.js';
import type { WorkdirEntryRow, WorkdirStat } from '../../../../../src/domain/snapshot/index.js';
import type { Context, FileStat } from '../../../../../src/ports/index.js';
import { buildSeededContext } from '../fixtures.js';

type SeededContext = Awaited<ReturnType<typeof buildSeededContext>>;

const seedFile = async (
  ctx: SeededContext,
  relPath: string,
  content: Uint8Array,
): Promise<{ readonly absPath: string; readonly stat: WorkdirStat }> => {
  const absPath = `${ctx.layout.workDir}/${relPath}`;
  await ctx.fs.write(absPath, content);
  const live = await ctx.fs.lstat(absPath);
  return {
    absPath,
    stat: {
      mode: (live.isSymbolicLink
        ? '120000'
        : (live.mode & 0o111) !== 0
          ? '100755'
          : '100644') as FileMode,
      size: live.size,
      mtimeMs: live.mtimeMs,
      ...(live.mtimeNs === undefined ? {} : { mtimeNs: live.mtimeNs }),
      ino: BigInt(live.ino),
    },
  };
};

const makeFileRow = (path: FilePath, stat: WorkdirStat): WorkdirEntryRow => ({
  source: 'workdir',
  path,
  mode: stat.mode,
  kind: 'file',
  stat,
});

describe('createWorkdirEntry', () => {
  describe('Given a regular file in the working tree', () => {
    describe('When read() is called', () => {
      it('Then it returns the file bytes verbatim', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('hello world\n');
        const { stat } = await seedFile(ctx, 'hello.txt', content);
        const sut = createWorkdirEntry(ctx, makeFileRow('hello.txt' as FilePath, stat));

        // Act
        const bytes = await sut.read();

        // Assert
        expect(bytes).toEqual(content);
      });
    });

    describe('When hash() is called', () => {
      it('Then it returns the git blob-hash hex string (40 hex chars)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('hash me');
        const { stat } = await seedFile(ctx, 'hash-me.txt', content);
        const sut = createWorkdirEntry(ctx, makeFileRow('hash-me.txt' as FilePath, stat));

        // Act
        const oid = await sut.hash();

        // Assert
        expect(oid).toMatch(/^[0-9a-f]{40}$/);
      });

      it('Then two entries over identical bytes produce identical hashes', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('identical');
        const { stat: statA } = await seedFile(ctx, 'a.txt', content);
        const { stat: statB } = await seedFile(ctx, 'b.txt', content);
        const sutA = createWorkdirEntry(ctx, makeFileRow('a.txt' as FilePath, statA));
        const sutB = createWorkdirEntry(ctx, makeFileRow('b.txt' as FilePath, statB));

        // Act
        const [hashA, hashB] = await Promise.all([sutA.hash(), sutB.hash()]);

        // Assert
        expect(hashA).toBe(hashB);
      });
    });

    describe('When readLink() is called on a non-symlink', () => {
      it('Then it throws UNSUPPORTED_OPERATION naming readLink and the actual kind', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { stat } = await seedFile(ctx, 'not-a-link.txt', new TextEncoder().encode('plain'));
        const sut = createWorkdirEntry(ctx, makeFileRow('not-a-link.txt' as FilePath, stat));

        // Act + Assert
        await expect(sut.readLink()).rejects.toMatchObject({
          data: {
            code: 'UNSUPPORTED_OPERATION',
            operation: 'readLink',
            reason: 'entry is not a symlink (kind=file)',
          },
        });
      });
    });

    describe('When verify() is called against an unchanged file', () => {
      it('Then it resolves without throwing', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { stat } = await seedFile(ctx, 'stable.txt', new TextEncoder().encode('stable'));
        const sut = createWorkdirEntry(ctx, makeFileRow('stable.txt' as FilePath, stat));

        // Act + Assert
        await expect(sut.verify()).resolves.toBeUndefined();
      });
    });

    describe('When verify() is called after the file has been rewritten', () => {
      it('Then it throws WORKDIR_RACE with observed + current stats', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { absPath, stat } = await seedFile(
          ctx,
          'changing.txt',
          new TextEncoder().encode('original'),
        );
        const sut = createWorkdirEntry(ctx, makeFileRow('changing.txt' as FilePath, stat));

        // Mutate the file so its size differs from the captured stat.
        await ctx.fs.write(absPath, new TextEncoder().encode('rewritten to a longer string'));

        // Act + Assert
        await expect(sut.verify()).rejects.toMatchObject({
          data: { code: 'WORKDIR_RACE', path: 'changing.txt' },
        });
      });
    });
  });

  describe('Given a symlink in the working tree', () => {
    describe('When readLink() is called', () => {
      it('Then it returns the symlink target string', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const linkAbs = `${ctx.layout.workDir}/link`;
        await ctx.fs.symlink('target-path', linkAbs);
        const live = await ctx.fs.lstat(linkAbs);
        const stat: WorkdirStat = {
          mode: '120000' as FileMode,
          size: live.size,
          mtimeMs: live.mtimeMs,
          ...(live.mtimeNs === undefined ? {} : { mtimeNs: live.mtimeNs }),
          ino: BigInt(live.ino),
        };
        const row: WorkdirEntryRow = {
          source: 'workdir',
          path: 'link' as FilePath,
          mode: stat.mode,
          kind: 'symlink',
          stat,
        };
        const sut = createWorkdirEntry(ctx, row);

        // Act
        const target = await sut.readLink();

        // Assert
        expect(target).toBe('target-path');
      });
    });
  });

  describe('Given a file whose live stat omits mtimeNs', () => {
    describe('When verify() detects a race', () => {
      it('Then the WORKDIR_RACE current stat carries no mtimeNs field', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { absPath, stat } = await seedFile(
          ctx,
          'no-ns.txt',
          new TextEncoder().encode('original'),
        );
        const sut = createWorkdirEntry(ctx, makeFileRow('no-ns.txt' as FilePath, stat));
        await ctx.fs.write(absPath, new TextEncoder().encode('rewritten to a longer string'));

        // Act
        const error = await sut.verify().then(
          () => undefined,
          (reason: unknown) => reason,
        );

        // Assert
        expect(error).toBeDefined();
        const data = (error as { data: { code: string; current: WorkdirStat } }).data;
        expect(data.code).toBe('WORKDIR_RACE');
        expect('mtimeNs' in data.current).toBe(false);
      });
    });
  });

  describe('Given a file whose live stat carries mtimeNs', () => {
    describe('When verify() detects a race', () => {
      it('Then the WORKDIR_RACE current stat preserves the mtimeNs value', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { absPath, stat } = await seedFile(
          ctx,
          'has-ns.txt',
          new TextEncoder().encode('seed'),
        );
        const live = await ctx.fs.lstat(absPath);
        const nsCapableCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            lstat: async (): Promise<FileStat> => ({
              ...live,
              size: live.size + 100,
              mtimeNs: 777n,
            }),
          },
        };
        const sut = createWorkdirEntry(nsCapableCtx, makeFileRow('has-ns.txt' as FilePath, stat));

        // Act
        const error = await sut.verify().then(
          () => undefined,
          (reason: unknown) => reason,
        );

        // Assert
        expect(error).toBeDefined();
        const data = (error as { data: { code: string; current: WorkdirStat } }).data;
        expect(data.code).toBe('WORKDIR_RACE');
        expect(data.current.mtimeNs).toBe(777n);
      });
    });
  });
});
