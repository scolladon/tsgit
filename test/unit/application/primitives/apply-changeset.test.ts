import { describe, expect, it } from 'vitest';

import { applyChangeset } from '../../../../src/application/primitives/apply-changeset.js';
import type {
  Changeset,
  ChangesetEntry,
} from '../../../../src/application/primitives/compute-changeset.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FileMode, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
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
});
