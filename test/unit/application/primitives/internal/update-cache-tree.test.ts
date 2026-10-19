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
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import {
  invalidateCacheTree,
  invalidateCacheTreeKeepingOids,
} from '../../../../../src/domain/git-index/cache-tree.js';
import {
  type CacheTreeEntry,
  type IndexEntry,
  type IndexEntryFlags,
  STAGE0_FLAGS,
} from '../../../../../src/domain/git-index/index-entry.js';
import { emptyTreeOid, FILE_MODE, FilePath } from '../../../../../src/domain/objects/index.js';
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
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, entriesOf('a/f', 'c/g'), undefined, 'repair');
        // Assert
        expect(childNamed(result.cacheTree, 'a').entryCount).toBe(1);
        expect(childNamed(result.cacheTree, 'c').entryCount).toBe(-1);
        expect(result.cacheTree.entryCount).toBe(-1);
        expect(writes()).toBe(0);
      });
    });
  });

  describe('Given a new directory a/new whose tree cannot be repaired and no earlier oid', () => {
    const setup = async (stored: string[]) => {
      const ctx = createMemoryContext();
      const { cacheTree } = await updateCacheTree(ctx, entriesOf(...stored), undefined, 'write');
      const seed = invalidateCacheTree(cacheTree, entriesOf('a/new/g', 'b/f'));
      return { ctx, seed };
    };

    describe('When repairing', () => {
      it('Then the later sibling b is left invalid while the untouched c stays valid', async () => {
        // Arrange
        const { ctx, seed } = await setup(['a/x', 'b/f', 'c/f']);
        const entries = entriesOf('a/new/g', 'a/x', 'b/f', 'c/f');
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, entries, seed, 'repair');
        // Assert
        expect(result.cacheTree.entryCount).toBe(-1);
        expect(childNamed(result.cacheTree, 'a').entryCount).toBe(-1);
        expect(childNamed(childNamed(result.cacheTree, 'a'), 'new').entryCount).toBe(-1);
        expect(childNamed(result.cacheTree, 'b').entryCount).toBe(-1);
        expect(childNamed(result.cacheTree, 'c').entryCount).toBe(1);
      });

      it('Then without a carried tree the later sibling is not repaired either', async () => {
        // Arrange
        const { ctx } = await setup(['b/f']);
        const entries = entriesOf('a/new/g', 'b/f');
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, entries, undefined, 'repair');
        // Assert
        expect(result.cacheTree.children.map((child) => child.path)).toEqual(['a']);
        expect(childNamed(result.cacheTree, 'a').entryCount).toBe(-1);
      });

      it('Then a carried directory is dropped when only the entry pass of its parent fails', async () => {
        // Arrange
        const { ctx, seed } = await setup(['a/old/f', 'a/x', 'b/f', 'c/f']);
        const entries = entriesOf('a/new/g', 'a/x', 'b/f', 'c/f');
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, entries, seed, 'repair');
        // Assert
        const a = childNamed(result.cacheTree, 'a');
        expect(a.children.map((child) => child.path)).toEqual(['new']);
        expect(a.subtreeCount).toBe(1);
      });

      it('Then a carried directory the index no longer has is kept', async () => {
        // Arrange
        const { ctx, seed } = await setup(['a/x', 'b/f', 'c/f', 'd/f']);
        const entries = entriesOf('a/new/g', 'a/x', 'b/f', 'c/f');
        const invalidated = invalidateCacheTree(seed, entriesOf('d/f'));
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, entries, invalidated, 'repair');
        // Assert
        expect(result.cacheTree.subtreeCount).toBe(4);
        expect(childNamed(result.cacheTree, 'd').entryCount).toBe(-1);
      });
    });
  });

  describe('Given a staged a/s whose stored trees for a/s and a were lost', () => {
    const restaged = (): IndexEntry[] => [
      { ...entryAt('a/s/x'), id: 'e'.repeat(40) as ObjectId },
      entryAt('b/f'),
      entryAt('c/f'),
    ];

    describe('When repairing', () => {
      it('Then a keeps its carried count and oid, s and the unvisited b are invalid and c stays valid', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { cacheTree } = await updateCacheTree(ctx, restaged(), undefined, 'write');
        const lost = childNamed(cacheTree, 'a');
        await deleteObject(ctx, childNamed(lost, 's').id);
        await deleteObject(ctx, lost.id);
        const carried = invalidateCacheTree(cacheTree, [entryAt('b/f')]);
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, restaged(), carried, 'repair');
        // Assert
        const a = childNamed(result.cacheTree, 'a');
        expect(result.cacheTree.entryCount).toBe(-1);
        expect(a.entryCount).toBe(1);
        expect(a.id).toBe(lost.id);
        expect(childNamed(a, 's').entryCount).toBe(-1);
        expect(childNamed(result.cacheTree, 'b').entryCount).toBe(-1);
        expect(childNamed(result.cacheTree, 'c').entryCount).toBe(1);
      });
    });
  });

  describe('Given a staged a/s/t/x whose stored trees for a/s/t, a/s, a and the root were lost', () => {
    const restaged = (): IndexEntry[] => [
      { ...entryAt('a/s/t/x'), id: 'e'.repeat(40) as ObjectId },
      entryAt('b/f'),
      entryAt('c/f'),
    ];

    describe('When repairing', () => {
      it('Then a and s keep their carried counts and oids, t and the unvisited b are invalid and c stays valid', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { cacheTree, rootTree } = await updateCacheTree(ctx, restaged(), undefined, 'write');
        const a = childNamed(cacheTree, 'a');
        const s = childNamed(a, 's');
        for (const id of [childNamed(s, 't').id, s.id, a.id, rootTree]) await deleteObject(ctx, id);
        const carried = invalidateCacheTree(cacheTree, [entryAt('b/f')]);
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, restaged(), carried, 'repair');
        // Assert
        const shape = nodesOf(result.cacheTree).map((node) => `${node.path}:${node.entryCount}`);
        expect(shape).toEqual([':-1', 'a:1', 's:1', 't:-1', 'b:-1', 'c:1']);
        const repaired = childNamed(result.cacheTree, 'a');
        expect(repaired.id).toBe(a.id);
        expect(childNamed(repaired, 's').id).toBe(s.id);
      });
    });
  });

  describe('Given no entries and a repo that never stored the empty tree', () => {
    describe('When repairing', () => {
      it('Then the root is valid and names the empty tree', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, [], undefined, 'repair');
        // Assert
        expect(result.cacheTree.entryCount).toBe(0);
        expect(result.cacheTree.id).toBe(emptyTreeOid(ctx.hashConfig));
      });
    });
  });

  describe('Given a carried root naming the empty tree that was never stored', () => {
    describe('When checking the tree is fully valid', () => {
      it('Then it is valid', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const root = {
          path: '',
          entryCount: 0,
          subtreeCount: 0,
          id: emptyTreeOid(ctx.hashConfig),
          children: [],
        };
        const sut = isCacheTreeFullyValid;
        // Act
        const result = await sut(ctx, root);
        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a carried root naming the empty tree and no entries', () => {
    describe('When updating in write mode', () => {
      it('Then the empty tree is accepted without being stored', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const empty = emptyTreeOid(ctx.hashConfig);
        const carried = { path: '', entryCount: 0, subtreeCount: 0, id: empty, children: [] };
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, [], carried, 'write');
        // Assert
        expect(result.rootTree).toBe(empty);
      });
    });
  });

  describe('Given a carried root that names a blob', () => {
    describe('When updating in write mode', () => {
      it('Then it refuses with the blob named as the wrong type', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const blob = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array(0),
          id: '' as ObjectId,
        });
        const carried = { path: '', entryCount: 1, subtreeCount: 0, id: blob, children: [] };
        const entries = [{ ...entryAt('f'), id: blob }];
        let error: TsgitError | undefined;
        const sut = updateCacheTree;
        // Act
        try {
          await sut(ctx, entries, carried, 'write');
        } catch (e) {
          error = e as TsgitError;
        }
        // Assert
        expect(error?.data).toEqual({
          code: 'UNEXPECTED_OBJECT_TYPE',
          expected: 'tree',
          actual: 'blob',
          id: blob,
        });
      });
    });
  });

  describe('Given a carried root that names a blob', () => {
    describe('When repairing', () => {
      it('Then it resolves without a type check and keeps the root as carried', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const blob = await writeObject(ctx, {
          type: 'blob',
          content: new Uint8Array(0),
          id: '' as ObjectId,
        });
        const carried = { path: '', entryCount: 1, subtreeCount: 0, id: blob, children: [] };
        const entries = [{ ...entryAt('f'), id: blob }];
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, entries, carried, 'repair');
        // Assert
        expect(result.cacheTree.entryCount).toBe(1);
        expect(result.cacheTree.id).toBe(blob);
      });
    });
  });

  describe('Given stored trees for b and c and a staged new directory', () => {
    const shape = (root: CacheTreeEntry): string[] =>
      nodesOf(root).map((node) => `${node.path === '' ? '<root>' : node.path}:${node.entryCount}`);

    const carriedFor = async (stored: string[], invalid: string[]) => {
      const ctx = createMemoryContext();
      const { cacheTree } = await updateCacheTree(ctx, entriesOf(...stored), undefined, 'write');
      return { ctx, cacheTree, seed: invalidateCacheTree(cacheTree, entriesOf(...invalid)) };
    };

    describe('When repairing an unrepairable a/new that precedes the carried b and c', () => {
      it('Then the unvisited b and c keep their carried state and the children stay in subtree order', async () => {
        // Arrange
        const { ctx, seed } = await carriedFor(['b/f', 'c/f'], ['a/new/g']);
        const entries = entriesOf('a/new/g', 'b/f', 'c/f');
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, entries, seed, 'repair');
        // Assert
        expect(shape(result.cacheTree)).toEqual(['<root>:-1', 'a:-1', 'new:-1', 'b:1', 'c:1']);
      });
    });

    describe('When repairing a staged aa/n/g beside a carried invalid b', () => {
      it('Then aa is met before b in index order and b stays invalid', async () => {
        // Arrange
        const { ctx, seed } = await carriedFor(['b/f', 'c/f'], ['b/f']);
        const entries = entriesOf('aa/n/g', 'b/f', 'c/f');
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, entries, seed, 'repair');
        // Assert
        expect(shape(result.cacheTree)).toEqual(['<root>:-1', 'b:-1', 'c:1', 'aa:-1', 'n:-1']);
      });
    });

    describe('When repairing a staged a/n/g beside a carried invalid a-b', () => {
      it('Then a-b is met before a in index order and is repaired', async () => {
        // Arrange
        const { ctx, seed } = await carriedFor(['a-b/f', 'c/f'], ['a-b/f']);
        const entries = entriesOf('a-b/f', 'a/n/g', 'c/f');
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, entries, seed, 'repair');
        // Assert
        expect(shape(result.cacheTree)).toEqual(['<root>:-1', 'a:-1', 'n:-1', 'c:1', 'a-b:1']);
      });
    });

    describe('When repairing with an invalid a whose earlier oid is kept', () => {
      it('Then the abort still reaches the root and the invalid b is left unvisited', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const stored = entriesOf('a/x', 'b/f', 'c/f');
        const { cacheTree } = await updateCacheTree(ctx, stored, undefined, 'write');
        const seed = invalidateCacheTreeKeepingOids(cacheTree, entriesOf('a/new/g', 'b/f'));
        const entries = entriesOf('a/new/g', 'a/x', 'b/f', 'c/f');
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, entries, seed, 'repair');
        // Assert
        expect(shape(result.cacheTree)).toEqual(['<root>:-1', 'a:-1', 'new:-1', 'b:-1', 'c:1']);
      });
    });

    describe('When repairing with the stored tree of c lost', () => {
      it('Then c is unvisited and keeps the count it carried', async () => {
        // Arrange
        const { ctx, cacheTree, seed } = await carriedFor(['a/x', 'b/f', 'c/f'], ['a/new/g']);
        await deleteObject(ctx, childNamed(cacheTree, 'c').id);
        const entries = entriesOf('a/new/g', 'a/x', 'b/f', 'c/f');
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, entries, seed, 'repair');
        // Assert
        expect(childNamed(result.cacheTree, 'c').entryCount).toBe(1);
        expect(childNamed(result.cacheTree, 'c').id).toBe(childNamed(cacheTree, 'c').id);
      });
    });
  });

  describe('Given a staged a/s/x whose new content has no stored tree and an earlier oid kept', () => {
    describe('When repairing', () => {
      it('Then the sibling b is still repaired because a/s does not abort its parent', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const { cacheTree } = await updateCacheTree(
          ctx,
          entriesOf('a/s/x', 'b/f'),
          undefined,
          'write',
        );
        const seed = invalidateCacheTreeKeepingOids(cacheTree, entriesOf('a/s/x', 'b/f'));
        const restaged = [{ ...entryAt('a/s/x'), id: 'e'.repeat(40) as ObjectId }, entryAt('b/f')];
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, restaged, seed, 'repair');
        // Assert
        expect(childNamed(result.cacheTree, 'b').entryCount).toBe(1);
      });
    });
  });

  describe('Given a staged 0/a/s/x with no stored tree and a still stored earlier tree for 0/a/s', () => {
    describe('When repairing under directories that carry no oid', () => {
      it('Then 0 and a are hashed over the stored earlier s, and the later invalid c is repaired', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const stored = entriesOf('0/a/s/x', '0/a/s/y', 'b/f', 'c/f');
        const { cacheTree } = await updateCacheTree(ctx, stored, undefined, 'write');
        const seed = invalidateCacheTreeKeepingOids(
          invalidateCacheTree(cacheTree, entriesOf('0/a/n', 'c/f')),
          entriesOf('0/a/s/x'),
        );
        const restaged = [
          { ...entryAt('0/a/s/x'), id: 'e'.repeat(40) as ObjectId },
          ...entriesOf('0/a/s/y', 'b/f', 'c/f'),
        ];
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, restaged, seed, 'repair');
        // Assert
        const shape = nodesOf(result.cacheTree).map((node) => `${node.path}:${node.entryCount}`);
        expect(shape).toEqual([':-1', '0:-1', 'a:-1', 's:-1', 'b:1', 'c:1']);
      });
    });
  });

  describe('Given a/s and c/s that share one stored tree, with a/s restaged to a tree that is not stored', () => {
    describe('When repairing', () => {
      it('Then the shared tree is probed once and the rebuilt c is probed once', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const stored = entriesOf('a/s/x', 'c/s/x', 'c/y');
        const { cacheTree } = await updateCacheTree(ctx, stored, undefined, 'write');
        const shared = childNamed(childNamed(cacheTree, 'a'), 's').id;
        const rebuiltC = childNamed(cacheTree, 'c').id;
        const seed = invalidateCacheTreeKeepingOids(cacheTree, entriesOf('a/s/x', 'c/y'));
        const restaged = [
          { ...entryAt('a/s/x'), id: 'e'.repeat(40) as ObjectId },
          ...entriesOf('c/s/x', 'c/y'),
        ];
        vi.mocked(hasObject).mockClear();
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, restaged, seed, 'repair');
        // Assert
        const shape = nodesOf(result.cacheTree).map((node) => `${node.path}:${node.entryCount}`);
        expect(shape).toEqual([':-1', 'a:-1', 's:-1', 'c:2', 's:1']);
        const probesOf = (id: ObjectId | undefined) =>
          vi.mocked(hasObject).mock.calls.filter(([, probed]) => probed === id);
        expect(probesOf(shared)).toHaveLength(1);
        expect(probesOf(rebuiltC)).toHaveLength(1);
      });
    });
  });

  describe('Given a/s and c/s that share one stored tree, both restaged to trees that are not stored', () => {
    describe('When repairing', () => {
      it('Then the shared earlier tree both fall back on is probed once', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const stored = entriesOf('a/s/x', 'c/s/x');
        const { cacheTree } = await updateCacheTree(ctx, stored, undefined, 'write');
        const shared = childNamed(childNamed(cacheTree, 'a'), 's').id;
        const seed = invalidateCacheTreeKeepingOids(cacheTree, entriesOf('a/s/x', 'c/s/x'));
        const restaged = ['a/s/x', 'c/s/x'].map((path) => ({
          ...entryAt(path),
          id: 'e'.repeat(40) as ObjectId,
        }));
        vi.mocked(hasObject).mockClear();
        const sut = updateCacheTree;
        // Act
        await sut(ctx, restaged, seed, 'repair');
        // Assert
        const probes = vi.mocked(hasObject).mock.calls.filter(([, probed]) => probed === shared);
        expect(probes).toHaveLength(1);
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
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, entries, undefined, 'repair');
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
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, entries, undefined, 'repair');
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
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, entriesOf('a/x/f', 'b/f', 'top'), undefined, 'write');
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
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, entries, carried, 'write');
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
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, changed, carried, 'write');
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
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, entries, { ...carried, entryCount: 9 }, 'write');
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
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, entries, undefined, 'write');
        // Assert
        expect(result.cacheTree.entryCount).toBe(-1);
        expect(childNamed(result.cacheTree, 'a').entryCount).toBe(-1);
        expect(await hasObject(ctx, result.rootTree)).toBe(true);
        const root = await readTree(ctx, result.rootTree);
        expect(root.entries.map((e) => e.name)).toEqual(['a']);
      });
    });
  });

  describe('Given a directory holding only intent-to-add entries', () => {
    describe('When updating in write mode', () => {
      it('Then the directory is absent from the root tree object', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = [entryAt('a/n', ITA), entryAt('top')];
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, entries, undefined, 'write');
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
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, entriesOf('a/b/c/f', 'a/g', 'h/f'), undefined, 'write');
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
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, entries, undefined, 'write');
        // Assert
        expect(result.rootTree).toMatch(/^[0-9a-f]{64}$/);
        expect(childNamed(result.cacheTree, 'a').id).toMatch(/^[0-9a-f]{64}$/);
      });
    });
  });

  describe('Given a repaired tree whose reused node object is missing', () => {
    describe('When repairing with a carried tree', () => {
      it('Then the missing node is invalid, the root keeps its carried count and oid, and nothing is written', async () => {
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
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, entries, carried, 'repair');
        // Assert
        expect(childNamed(result.cacheTree, 'b').entryCount).toBe(-1);
        expect(result.cacheTree.entryCount).toBe(2);
        expect(result.cacheTree.id).toBe(carried.id);
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
        const sut = isCacheTreeFullyValid;
        // Act
        const result = await sut(ctx, cacheTree);
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
        const missingChildren = {
          ...cacheTree,
          children: cacheTree.children.map((c) => ({ ...c, id: 'd'.repeat(40) as ObjectId })),
        };
        const sut = isCacheTreeFullyValid;
        // Act
        const result = await sut(ctx, missingChildren);
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
        const sut = isCacheTreeFullyValid;
        // Act
        const result = await sut(ctx, undefined);
        // Assert
        expect(result).toBe(false);
      });
    });
  });
});

describe('updateCacheTree with a missing reused subtree', () => {
  describe('Given a carried a whose own tree and child a2 are gone but a1 remains', () => {
    describe('When repairing', () => {
      it('Then a keeps its carried count and oid, a2 and the root are invalid, a1 keeps its id and nothing is written', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const entries = entriesOf('a/a1/f', 'a/a2/g', 'top');
        const first = await updateCacheTree(ctx, entries, undefined, 'write');
        const a = childNamed(first.cacheTree, 'a');
        await deleteObject(ctx, a.id);
        await deleteObject(ctx, childNamed(a, 'a2').id);
        const carried = invalidateCacheTree(first.cacheTree, [entries[2] as IndexEntry]);
        const writes = countWrites(ctx);
        const sut = updateCacheTree;
        // Act
        const result = await sut(ctx, entries, carried, 'repair');
        // Assert
        const repaired = childNamed(result.cacheTree, 'a');
        expect(repaired.entryCount).toBe(2);
        expect(repaired.id).toBe(a.id);
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
        const sut = updateCacheTree;
        // Act
        await sut(ctx, entries, carried, 'write');
        // Assert
        const siblingId = childNamed(first.cacheTree, 'b').id;
        const probes = vi.mocked(hasObject).mock.calls.filter(([, id]) => id === siblingId);
        expect(probes).toHaveLength(1);
      });
    });
  });
});
