import { describe, expect, it, vi } from 'vitest';

import { applyChangeset } from '../../../../src/application/primitives/apply-changeset.js';
import type {
  Changeset,
  ChangesetEntry,
} from '../../../../src/application/primitives/compute-changeset.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FileMode, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import type { FileStat } from '../../../../src/ports/file-system.js';
import { buildSeededContext } from './fixtures.js';

const WORKDIR = '/repo';

const makeChangeset = (entries: ChangesetEntry[]): Changeset => {
  const stats = { add: 0, update: 0, delete: 0, noop: 0 };
  for (const e of entries) {
    if (e.kind === 'delete') stats.delete += 1;
    else stats[e.kind] += 1;
  }
  return { entries, stats };
};

const makeAdd = (
  path: string,
  id: ObjectId,
  mode: FileMode = FILE_MODE.REGULAR,
): ChangesetEntry => ({
  kind: 'add',
  path: path as FilePath,
  mode,
  id,
  previousId: undefined,
  previousMode: undefined,
});

const makeDelete = (
  path: string,
  previousId: ObjectId,
  previousMode: FileMode = FILE_MODE.REGULAR,
): ChangesetEntry => ({
  kind: 'delete',
  path: path as FilePath,
  mode: previousMode,
  id: undefined,
  previousId,
  previousMode,
});

const makeUpdate = (
  path: string,
  previousId: ObjectId,
  newId: ObjectId,
  mode: FileMode = FILE_MODE.REGULAR,
): ChangesetEntry => ({
  kind: 'update',
  path: path as FilePath,
  mode,
  id: newId,
  previousId,
  previousMode: mode,
});

const writeBlob = async (
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  content: Uint8Array,
): Promise<ObjectId> => writeObject(ctx, { type: 'blob', content, id: '' as ObjectId });

describe('applyChangeset', () => {
  it('Given an add entry for a regular file, When applyChangeset runs, Then writes the file at workdir/path with content from the blob', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const id = await writeBlob(ctx, new TextEncoder().encode('hello world'));
    const sut = applyChangeset;

    // Act
    const result = await sut(ctx, {
      changeset: makeChangeset([makeAdd('foo.txt', id)]),
      force: false,
      workdir: WORKDIR,
    });

    // Assert
    expect(result.written).toBe(1);
    expect(result.deleted).toBe(0);
    const bytes = await ctx.fs.read(`${WORKDIR}/foo.txt`);
    expect(new TextDecoder().decode(bytes)).toBe('hello world');
    expect(result.writtenEntries).toHaveLength(1);
    expect(result.writtenEntries[0]?.path).toBe('foo.txt');
    expect(result.writtenEntries[0]?.id).toBe(id);
    expect(result.writtenEntries[0]?.flags.stage).toBe(0);
  });

  it('Given an add entry with executable mode, When applyChangeset runs, Then chmods to 0o755 and records the EXECUTABLE mode', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const id = await writeBlob(ctx, new TextEncoder().encode('#!/bin/sh\n'));
    const sut = applyChangeset;

    // Act
    const result = await sut(ctx, {
      changeset: makeChangeset([makeAdd('run.sh', id, FILE_MODE.EXECUTABLE)]),
      force: false,
      workdir: WORKDIR,
    });

    // Assert
    expect(result.writtenEntries[0]?.mode).toBe(FILE_MODE.EXECUTABLE);
  });

  it('Given an add entry with symlink mode, When applyChangeset runs, Then writes a symlink whose target is the blob content', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const id = await writeBlob(ctx, new TextEncoder().encode('../target.txt'));
    const sut = applyChangeset;

    // Act
    await sut(ctx, {
      changeset: makeChangeset([makeAdd('link', id, FILE_MODE.SYMLINK)]),
      force: false,
      workdir: WORKDIR,
    });

    // Assert
    expect(await ctx.fs.readlink(`${WORKDIR}/link`)).toBe('../target.txt');
  });

  it('Given an add entry with gitlink mode, When applyChangeset runs, Then creates an empty directory placeholder', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const sut = applyChangeset;

    // Act
    await sut(ctx, {
      changeset: makeChangeset([makeAdd('sub', 'd'.repeat(40) as ObjectId, FILE_MODE.GITLINK)]),
      force: false,
      workdir: WORKDIR,
    });

    // Assert
    const stat = await ctx.fs.lstat(`${WORKDIR}/sub`);
    expect(stat.isDirectory).toBe(true);
  });

  it('Given a delete entry and the file exists in the working tree, When applyChangeset runs with force, Then removes the file', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const id = await writeBlob(ctx, new TextEncoder().encode('soon-gone'));
    await ctx.fs.write(`${WORKDIR}/doomed.txt`, new TextEncoder().encode('soon-gone'));
    const sut = applyChangeset;

    // Act
    const result = await sut(ctx, {
      changeset: makeChangeset([makeDelete('doomed.txt', id)]),
      force: true,
      workdir: WORKDIR,
    });

    // Assert
    expect(result.deleted).toBe(1);
    expect(await ctx.fs.exists(`${WORKDIR}/doomed.txt`)).toBe(false);
  });

  it('Given an update with modified working-tree content and force=false, When applyChangeset runs, Then throws CHECKOUT_OVERWRITE_DIRTY with the offending path', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const oldId = await writeBlob(ctx, new TextEncoder().encode('original'));
    const newId = await writeBlob(ctx, new TextEncoder().encode('updated'));
    // working tree has LOCAL MOD (not the original content)
    await ctx.fs.write(`${WORKDIR}/mod.txt`, new TextEncoder().encode('local-edit'));
    const sut = applyChangeset;

    // Act + Assert
    try {
      await sut(ctx, {
        changeset: makeChangeset([makeUpdate('mod.txt', oldId, newId)]),
        force: false,
        workdir: WORKDIR,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      if (!(err instanceof TsgitError)) throw err;
      expect(err.data.code).toBe('CHECKOUT_OVERWRITE_DIRTY');
      expect(err.data.code === 'CHECKOUT_OVERWRITE_DIRTY' && err.data.paths).toEqual(['mod.txt']);
    }
  });

  it('Given an update with modified working-tree content but force=true, When applyChangeset runs, Then overwrites the file', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const oldId = await writeBlob(ctx, new TextEncoder().encode('original'));
    const newId = await writeBlob(ctx, new TextEncoder().encode('updated'));
    await ctx.fs.write(`${WORKDIR}/mod.txt`, new TextEncoder().encode('local-edit'));
    const sut = applyChangeset;

    // Act
    await sut(ctx, {
      changeset: makeChangeset([makeUpdate('mod.txt', oldId, newId)]),
      force: true,
      workdir: WORKDIR,
    });

    // Assert
    expect(new TextDecoder().decode(await ctx.fs.read(`${WORKDIR}/mod.txt`))).toBe('updated');
  });

  it('Given an add entry whose target path is occupied by an untracked file and force=false, When applyChangeset runs, Then throws CHECKOUT_OVERWRITE_DIRTY', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const id = await writeBlob(ctx, new TextEncoder().encode('new'));
    await ctx.fs.write(`${WORKDIR}/clash.txt`, new TextEncoder().encode('local'));
    const sut = applyChangeset;

    // Act + Assert
    try {
      await sut(ctx, {
        changeset: makeChangeset([makeAdd('clash.txt', id)]),
        force: false,
        workdir: WORKDIR,
      });
      throw new Error('expected throw');
    } catch (err) {
      if (!(err instanceof TsgitError)) throw err;
      expect(err.data.code).toBe('CHECKOUT_OVERWRITE_DIRTY');
    }
  });

  it('Given a tracked-file read fails with PERMISSION_DENIED, When applyChangeset runs without force, Then re-throws instead of silently overwriting', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const id = await writeBlob(ctx, new TextEncoder().encode('original'));
    await ctx.fs.write(`${WORKDIR}/secret.txt`, new TextEncoder().encode('original'));
    const sut = applyChangeset;
    const wrappedCtx = {
      ...ctx,
      fs: {
        ...ctx.fs,
        read: async (p: string): Promise<Uint8Array> => {
          if (p === `${WORKDIR}/secret.txt`) {
            throw new TsgitError({ code: 'PERMISSION_DENIED', path: p });
          }
          return ctx.fs.read(p);
        },
      },
    };

    // Act + Assert
    try {
      await sut(wrappedCtx, {
        changeset: makeChangeset([
          {
            kind: 'update',
            path: 'secret.txt' as FilePath,
            mode: FILE_MODE.REGULAR,
            id,
            previousId: id,
            previousMode: FILE_MODE.REGULAR,
          },
        ]),
        force: false,
        workdir: WORKDIR,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      expect((err as TsgitError).data.code).toBe('PERMISSION_DENIED');
    }
  });

  it('Given a noop entry, When applyChangeset runs, Then leaves the working tree unchanged and does not include the entry in writtenEntries', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const id = await writeBlob(ctx, new TextEncoder().encode('static'));
    await ctx.fs.write(`${WORKDIR}/keep.txt`, new TextEncoder().encode('static'));
    const noop: ChangesetEntry = {
      kind: 'noop',
      path: 'keep.txt' as FilePath,
      mode: FILE_MODE.REGULAR,
      id,
      previousId: id,
      previousMode: FILE_MODE.REGULAR,
    };
    const sut = applyChangeset;

    // Act
    const result = await sut(ctx, {
      changeset: makeChangeset([noop]),
      force: false,
      workdir: WORKDIR,
    });

    // Assert
    expect(result.written).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.writtenEntries).toHaveLength(0);
  });

  it('Given a workdir that ends with a slash, When applyChangeset runs an add, Then joins the path without a doubled separator', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const id = await writeBlob(ctx, new TextEncoder().encode('joined'));
    const sut = applyChangeset;

    // Act
    await sut(ctx, {
      changeset: makeChangeset([makeAdd('nested.txt', id)]),
      force: false,
      workdir: '/repo/',
    });

    // Assert — exactly one separator: file lives at /repo/nested.txt, not /repo//nested.txt
    expect(await ctx.fs.exists('/repo/nested.txt')).toBe(true);
    expect(new TextDecoder().decode(await ctx.fs.read('/repo/nested.txt'))).toBe('joined');
  });

  it('Given an update whose target file is missing (FILE_NOT_FOUND on read) and force=false, When applyChangeset runs, Then treats it as non-dirty and applies without throwing', async () => {
    // Arrange — file exists() reports present but read() throws FILE_NOT_FOUND (race-gone file)
    const ctx = await buildSeededContext();
    const oldId = await writeBlob(ctx, new TextEncoder().encode('original'));
    const newId = await writeBlob(ctx, new TextEncoder().encode('updated'));
    const wrappedCtx: Context = {
      ...ctx,
      fs: {
        ...ctx.fs,
        exists: async (p: string): Promise<boolean> =>
          p === `${WORKDIR}/gone.txt` ? true : ctx.fs.exists(p),
        read: async (p: string): Promise<Uint8Array> => {
          if (p === `${WORKDIR}/gone.txt`) {
            throw new TsgitError({ code: 'FILE_NOT_FOUND', path: p });
          }
          return ctx.fs.read(p);
        },
      },
    };
    const sut = applyChangeset;

    // Act
    const result = await sut(wrappedCtx, {
      changeset: makeChangeset([makeUpdate('gone.txt', oldId, newId)]),
      force: false,
      workdir: WORKDIR,
    });

    // Assert — no CHECKOUT_OVERWRITE_DIRTY, the update is applied
    expect(result.written).toBe(1);
    expect(new TextDecoder().decode(await ctx.fs.read(`${WORKDIR}/gone.txt`))).toBe('updated');
  });

  it('Given an update whose target file is reported absent by exists() but readable, When applyChangeset runs without force, Then treats it as non-dirty and does not throw', async () => {
    // Arrange — exists() says absent; blobMatches must NOT run for an absent file
    const ctx = await buildSeededContext();
    const oldId = await writeBlob(ctx, new TextEncoder().encode('original'));
    const newId = await writeBlob(ctx, new TextEncoder().encode('updated'));
    // Working tree holds content that does NOT match previousId.
    await ctx.fs.write(`${WORKDIR}/phantom.txt`, new TextEncoder().encode('mismatching-bytes'));
    const wrappedCtx: Context = {
      ...ctx,
      fs: {
        ...ctx.fs,
        exists: async (p: string): Promise<boolean> =>
          p === `${WORKDIR}/phantom.txt` ? false : ctx.fs.exists(p),
      },
    };
    const sut = applyChangeset;

    // Act + Assert — exists()=false short-circuits to non-dirty; no throw despite mismatching bytes
    const result = await sut(wrappedCtx, {
      changeset: makeChangeset([makeUpdate('phantom.txt', oldId, newId)]),
      force: false,
      workdir: WORKDIR,
    });
    expect(result.written).toBe(1);
  });

  it('Given a delete entry with modified working-tree content and force=false, When applyChangeset runs, Then throws CHECKOUT_OVERWRITE_DIRTY with the offending path', async () => {
    // Arrange — working tree holds local edits, not the recorded previousId content
    const ctx = await buildSeededContext();
    const oldId = await writeBlob(ctx, new TextEncoder().encode('committed'));
    await ctx.fs.write(`${WORKDIR}/del.txt`, new TextEncoder().encode('local-edit'));
    const sut = applyChangeset;

    // Act + Assert
    try {
      await sut(ctx, {
        changeset: makeChangeset([makeDelete('del.txt', oldId)]),
        force: false,
        workdir: WORKDIR,
      });
      throw new Error('expected throw');
    } catch (err) {
      if (!(err instanceof TsgitError)) throw err;
      expect(err.data.code).toBe('CHECKOUT_OVERWRITE_DIRTY');
      expect(err.data.code === 'CHECKOUT_OVERWRITE_DIRTY' && err.data.paths).toEqual(['del.txt']);
    }
  });

  it('Given a symlink add whose target path is occupied by an existing file, When applyChangeset runs with force, Then removes the old file before creating the symlink', async () => {
    // Arrange — a regular file already occupies the symlink's path
    const ctx = await buildSeededContext();
    const id = await writeBlob(ctx, new TextEncoder().encode('./elsewhere'));
    await ctx.fs.write(`${WORKDIR}/lnk`, new TextEncoder().encode('stale-regular-file'));
    const sut = applyChangeset;

    // Act
    await sut(ctx, {
      changeset: makeChangeset([makeAdd('lnk', id, FILE_MODE.SYMLINK)]),
      force: true,
      workdir: WORKDIR,
    });

    // Assert — path is now a symlink (rm ran first, otherwise symlink would fail)
    expect(await ctx.fs.readlink(`${WORKDIR}/lnk`)).toBe('./elsewhere');
  });

  it('Given an add entry with regular mode, When applyChangeset runs, Then chmods the file to 0o644', async () => {
    // Arrange — capture the mode argument passed to chmod
    const ctx = await buildSeededContext();
    const id = await writeBlob(ctx, new TextEncoder().encode('plain'));
    const chmodMode = vi.fn<(path: string, mode: number) => Promise<void>>(async () => undefined);
    const wrappedCtx: Context = {
      ...ctx,
      fs: { ...ctx.fs, chmod: chmodMode },
    };
    const sut = applyChangeset;

    // Act
    await sut(wrappedCtx, {
      changeset: makeChangeset([makeAdd('plain.txt', id, FILE_MODE.REGULAR)]),
      force: false,
      workdir: WORKDIR,
    });

    // Assert
    expect(chmodMode).toHaveBeenCalledWith(`${WORKDIR}/plain.txt`, 0o644);
  });

  it('Given an add entry with executable mode, When applyChangeset runs, Then chmods the file to 0o755', async () => {
    // Arrange — capture the mode argument passed to chmod
    const ctx = await buildSeededContext();
    const id = await writeBlob(ctx, new TextEncoder().encode('#!/bin/sh\n'));
    const chmodMode = vi.fn<(path: string, mode: number) => Promise<void>>(async () => undefined);
    const wrappedCtx: Context = {
      ...ctx,
      fs: { ...ctx.fs, chmod: chmodMode },
    };
    const sut = applyChangeset;

    // Act
    await sut(wrappedCtx, {
      changeset: makeChangeset([makeAdd('run.sh', id, FILE_MODE.EXECUTABLE)]),
      force: false,
      workdir: WORKDIR,
    });

    // Assert
    expect(chmodMode).toHaveBeenCalledWith(`${WORKDIR}/run.sh`, 0o755);
  });

  it('Given an lstat with sub-second ctime/mtime nanoseconds, When applyChangeset builds the index entry, Then records seconds floored from ms and nanoseconds taken modulo one billion', async () => {
    // Arrange — controlled lstat values that distinguish * vs / vs % mutations
    const ctx = await buildSeededContext();
    const id = await writeBlob(ctx, new TextEncoder().encode('timed'));
    const fakeStat = (base: FileStat): FileStat => ({
      ...base,
      ctimeMs: 5000.9, // floor(/1000) => 5 ; *1000 would be 5_000_900
      mtimeMs: 9000.4, // floor(/1000) => 9
      ctimeNs: 7_000_000_123n, // % 1e9 => 123 ; * 1e9 would be huge
      mtimeNs: 4_000_000_456n, // % 1e9 => 456
    });
    const wrappedCtx: Context = {
      ...ctx,
      fs: {
        ...ctx.fs,
        lstat: async (p: string): Promise<FileStat> => fakeStat(await ctx.fs.lstat(p)),
      },
    };
    const sut = applyChangeset;

    // Act
    const result = await sut(wrappedCtx, {
      changeset: makeChangeset([makeAdd('timed.txt', id)]),
      force: false,
      workdir: WORKDIR,
    });

    // Assert
    const entry = result.writtenEntries[0];
    expect(entry?.ctimeSeconds).toBe(5);
    expect(entry?.mtimeSeconds).toBe(9);
    expect(entry?.ctimeNanoseconds).toBe(123);
    expect(entry?.mtimeNanoseconds).toBe(456);
  });

  it('Given an lstat without nanosecond precision, When applyChangeset builds the index entry, Then defaults ctime/mtime nanoseconds to zero', async () => {
    // Arrange — ctimeNs/mtimeNs undefined exercises the `?? 0n` fallback
    const ctx = await buildSeededContext();
    const id = await writeBlob(ctx, new TextEncoder().encode('no-ns'));
    const wrappedCtx: Context = {
      ...ctx,
      fs: {
        ...ctx.fs,
        lstat: async (p: string): Promise<FileStat> => {
          const { ctimeNs: _ctimeNs, mtimeNs: _mtimeNs, ...rest } = await ctx.fs.lstat(p);
          return rest;
        },
      },
    };
    const sut = applyChangeset;

    // Act
    const result = await sut(wrappedCtx, {
      changeset: makeChangeset([makeAdd('no-ns.txt', id)]),
      force: false,
      workdir: WORKDIR,
    });

    // Assert — `?? 0n` yields 0n; `&&` would yield undefined => NaN
    const entry = result.writtenEntries[0];
    expect(entry?.ctimeNanoseconds).toBe(0);
    expect(entry?.mtimeNanoseconds).toBe(0);
  });

  it('Given a freshly written index entry, When applyChangeset builds it, Then assumeValid is false', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const id = await writeBlob(ctx, new TextEncoder().encode('flagged'));
    const sut = applyChangeset;

    // Act
    const result = await sut(ctx, {
      changeset: makeChangeset([makeAdd('flagged.txt', id)]),
      force: false,
      workdir: WORKDIR,
    });

    // Assert
    expect(result.writtenEntries[0]?.flags.assumeValid).toBe(false);
  });

  it('Given a freshly written index entry, When applyChangeset builds it, Then the extended flag is false', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const id = await writeBlob(ctx, new TextEncoder().encode('extflag'));
    const sut = applyChangeset;

    // Act
    const result = await sut(ctx, {
      changeset: makeChangeset([makeAdd('extflag.txt', id)]),
      force: false,
      workdir: WORKDIR,
    });

    // Assert — a fresh entry never carries extended flags
    expect(result.writtenEntries[0]?.flags.extended).toBe(false);
  });

  it('Given a delete entry whose target file does not exist, When applyChangeset runs with force, Then does not call rm and completes without throwing', async () => {
    // Arrange — no file on disk for the delete target
    const ctx = await buildSeededContext();
    const id = await writeBlob(ctx, new TextEncoder().encode('phantom'));
    const sut = applyChangeset;

    // Act
    const result = await sut(ctx, {
      changeset: makeChangeset([makeDelete('absent.txt', id)]),
      force: true,
      workdir: WORKDIR,
    });

    // Assert — rm on a missing path would throw FILE_NOT_FOUND; the guard prevents it
    expect(result.deleted).toBe(1);
  });

  it('Given a noop entry, When applyChangeset runs, Then does not report progress for it', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const id = await writeBlob(ctx, new TextEncoder().encode('untouched'));
    await ctx.fs.write(`${WORKDIR}/keep.txt`, new TextEncoder().encode('untouched'));
    const progressUpdate = vi.fn();
    const wrappedCtx: Context = {
      ...ctx,
      progress: { ...ctx.progress, update: progressUpdate },
    };
    const noop: ChangesetEntry = {
      kind: 'noop',
      path: 'keep.txt' as FilePath,
      mode: FILE_MODE.REGULAR,
      id,
      previousId: id,
      previousMode: FILE_MODE.REGULAR,
    };
    const sut = applyChangeset;

    // Act
    await sut(wrappedCtx, {
      changeset: makeChangeset([noop]),
      force: false,
      workdir: WORKDIR,
    });

    // Assert
    expect(progressUpdate).not.toHaveBeenCalled();
  });

  it('Given a mix of add and delete entries, When applyChangeset reports progress, Then current counts written plus deleted and total sums add, update and delete stats', async () => {
    // Arrange — 1 add + 1 delete => after both, current must be 2 (written+deleted), total 2
    const ctx = await buildSeededContext();
    const addId = await writeBlob(ctx, new TextEncoder().encode('fresh'));
    const delId = await writeBlob(ctx, new TextEncoder().encode('stale'));
    await ctx.fs.write(`${WORKDIR}/old.txt`, new TextEncoder().encode('stale'));
    const progressUpdate =
      vi.fn<(op: string, current: number, total?: number, text?: string) => void>();
    const wrappedCtx: Context = {
      ...ctx,
      progress: { ...ctx.progress, update: progressUpdate },
    };
    const sut = applyChangeset;

    // Act
    await sut(wrappedCtx, {
      changeset: makeChangeset([makeAdd('new.txt', addId), makeDelete('old.txt', delId)]),
      force: true,
      workdir: WORKDIR,
    });

    // Assert — last call: current = written(1) + deleted(1) = 2 ; total = add(1)+update(0)+delete(1) = 2
    const lastCall = progressUpdate.mock.calls.at(-1);
    expect(lastCall?.[1]).toBe(2);
    expect(lastCall?.[2]).toBe(2);
  });
});
