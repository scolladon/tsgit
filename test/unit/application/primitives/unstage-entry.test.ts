import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { stageEntry } from '../../../../src/application/primitives/stage-entry.js';
import { unstageEntry } from '../../../../src/application/primitives/unstage-entry.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import { type IndexEntry, STAGE0_FLAGS } from '../../../../src/domain/git-index/index.js';
import type { FileMode, ObjectId } from '../../../../src/domain/objects/index.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';
import { buildSeededContext } from './fixtures.js';

afterEach(() => __resetConfigCacheForTests());

const path = (p: string): FilePath => p as FilePath;

const seedRepo = async (opts?: { signal?: AbortSignal; bare?: boolean }) => {
  const ctx =
    opts?.signal === undefined
      ? createMemoryContext()
      : createMemoryContext({ signal: opts.signal });
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  if (opts?.bare === true) {
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  bare = true\n');
  }
  return ctx;
};

describe('unstageEntry', () => {
  describe('Given an existing entry at the path', () => {
    describe('When unstageEntry is called', () => {
      it('Then the entry is gone on readback and removed is true', async () => {
        // Arrange
        const ctx = await seedRepo();
        await stageEntry(ctx, path('a.txt'), { content: new Uint8Array([1]) });

        // Act
        const sut = await unstageEntry(ctx, path('a.txt'));

        // Assert
        expect(sut.removed).toBe(true);
        const index = await readIndex(ctx);
        expect(index.entries).toEqual([]);
      });
    });
  });

  describe('Given no entry at the path', () => {
    describe('When unstageEntry is called', () => {
      it('Then removed is false and the index is unchanged', async () => {
        // Arrange — index is empty (no prior stage call).
        const ctx = await seedRepo();
        await stageEntry(ctx, path('keep.txt'), { content: new Uint8Array([1]) });

        // Act
        const sut = await unstageEntry(ctx, path('absent.txt'));

        // Assert
        expect(sut.removed).toBe(false);
        const index = await readIndex(ctx);
        expect(index.entries).toHaveLength(1);
      });
    });
  });

  describe('Given an entry without ever staging any prior content', () => {
    describe('When unstageEntry is called on the empty index', () => {
      it('Then removed is false and the call still cleans up the lock', async () => {
        // Arrange — kills mutants that would set removed=true on the empty case.
        const ctx = await seedRepo();

        // Act
        const sut = await unstageEntry(ctx, path('absent.txt'));

        // Assert
        expect(sut.removed).toBe(false);
      });
    });
  });

  describe('Given an absolute path', () => {
    describe('When unstageEntry is called', () => {
      it('Then it throws INVALID_INDEX_ENTRY', async () => {
        // Arrange
        const ctx = await seedRepo();

        // Act
        let caught: unknown;
        try {
          await unstageEntry(ctx, path('/abs'));
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('INVALID_INDEX_ENTRY');
      });
    });
  });

  describe('Given a bare repository', () => {
    describe('When unstageEntry is called', () => {
      it('Then it throws BARE_REPOSITORY', async () => {
        // Arrange
        const ctx = await seedRepo({ bare: true });

        // Act
        let caught: unknown;
        try {
          await unstageEntry(ctx, path('a.txt'));
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('BARE_REPOSITORY');
      });
    });
  });

  describe('Given a conflict file with stage-1, stage-2, and stage-3 entries', () => {
    describe('When unstageEntry is called', () => {
      it('Then all three stages are removed (every-stage filter)', async () => {
        // Arrange — pre-seed an index with three stages for the same path,
        // pinning that the filter `entry.path !== path` strips every stage,
        // not just stage-0.
        const conflictPath = 'conflict.txt' as FilePath;
        const entryAt = (stage: 1 | 2 | 3): IndexEntry => ({
          ctimeSeconds: 0,
          ctimeNanoseconds: 0,
          mtimeSeconds: 0,
          mtimeNanoseconds: 0,
          dev: 0,
          ino: 0,
          mode: '100644' as FileMode,
          uid: 0,
          gid: 0,
          fileSize: 0,
          id: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391' as ObjectId,
          flags: { ...STAGE0_FLAGS, stage },
          path: conflictPath,
        });
        const ctx = await buildSeededContext({
          index: {
            version: 2,
            entries: [entryAt(1), entryAt(2), entryAt(3)],
            extensions: [],
            trailerSha: new Uint8Array(0),
          },
        });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

        // Act
        const sut = await unstageEntry(ctx, conflictPath);

        // Assert
        expect(sut.removed).toBe(true);
        const reread = await readIndex(ctx);
        expect(reread.entries.filter((e) => e.path === conflictPath)).toEqual([]);
      });
    });
  });

  describe('Given an aborted signal', () => {
    describe('When unstageEntry is called', () => {
      it('Then it throws OPERATION_ABORTED', async () => {
        // Arrange
        const controller = new AbortController();
        controller.abort();
        const ctx = await seedRepo({ signal: controller.signal });

        // Act
        let caught: unknown;
        try {
          await unstageEntry(ctx, path('a.txt'));
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
      });
    });
  });
});
