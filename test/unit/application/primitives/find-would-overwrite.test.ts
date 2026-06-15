import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { findWouldOverwrite } from '../../../../src/application/primitives/find-would-overwrite.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import type { FileMode, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const blob = (ctx: Context, content: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });

const entryOf = (path: string, id: ObjectId, mode: FileMode = FILE_MODE.REGULAR): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id,
  flags: STAGE0_FLAGS,
  path: path as FilePath,
});

const indexOf = (entries: ReadonlyArray<IndexEntry>): GitIndex => ({
  version: 2,
  entries,
  extensions: [],
  trailerSha: new Uint8Array(0),
});

const work = (ctx: Context, path: string, content: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);

const set = (...paths: ReadonlyArray<string>): ReadonlySet<FilePath> =>
  new Set(paths.map((p) => p as FilePath));

describe('findWouldOverwrite', () => {
  describe('Given a tracked path whose working file differs from its index entry', () => {
    describe('When the path is in the changed set', () => {
      it('Then it is reported in localChanges and untracked is empty', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const committed = await blob(ctx, 'committed\n');
        await work(ctx, 'f.txt', 'dirty\n');
        const sut = findWouldOverwrite;

        // Act
        const result = await sut(ctx, set('f.txt'), indexOf([entryOf('f.txt', committed)]));

        // Assert
        expect(result.localChanges).toEqual(['f.txt']);
        expect(result.untracked).toEqual([]);
      });
    });
  });

  describe('Given an untracked path present on disk', () => {
    describe('When the path is in the changed set', () => {
      it('Then it is reported in untracked and localChanges is empty', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await work(ctx, 'new.txt', 'squatting\n');
        const sut = findWouldOverwrite;

        // Act
        const result = await sut(ctx, set('new.txt'), indexOf([]));

        // Assert
        expect(result.untracked).toEqual(['new.txt']);
        expect(result.localChanges).toEqual([]);
      });
    });
  });

  describe('Given both a tracked-dirty path and a distinct untracked squat', () => {
    describe('When both are in the changed set', () => {
      it('Then localChanges and untracked are each populated by their class', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const committed = await blob(ctx, 'committed\n');
        await work(ctx, 'tracked.txt', 'dirty\n');
        await work(ctx, 'untracked.txt', 'squatting\n');
        const sut = findWouldOverwrite;

        // Act
        const result = await sut(
          ctx,
          set('tracked.txt', 'untracked.txt'),
          indexOf([entryOf('tracked.txt', committed)]),
        );

        // Assert
        expect(result.localChanges).toEqual(['tracked.txt']);
        expect(result.untracked).toEqual(['untracked.txt']);
      });
    });
  });

  describe('Given a tracked-dirty path that also exists on disk', () => {
    describe('When it is in the changed set', () => {
      it('Then it lands in localChanges only and never in untracked', async () => {
        // Arrange — a tracked path has an index entry, so it is never probed
        // as untracked even though a working file is present on disk.
        const ctx = createMemoryContext();
        const committed = await blob(ctx, 'committed\n');
        await work(ctx, 'f.txt', 'dirty\n');
        const sut = findWouldOverwrite;

        // Act
        const result = await sut(ctx, set('f.txt'), indexOf([entryOf('f.txt', committed)]));

        // Assert
        expect(result.localChanges).toEqual(['f.txt']);
        expect(result.untracked).not.toContain('f.txt');
        expect(result.untracked).toEqual([]);
      });
    });
  });

  describe('Given several tracked-dirty paths in non-ascending order', () => {
    describe('When they are in the changed set', () => {
      it('Then localChanges is sorted ascending', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const committed = await blob(ctx, 'committed\n');
        await work(ctx, 'zebra', 'dirty\n');
        await work(ctx, 'alpha', 'dirty\n');
        await work(ctx, 'mango', 'dirty\n');
        const sut = findWouldOverwrite;

        // Act
        const result = await sut(
          ctx,
          set('zebra', 'alpha', 'mango'),
          indexOf([
            entryOf('zebra', committed),
            entryOf('alpha', committed),
            entryOf('mango', committed),
          ]),
        );

        // Assert
        expect(result.localChanges).toEqual(['alpha', 'mango', 'zebra']);
      });
    });
  });

  describe('Given several untracked squats in non-ascending order', () => {
    describe('When they are in the changed set', () => {
      it('Then untracked is sorted ascending', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await work(ctx, 'zebra', 'squat\n');
        await work(ctx, 'alpha', 'squat\n');
        await work(ctx, 'mango', 'squat\n');
        const sut = findWouldOverwrite;

        // Act
        const result = await sut(ctx, set('zebra', 'alpha', 'mango'), indexOf([]));

        // Assert
        expect(result.untracked).toEqual(['alpha', 'mango', 'zebra']);
      });
    });
  });

  describe('Given an empty changed set', () => {
    describe('When findWouldOverwrite runs', () => {
      it('Then both classes are empty', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = findWouldOverwrite;

        // Act
        const result = await sut(ctx, set(), indexOf([]));

        // Assert
        expect(result.localChanges).toEqual([]);
        expect(result.untracked).toEqual([]);
      });
    });
  });

  describe('Given a tracked path whose working file matches its index entry', () => {
    describe('When it is in the changed set', () => {
      it('Then it is reported in neither class', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const committed = await blob(ctx, 'clean\n');
        await work(ctx, 'f.txt', 'clean\n');
        const sut = findWouldOverwrite;

        // Act
        const result = await sut(ctx, set('f.txt'), indexOf([entryOf('f.txt', committed)]));

        // Assert
        expect(result.localChanges).toEqual([]);
        expect(result.untracked).toEqual([]);
      });
    });
  });

  describe('Given an untracked path absent from disk', () => {
    describe('When it is in the changed set', () => {
      it('Then it is reported in neither class', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = findWouldOverwrite;

        // Act
        const result = await sut(ctx, set('ghost.txt'), indexOf([]));

        // Assert
        expect(result.localChanges).toEqual([]);
        expect(result.untracked).toEqual([]);
      });
    });
  });
});
