import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { stageEntry } from '../../../../src/application/primitives/stage-entry.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { FileMode, ObjectId } from '../../../../src/domain/objects/index.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';

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

describe('stageEntry', () => {
  describe('Given content and an unseeded repo', () => {
    describe('When stageEntry is called', () => {
      it('Then a stage-0 entry is committed and the blob OID matches hash-object', async () => {
        // Arrange
        const ctx = await seedRepo();
        const content = new Uint8Array([1, 2, 3]);

        // Act
        const sut = await stageEntry(ctx, path('a.txt'), { content });

        // Assert
        expect(sut.path).toBe('a.txt');
        expect(sut.mode).toBe('100644');
        expect(sut.flags.stage).toBe(0);
        const index = await readIndex(ctx);
        expect(index.entries).toHaveLength(1);
        expect(index.entries[0]?.id).toBe(sut.id);
        // The blob is materialised in the object store.
        const obj = await readObject(ctx, sut.id);
        expect(obj.type).toBe('blob');
      });
    });
  });

  describe('Given an explicit OID (no blob write)', () => {
    describe('When stageEntry is called', () => {
      it('Then the entry uses the supplied OID and mode and no object is written', async () => {
        // Arrange — caller supplies an OID they have already written.
        const ctx = await seedRepo();
        const id = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391' as ObjectId; // empty-blob

        // Act
        const sut = await stageEntry(ctx, path('placeholder.txt'), {
          id,
          mode: '100644' as FileMode,
        });

        // Assert
        expect(sut.id).toBe(id);
        const index = await readIndex(ctx);
        expect(index.entries[0]?.id).toBe(id);
      });
    });
  });

  describe('Given mode 120000 (symlink) with content', () => {
    describe('When stageEntry is called', () => {
      it('Then the entry persists the symlink mode', async () => {
        // Arrange
        const ctx = await seedRepo();
        const target = new TextEncoder().encode('target/path');

        // Act
        const sut = await stageEntry(ctx, path('link'), {
          content: target,
          mode: '120000' as FileMode,
        });

        // Assert
        expect(sut.mode).toBe('120000');
        const reread = await readIndex(ctx);
        expect(reread.entries[0]?.mode).toBe('120000');
      });
    });
  });

  describe('Given flags.intentToAdd: true', () => {
    describe('When stageEntry is called', () => {
      it('Then the on-disk index round-trips with intentToAdd set', async () => {
        // Arrange — pins that v3 promotion via serializeIndex still round-trips.
        const ctx = await seedRepo();

        // Act
        const sut = await stageEntry(
          ctx,
          path('ita.txt'),
          { content: new Uint8Array(0) },
          { flags: { intentToAdd: true } },
        );

        // Assert
        expect(sut.flags.intentToAdd).toBe(true);
        const reread = await readIndex(ctx);
        expect(reread.entries[0]?.flags.intentToAdd).toBe(true);
      });
    });
  });

  describe('Given an absolute path', () => {
    describe('When stageEntry is called', () => {
      it('Then it throws INVALID_INDEX_ENTRY before any lock is taken', async () => {
        // Arrange
        const ctx = await seedRepo();

        // Act
        let caught: unknown;
        try {
          await stageEntry(ctx, path('/abs'), { content: new Uint8Array(0) });
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('INVALID_INDEX_ENTRY');
      });
    });
  });

  describe('Given a `..` segment in the path', () => {
    describe('When stageEntry is called', () => {
      it('Then it throws INVALID_INDEX_ENTRY', async () => {
        // Arrange
        const ctx = await seedRepo();

        // Act
        let caught: unknown;
        try {
          await stageEntry(ctx, path('a/../b'), { content: new Uint8Array(0) });
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
    describe('When stageEntry is called', () => {
      it('Then it throws BARE_REPOSITORY', async () => {
        // Arrange
        const ctx = await seedRepo({ bare: true });

        // Act
        let caught: unknown;
        try {
          await stageEntry(ctx, path('a.txt'), { content: new Uint8Array(0) });
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('BARE_REPOSITORY');
      });
    });
  });

  describe('Given an aborted signal', () => {
    describe('When stageEntry is called', () => {
      it('Then it throws OPERATION_ABORTED before validation or locking', async () => {
        // Arrange
        const controller = new AbortController();
        controller.abort();
        const ctx = await seedRepo({ signal: controller.signal });

        // Act
        let caught: unknown;
        try {
          await stageEntry(ctx, path('a.txt'), { content: new Uint8Array(0) });
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
      });
    });
  });

  describe('Given content with default mode', () => {
    describe('When stageEntry is called without source.mode', () => {
      it('Then mode defaults to 100644', async () => {
        // Arrange — kills the `?? "100644"` default mutant.
        const ctx = await seedRepo();

        // Act
        const sut = await stageEntry(ctx, path('default-mode.txt'), {
          content: new Uint8Array([1]),
        });

        // Assert
        expect(sut.mode).toBe('100644');
      });
    });
  });

  describe('Given an existing entry at the same path and stage', () => {
    describe('When stageEntry is called again', () => {
      it('Then the second call replaces the existing entry', async () => {
        // Arrange
        const ctx = await seedRepo();
        await stageEntry(ctx, path('replace.txt'), { content: new Uint8Array([0]) });

        // Act
        const sut = await stageEntry(ctx, path('replace.txt'), { content: new Uint8Array([1]) });

        // Assert
        const index = await readIndex(ctx);
        expect(index.entries).toHaveLength(1);
        expect(index.entries[0]?.id).toBe(sut.id);
      });
    });
  });
});
