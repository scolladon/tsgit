import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { init } from '../../../../src/application/commands/init.js';
import {
  changedPaths,
  findTrackedBeyondSymlink,
  findWouldOverwrite,
} from '../../../../src/application/primitives/find-would-overwrite.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { GitIndex, IndexEntry } from '../../../../src/domain/git-index/index.js';
import { STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import type { MergeConflict } from '../../../../src/domain/merge/index.js';
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
  describe('Given a tracked lossy entry and a file named like its decoded view on disk', () => {
    describe('When the changed set carries the escaped key', () => {
      it('Then it is neither a local change nor untracked and the name is never probed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const committed = await blob(ctx, 'committed\n');
        await work(ctx, '\uFFFD.txt', 'view file\n');
        const lossy: IndexEntry = {
          ...entryOf('\uFFFD.txt', committed),
          pathBytes: Uint8Array.from([0xff, 0x2e, 0x74, 0x78, 0x74]),
        };
        const lstat = vi.spyOn(ctx.fs, 'lstat');

        // Act
        const result = await findWouldOverwrite(ctx, set('\uDCFF.txt'), indexOf([lossy]));

        // Assert
        expect(result).toEqual({ localChanges: [], untracked: [] });
        expect(lstat).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given an escaped path absent from the index', () => {
    describe('When the changed set carries it', () => {
      it('Then it is never reported untracked and never probed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await work(ctx, '\uFFFD.txt', 'view file\n');
        const lstat = vi.spyOn(ctx.fs, 'lstat');

        // Act
        const result = await findWouldOverwrite(ctx, set('\uDCFF.txt', '\uDCFE.txt'), indexOf([]));

        // Assert
        expect(result).toEqual({ localChanges: [], untracked: [] });
        expect(lstat).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a dirty entry whose name holds a real U+FFFD', () => {
    describe('When the changed set carries that path', () => {
      it('Then it is reported as a local change under the same name', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const committed = await blob(ctx, 'committed\n');
        await work(ctx, '\uFFFD.txt', 'dirty\n');

        // Act
        const result = await findWouldOverwrite(
          ctx,
          set('\uFFFD.txt'),
          indexOf([entryOf('\uFFFD.txt', committed)]),
        );

        // Assert
        expect(result.localChanges).toEqual(['\uFFFD.txt']);
      });
    });
  });

  describe('Given an untracked path present on disk', () => {
    describe('When the path is in the changed set', () => {
      it('Then it is reported in untracked and localChanges is empty', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await work(ctx, 'new.txt', 'squatting\n');

        // Act
        const result = await findWouldOverwrite(ctx, set('new.txt'), indexOf([]));

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

        // Act
        const result = await findWouldOverwrite(
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

        // Act
        const result = await findWouldOverwrite(
          ctx,
          set('f.txt'),
          indexOf([entryOf('f.txt', committed)]),
        );

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

        // Act
        const result = await findWouldOverwrite(
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

        // Act
        const result = await findWouldOverwrite(ctx, set('zebra', 'alpha', 'mango'), indexOf([]));

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

        // Act
        const result = await findWouldOverwrite(ctx, set(), indexOf([]));

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

        // Act
        const result = await findWouldOverwrite(
          ctx,
          set('f.txt'),
          indexOf([entryOf('f.txt', committed)]),
        );

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

        // Act
        const result = await findWouldOverwrite(ctx, set('ghost.txt'), indexOf([]));

        // Assert
        expect(result.localChanges).toEqual([]);
        expect(result.untracked).toEqual([]);
      });
    });
  });
});

describe('changedPaths', () => {
  describe('Given an unchanged outcome at a path ours does not hold', () => {
    describe('When the changed paths are listed', () => {
      it('Then the path is listed, as a rename both sides kept moves it into place', () => {
        // Arrange
        const id = 'a'.repeat(40) as ObjectId;
        const outcome = {
          status: 'unchanged',
          path: 'newdir/a' as FilePath,
          id,
          mode: FILE_MODE.REGULAR,
        } as const;
        const sut = changedPaths;

        // Act
        const result = sut([outcome], [], new Map());

        // Assert
        expect([...result]).toEqual(['newdir/a']);
      });
    });
  });
});

describe('changedPaths displaced file', () => {
  const ID = 'a'.repeat(40) as ObjectId;
  const conflictOf = (
    type: 'file-directory' | 'distinct-types',
    ourPath: string,
    theirPath: string,
  ): MergeConflict => ({
    type,
    path: 'f' as FilePath,
    ourId: ID,
    ourMode: FILE_MODE.REGULAR,
    theirId: ID,
    theirMode: FILE_MODE.SYMLINK,
    ourPath: ourPath as FilePath,
    theirPath: theirPath as FilePath,
  });

  describe('Given a file-directory conflict where ours moved its file aside', () => {
    describe('When the changed paths are listed', () => {
      it('Then the displaced file path is listed with the moved copy', () => {
        // Arrange
        const sut = changedPaths;

        // Act
        const result = sut([], [conflictOf('file-directory', 'f~HEAD', 'f/x')], new Map());

        // Assert
        expect([...result].sort()).toEqual(['f', 'f/x', 'f~HEAD']);
      });
    });
  });

  describe('Given a distinct-types conflict where ours moved its file aside', () => {
    describe('When the changed paths are listed', () => {
      it('Then the displaced file path is listed', () => {
        // Arrange
        const sut = changedPaths;

        // Act
        const result = sut([], [conflictOf('distinct-types', 'f~HEAD', 'f')], new Map());

        // Assert
        expect([...result].sort()).toEqual(['f', 'f~HEAD']);
      });
    });
  });

  describe('Given a distinct-types conflict where ours keeps the path', () => {
    describe('When the changed paths are listed', () => {
      it('Then only the recorded paths are listed', () => {
        // Arrange
        const sut = changedPaths;

        // Act
        const result = sut([], [conflictOf('distinct-types', 'f', 'f~side')], new Map());

        // Assert
        expect([...result].sort()).toEqual(['f', 'f~side']);
      });
    });
  });

  describe('Given a file-directory conflict where theirs moved its file aside', () => {
    describe('When the changed paths are listed', () => {
      it('Then the directory-side path is not added', () => {
        // Arrange
        const sut = changedPaths;
        const conflict: MergeConflict = {
          type: 'file-directory',
          path: 'f' as FilePath,
          theirId: ID,
          theirMode: FILE_MODE.REGULAR,
          theirPath: 'f~side' as FilePath,
        };

        // Act
        const result = sut([], [conflict], new Map());

        // Assert
        expect([...result]).toEqual(['f~side']);
      });
    });
  });
});

describe('findWouldOverwrite stat cache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const SEED_MS = 1_700_000_000_000;

  describe('Given a stat-clean, non-racy tracked file', () => {
    describe('When it is in the changed set', () => {
      it('Then the file is never read', async () => {
        // Arrange
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(SEED_MS);
        const ctx = createMemoryContext();
        await init(ctx);
        await work(ctx, 'a.txt', 'v1\n');
        vi.setSystemTime(SEED_MS + 2_000);
        await add(ctx, ['a.txt']);
        const currentIndex = await readIndex(ctx);
        const reads: string[] = [];
        const originalRead = ctx.fs.read.bind(ctx.fs);
        const spiedCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            read: (p, ...rest) => {
              reads.push(p);
              return originalRead(p, ...rest);
            },
          },
        };
        const sut = findWouldOverwrite;

        // Act
        const result = await sut(spiedCtx, set('a.txt'), currentIndex);

        // Assert
        expect(result.localChanges).toEqual([]);
        expect(reads).not.toContain(`${ctx.layout.workDir}/a.txt`);
      });
    });
  });
});

describe('findTrackedBeyondSymlink', () => {
  describe('Given tracked and untracked paths beneath a directory swapped for a symlink', () => {
    describe('When the changed set carries them with a tracked path beyond no link', () => {
      it('Then only the tracked paths beyond the link come back, sorted ascending', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const id = await blob(ctx, 'x\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/real/keep`, 'k\n');
        await ctx.fs.symlink('real', `${ctx.layout.workDir}/a`);
        await work(ctx, 'plain/y', 'y\n');
        const index = indexOf([
          entryOf('a/z', id),
          entryOf('a/x', id),
          entryOf('plain/y', id),
          entryOf('top', id),
        ]);

        // Act
        const result = await findTrackedBeyondSymlink(
          ctx,
          set('a/z', 'a/x', 'a/untracked', 'plain/y', 'top'),
          index,
        );

        // Assert
        expect(result).toEqual(['a/x', 'a/z']);
      });
    });
  });

  describe('Given a tracked lossy entry', () => {
    describe('When the changed set carries its escaped key', () => {
      it('Then it is never probed', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const id = await blob(ctx, 'x\n');
        const lossy: IndexEntry = {
          ...entryOf('d/\uFFFD.txt', id),
          pathBytes: Uint8Array.from([0x64, 0x2f, 0xff, 0x2e, 0x74, 0x78, 0x74]),
        };
        const lstat = vi.spyOn(ctx.fs, 'lstat');

        // Act
        const result = await findTrackedBeyondSymlink(ctx, set('d/\uDCFF.txt'), indexOf([lossy]));

        // Assert
        expect(result).toEqual([]);
        expect(lstat).not.toHaveBeenCalled();
      });
    });
  });
});
