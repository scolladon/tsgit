import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { hasObject } from '../../../../../src/application/primitives/has-object.js';
import { forgetLooseOidPrefix } from '../../../../../src/application/primitives/internal/loose-oid-cache.js';
import {
  isCacheTreeFullyValid,
  updateCacheTree,
} from '../../../../../src/application/primitives/internal/update-cache-tree.js';
import { looseObjectPath } from '../../../../../src/application/primitives/path-layout.js';
import { readTree } from '../../../../../src/application/primitives/read-tree.js';
import { invalidateCacheTree } from '../../../../../src/domain/git-index/cache-tree.js';
import {
  type CacheTreeEntry,
  type IndexEntry,
  type IndexEntryFlags,
  STAGE0_FLAGS,
} from '../../../../../src/domain/git-index/index-entry.js';
import { FILE_MODE, FilePath } from '../../../../../src/domain/objects/index.js';
import type { ObjectId } from '../../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../../src/ports/context.js';

vi.mock('../../../../../src/application/primitives/has-object.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../../../src/application/primitives/has-object.js')
    >();
  return { ...actual, hasObject: vi.fn(actual.hasObject) };
});

const entryAt = (path: string, flags: IndexEntryFlags = STAGE0_FLAGS): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: FILE_MODE.REGULAR,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id: 'f'.repeat(40) as ObjectId,
  flags,
  path: FilePath.from(path),
});

const ITA: IndexEntryFlags = { ...STAGE0_FLAGS, intentToAdd: true };

const entriesOf = (...paths: string[]): IndexEntry[] => paths.map((path) => entryAt(path));

const nodesOf = (root: CacheTreeEntry): CacheTreeEntry[] => [
  root,
  ...root.children.flatMap(nodesOf),
];

const childNamed = (root: CacheTreeEntry, name: string): CacheTreeEntry => {
  const found = root.children.find((child) => child.path === name);
  if (found === undefined) throw new Error(`no child ${name}`);
  return found;
};

const deleteObject = async (ctx: Context, id: ObjectId | undefined): Promise<void> => {
  await ctx.fs.rm(looseObjectPath(ctx.layout.gitDir, id as ObjectId));
  forgetLooseOidPrefix(ctx, id as ObjectId);
};

const countWrites = (ctx: Context): (() => number) => {
  const spies = [
    vi.spyOn(ctx.fs, 'write'),
    vi.spyOn(ctx.fs, 'writeStream'),
    vi.spyOn(ctx.fs, 'writeExclusive'),
  ];
  return () => spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
};

describe('updateCacheTree', () => {
  describe('Given entries whose c tree was never stored', () => {
    const setup = async () => {
      const ctx = createMemoryContext();
      await updateCacheTree(ctx, entriesOf('a/f'), undefined, 'write');
      return ctx;
    };

    describe('When repairing', () => {
      it('Then c and the root are invalid, a stays valid and nothing is written', async () => {
        // Arrange
        const ctx = await setup();
        const writes = countWrites(ctx);
        // Act
        const result = await updateCacheTree(ctx, entriesOf('a/f', 'c/g'), undefined, 'repair');
        // Assert
        expect(childNamed(result.cacheTree, 'a').entryCount).toBe(1);
        expect(childNamed(result.cacheTree, 'c').entryCount).toBe(-1);
        expect(result.cacheTree.entryCount).toBe(-1);
        expect(writes()).toBe(0);
      });
    });
  });

  describe('Given entries whose trees all exist', () => {
    describe('When repairing', () => {
      it('Then the tree is fully valid and the ids equal the written ones', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = entriesOf('a/x/f', 'b/f', 'top');
        const written = await updateCacheTree(ctx, entries, undefined, 'write');
        // Act
        const result = await updateCacheTree(ctx, entries, undefined, 'repair');
        // Assert
        expect(result.cacheTree).toEqual(written.cacheTree);
      });
    });
  });

  describe('Given an unmerged entry under d', () => {
    describe('When repairing', () => {
      it('Then d and the root are invalid', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = [...entriesOf('a/f'), entryAt('d/f', { ...STAGE0_FLAGS, stage: 2 })];
        await updateCacheTree(ctx, entriesOf('a/f'), undefined, 'write');
        // Act
        const result = await updateCacheTree(ctx, entries, undefined, 'repair');
        // Assert
        expect(childNamed(result.cacheTree, 'd').entryCount).toBe(-1);
        expect(result.cacheTree.entryCount).toBe(-1);
      });
    });
  });

  describe('Given a memory repo and entries without a carried tree', () => {
    describe('When updating in write mode', () => {
      it('Then every node is valid, stored, and the root id is the written root tree', async () => {
        // Arrange
        const ctx = createMemoryContext();
        // Act
        const result = await updateCacheTree(
          ctx,
          entriesOf('a/x/f', 'b/f', 'top'),
          undefined,
          'write',
        );
        // Assert
        const nodes = nodesOf(result.cacheTree);
        expect(result.cacheTree.entryCount).toBe(3);
        expect(result.cacheTree.subtreeCount).toBe(2);
        expect(nodes.every((n) => n.entryCount >= 0 && n.id !== undefined)).toBe(true);
        expect(result.cacheTree.id).toBe(result.rootTree);
        for (const n of nodes) expect(await hasObject(ctx, n.id as ObjectId)).toBe(true);
      });
    });
  });

  describe('Given a valid reused subtree carrying several descendants', () => {
    describe('When updating in write mode', () => {
      it('Then the reused subtree costs exactly one existence check', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = entriesOf('big/d1/f', 'big/d2/f', 'big/d3/f', 'other');
        const first = await updateCacheTree(ctx, entries, undefined, 'write');
        const carried = invalidateCacheTree(first.cacheTree, [entries[3] as IndexEntry]);
        vi.mocked(hasObject).mockClear();
        // Act
        const result = await updateCacheTree(ctx, entries, carried, 'write');
        // Assert
        const probed = vi.mocked(hasObject).mock.calls.map(([, id]) => id);
        expect(probed).toEqual([childNamed(first.cacheTree, 'big').id]);
        expect(result.rootTree).toBe(first.rootTree);
      });
    });
  });

  describe('Given a carried tree with one chain invalidated', () => {
    const setup = async () => {
      const ctx = createMemoryContext();
      const entries = entriesOf('a/x/f', 'b/f', 'c/f', 'top');
      const first = await updateCacheTree(ctx, entries, undefined, 'write');
      return { ctx, entries, first };
    };

    describe('When updating in write mode', () => {
      it('Then reused trees are neither freshened nor re-identified', async () => {
        // Arrange
        const { ctx, entries, first } = await setup();
        const touch = vi.spyOn(ctx.fs, 'utimeNow');
        const changed = entries.map((e) =>
          e.path === FilePath.from('a/x/f') ? { ...e, id: 'e'.repeat(40) as ObjectId } : e,
        );
        const carried = invalidateCacheTree(first.cacheTree, [changed[0] as IndexEntry]);
        // Act
        const result = await updateCacheTree(ctx, changed, carried, 'write');
        // Assert
        expect(touch).not.toHaveBeenCalled();
        expect(childNamed(result.cacheTree, 'b').id).toBe(childNamed(first.cacheTree, 'b').id);
        expect(childNamed(result.cacheTree, 'c').id).toBe(childNamed(first.cacheTree, 'c').id);
        expect(result.rootTree).not.toBe(first.rootTree);
      });

      it('Then a valid carried node whose object is missing is rebuilt', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const missing = 'd'.repeat(40) as ObjectId;
        const carried: CacheTreeEntry = {
          path: '',
          entryCount: 2,
          subtreeCount: 1,
          id: 'c'.repeat(40) as ObjectId,
          children: [{ path: 'b', entryCount: 1, subtreeCount: 0, id: missing, children: [] }],
        };
        const entries = entriesOf('b/f', 'top');
        // Act
        const result = await updateCacheTree(ctx, entries, { ...carried, entryCount: 9 }, 'write');
        // Assert
        const rebuilt = childNamed(result.cacheTree, 'b');
        expect(rebuilt.id).not.toBe(missing);
        expect(await hasObject(ctx, rebuilt.id as ObjectId)).toBe(true);
      });
    });
  });

  describe('Given an intent-to-add entry beside a staged one', () => {
    describe('When updating in write mode', () => {
      it('Then the root and its directory are invalid but still written', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = [entryAt('a/f'), entryAt('a/n', ITA)];
        // Act
        const result = await updateCacheTree(ctx, entries, undefined, 'write');
        // Assert
        expect(result.cacheTree.entryCount).toBe(-1);
        expect(childNamed(result.cacheTree, 'a').entryCount).toBe(-1);
        expect(await hasObject(ctx, result.rootTree)).toBe(true);
      });
    });
  });

  describe('Given a directory holding only intent-to-add entries', () => {
    describe('When updating in write mode', () => {
      it('Then the directory is absent from the root tree object', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = [entryAt('a/n', ITA), entryAt('top')];
        // Act
        const result = await updateCacheTree(ctx, entries, undefined, 'write');
        // Assert
        const root = await readTree(ctx, result.rootTree);
        expect(root.entries.map((e) => e.name)).toEqual(['top']);
      });
    });
  });

  describe('Given a concurrency limit of one', () => {
    describe('When updating a three-level tree', () => {
      it('Then it completes with every node valid', async () => {
        // Arrange
        const base = createMemoryContext();
        const ctx = { ...base, config: { ...base.config, parallelism: { io: 1 } } };
        // Act
        const result = await updateCacheTree(
          ctx,
          entriesOf('a/b/c/f', 'a/g', 'h/f'),
          undefined,
          'write',
        );
        // Assert
        expect(nodesOf(result.cacheTree).every((n) => n.entryCount >= 0)).toBe(true);
      });
    });
  });

  describe('Given a sha256 repository', () => {
    describe('When updating in write mode', () => {
      it('Then ids are 64 hex characters', async () => {
        // Arrange
        const ctx = createMemoryContext({ algorithm: 'sha256' });
        const entries = entriesOf('a/f').map((e) => ({ ...e, id: 'f'.repeat(64) as ObjectId }));
        // Act
        const result = await updateCacheTree(ctx, entries, undefined, 'write');
        // Assert
        expect(result.rootTree).toMatch(/^[0-9a-f]{64}$/);
        expect(childNamed(result.cacheTree, 'a').id).toMatch(/^[0-9a-f]{64}$/);
      });
    });
  });

  describe('Given a repaired tree whose reused node object is missing', () => {
    describe('When repairing with a carried tree', () => {
      it('Then the missing node and its ancestors are invalid and nothing is written', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = entriesOf('b/f', 'top');
        const carried: CacheTreeEntry = {
          path: '',
          entryCount: 2,
          subtreeCount: 1,
          id: 'c'.repeat(40) as ObjectId,
          children: [
            {
              path: 'b',
              entryCount: 1,
              subtreeCount: 0,
              id: 'd'.repeat(40) as ObjectId,
              children: [],
            },
          ],
        };
        const writes = countWrites(ctx);
        // Act
        const result = await updateCacheTree(ctx, entries, carried, 'repair');
        // Assert
        expect(result.cacheTree.entryCount).toBe(-1);
        expect(writes()).toBe(0);
      });
    });
  });
});

describe('isCacheTreeFullyValid', () => {
  describe('Given a fully stored tree', () => {
    describe('When checking it is fully valid', () => {
      it('Then it is valid', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { cacheTree } = await updateCacheTree(
          ctx,
          entriesOf('a/f', 'top'),
          undefined,
          'write',
        );
        // Act
        const result = await isCacheTreeFullyValid(ctx, cacheTree);
        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a node with a negative count', () => {
    describe('When checking it is fully valid', () => {
      it('Then it is not valid', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { cacheTree } = await updateCacheTree(
          ctx,
          entriesOf('a/f', 'top'),
          undefined,
          'write',
        );
        const invalidated = invalidateCacheTree(cacheTree, [entryAt('a/f')]);
        const sut = isCacheTreeFullyValid;
        // Act
        const result = await sut(ctx, invalidated);
        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a node whose object is missing', () => {
    describe('When checking it is fully valid', () => {
      it('Then it is not valid', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { cacheTree } = await updateCacheTree(
          ctx,
          entriesOf('a/f', 'top'),
          undefined,
          'write',
        );
        const sut = {
          ...cacheTree,
          children: cacheTree.children.map((c) => ({ ...c, id: 'd'.repeat(40) as ObjectId })),
        };
        // Act
        const result = await isCacheTreeFullyValid(ctx, sut);
        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given no tree', () => {
    describe('When checking it is fully valid', () => {
      it('Then it is not valid', async () => {
        // Arrange
        const ctx = createMemoryContext();
        // Act
        const result = await isCacheTreeFullyValid(ctx, undefined);
        // Assert
        expect(result).toBe(false);
      });
    });
  });
});

describe('updateCacheTree with a missing reused subtree', () => {
  describe('Given a carried a whose own tree and child a2 are gone but a1 remains', () => {
    describe('When repairing', () => {
      it('Then a, a2 and the root are invalid, a1 keeps its id and nothing is written', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = entriesOf('a/a1/f', 'a/a2/g', 'top');
        const first = await updateCacheTree(ctx, entries, undefined, 'write');
        const a = childNamed(first.cacheTree, 'a');
        await deleteObject(ctx, a.id);
        await deleteObject(ctx, childNamed(a, 'a2').id);
        const carried = invalidateCacheTree(first.cacheTree, [entries[2] as IndexEntry]);
        const writes = countWrites(ctx);
        // Act
        const result = await updateCacheTree(ctx, entries, carried, 'repair');
        // Assert
        const repaired = childNamed(result.cacheTree, 'a');
        expect(repaired.entryCount).toBe(-1);
        expect(childNamed(repaired, 'a1').id).toBe(childNamed(a, 'a1').id);
        expect(childNamed(repaired, 'a1').entryCount).toBe(1);
        expect(childNamed(repaired, 'a2').entryCount).toBe(-1);
        expect(result.cacheTree.entryCount).toBe(-1);
        expect(writes()).toBe(0);
      });
    });
  });

  describe('Given a missing reused node forcing a second planning round', () => {
    describe('When updating in write mode', () => {
      it('Then a present reused sibling is probed exactly once', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = entriesOf('a/x/f', 'b/g', 'top');
        const first = await updateCacheTree(ctx, entries, undefined, 'write');
        await deleteObject(ctx, childNamed(first.cacheTree, 'a').id);
        const carried = invalidateCacheTree(first.cacheTree, [entries[2] as IndexEntry]);
        vi.mocked(hasObject).mockClear();
        // Act
        await updateCacheTree(ctx, entries, carried, 'write');
        // Assert
        const siblingId = childNamed(first.cacheTree, 'b').id;
        const probes = vi.mocked(hasObject).mock.calls.filter(([, id]) => id === siblingId);
        expect(probes).toHaveLength(1);
      });
    });
  });
});
