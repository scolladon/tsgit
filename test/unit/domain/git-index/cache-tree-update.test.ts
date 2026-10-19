import { describe, expect, it } from 'vitest';
import { serializeCacheTree } from '../../../../src/domain/git-index/cache-tree.js';
import {
  type CacheTreePlan,
  carriedCacheTreeOf,
  compareSubtreeNames,
  isIndexOrdered,
  planCacheTree,
  toCacheTreeEntry,
} from '../../../../src/domain/git-index/cache-tree-update.js';
import {
  type CacheTreeEntry,
  type IndexEntry,
  type IndexEntryFlags,
  STAGE0_FLAGS,
} from '../../../../src/domain/git-index/index-entry.js';
import { encode } from '../../../../src/domain/objects/encoding.js';
import { FILE_MODE, FilePath } from '../../../../src/domain/objects/index.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';

const oid = (char: string): ObjectId => char.repeat(40) as ObjectId;

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
  id: oid('f'),
  flags,
  path: FilePath.from(path),
});

const ITA: IndexEntryFlags = { ...STAGE0_FLAGS, intentToAdd: true };
const STAGE2: IndexEntryFlags = { ...STAGE0_FLAGS, stage: 2 };

const FIXTURE = ['a/x/f', 'b/f', 'bb/f', 'c/f', 'top', 'zzz/f'];
const fixtureEntries = (): IndexEntry[] => FIXTURE.map((path) => entryAt(path));

const node = (
  path: string,
  entryCount: number,
  children: CacheTreeEntry[] = [],
  id?: ObjectId,
): CacheTreeEntry => ({
  path,
  entryCount,
  subtreeCount: children.length,
  ...(id === undefined ? {} : { id }),
  children,
});

const carriedFixture = (): CacheTreeEntry =>
  node(
    '',
    6,
    [
      node('a', 1, [node('x', 1, [], oid('2'))], oid('1')),
      node('b', 1, [], oid('3')),
      node('c', 1, [], oid('4')),
      node('bb', 1, [], oid('5')),
      node('zzz', 1, [], oid('6')),
    ],
    oid('9'),
  );

const namesOf = (plan: CacheTreePlan, indices: ReadonlyArray<number>): string[] =>
  indices.map((i) => new TextDecoder().decode(plan.nodes[i]?.nameBytes));

const nodeNamed = (plan: CacheTreePlan, name: string) =>
  plan.nodes.find((n) => new TextDecoder().decode(n.nameBytes) === name);

describe('compareSubtreeNames', () => {
  describe('Given names bb and c', () => {
    describe('When comparing them', () => {
      it('Then the shorter name sorts first', () => {
        // Arrange
        const sut = compareSubtreeNames;

        // Act
        const result = sut(encode('bb'), encode('c'));

        // Assert
        expect(result).toBeGreaterThan(0);
        expect(sut(encode('c'), encode('bb'))).toBeLessThan(0);
      });
    });
  });

  describe('Given names of equal length', () => {
    describe('When comparing them', () => {
      it('Then the bytes decide', () => {
        // Arrange
        const sut = compareSubtreeNames;

        // Act
        const result = sut(encode('ab'), encode('aa'));

        // Assert
        expect(result).toBeGreaterThan(0);
        expect(sut(encode('aa'), encode('aa'))).toBe(0);
      });
    });
  });
});

describe('isIndexOrdered', () => {
  describe('Given entries in byte order', () => {
    describe('When checking the order', () => {
      it('Then it is true', () => {
        // Arrange
        const sut = isIndexOrdered;

        // Act
        const result = sut(fixtureEntries());

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given entries out of order', () => {
    describe('When checking the order', () => {
      it('Then it is false', () => {
        // Arrange
        const sut = isIndexOrdered;

        // Act
        const result = sut([entryAt('b'), entryAt('a')]);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});

describe('planCacheTree', () => {
  describe('Given the fixture and no carried tree', () => {
    describe('When planning', () => {
      it('Then every directory is a node ordered by name length then bytes, built post-order', () => {
        // Arrange
        const sut = planCacheTree;

        // Act
        const result = sut(fixtureEntries(), undefined);

        // Assert
        expect(result.nodes[0]?.entryCount).toBe(6);
        expect(namesOf(result, result.nodes[0]?.children ?? [])).toEqual([
          'a',
          'b',
          'c',
          'bb',
          'zzz',
        ]);
        expect(namesOf(result, nodeNamed(result, 'a')?.children ?? [])).toEqual(['x']);
        expect(result.builds).toHaveLength(7);
        expect(result.builds.at(-1)?.node).toBe(0);
        const order = result.builds.map((b) => b.node);
        const aIndex = result.nodes.indexOf(nodeNamed(result, 'a') as never);
        const xIndex = result.nodes.indexOf(nodeNamed(result, 'x') as never);
        expect(order.indexOf(xIndex)).toBeLessThan(order.indexOf(aIndex));
      });
    });

    describe('When planning', () => {
      it('Then the root build lists its files and every child', () => {
        // Arrange
        const sut = planCacheTree;

        // Act
        const result = sut(fixtureEntries(), undefined);

        // Assert
        const root = result.builds.find((b) => b.node === 0);
        expect(root?.files.map((f) => f.path)).toEqual(['top']);
        expect(root?.subtrees).toEqual(result.nodes[0]?.children);
      });
    });
  });

  describe('Given an empty index', () => {
    describe('When planning', () => {
      it('Then a single root build has no files and no subtrees', () => {
        // Arrange
        const sut = planCacheTree;

        // Act
        const result = sut([], undefined);

        // Assert
        expect(result.nodes).toHaveLength(1);
        expect(result.builds).toEqual([{ node: 0, files: [], subtrees: [] }]);
      });
    });
  });

  describe('Given a carried tree with root and b invalid', () => {
    const invalidated = (): CacheTreeEntry => {
      const carried = carriedFixture();
      const children = carried.children.map((child) =>
        child.path === 'b' ? node('b', -1) : child,
      );
      return { path: '', entryCount: -1, subtreeCount: 5, children };
    };

    describe('When planning', () => {
      it('Then only b and the root are builds and the others are reused', () => {
        // Arrange
        const sut = planCacheTree;

        // Act
        const result = sut(fixtureEntries(), invalidated());

        // Assert
        expect(nodeNamed(result, 'a')?.reused).toBe(oid('1'));
        expect(nodeNamed(result, 'x')?.reused).toBe(oid('2'));
        expect(nodeNamed(result, 'c')?.reused).toBe(oid('4'));
        expect(nodeNamed(result, 'bb')?.reused).toBe(oid('5'));
        expect(nodeNamed(result, 'zzz')?.reused).toBe(oid('6'));
        expect(nodeNamed(result, 'b')?.reused).toBeUndefined();
        expect(result.builds.map((b) => b.node)).toEqual([
          result.nodes.indexOf(nodeNamed(result, 'b') as never),
          0,
        ]);
      });
    });

    describe('When planning', () => {
      it('Then a count mismatch rebuilds that directory', () => {
        // Arrange
        const carried = invalidated();
        const mismatched = {
          ...carried,
          children: carried.children.map((child) =>
            child.path === 'c' ? node('c', 2, [], oid('4')) : child,
          ),
        };
        const sut = planCacheTree;

        // Act
        const result = sut(fixtureEntries(), mismatched);

        // Assert
        expect(nodeNamed(result, 'c')?.reused).toBeUndefined();
        expect(result.builds).toHaveLength(3);
      });
    });
  });

  describe('Given a fully valid carried tree and unchanged entries', () => {
    describe('When planning', () => {
      it('Then the root is reused and nothing is built', () => {
        // Arrange
        const sut = planCacheTree;

        // Act
        const result = sut(fixtureEntries(), carriedFixture());

        // Assert
        expect(result.builds).toEqual([]);
        expect(result.nodes[0]?.reused).toBe(oid('9'));
        expect(result.nodes).toHaveLength(7);
      });
    });
  });

  describe('Given a valid carried tree whose children are out of subtree order', () => {
    describe('When planning unchanged entries', () => {
      it('Then every carried child is still reused and nothing is built', () => {
        // Arrange
        const sut = planCacheTree;
        const carried = node(
          '',
          2,
          [node('bb', 1, [], oid('5')), node('c', 1, [], oid('4'))],
          oid('9'),
        );

        // Act
        const result = sut([entryAt('bb/f'), entryAt('c/f')], carried);

        // Assert
        expect(result.builds).toEqual([]);
        expect(nodeNamed(result, 'bb')?.reused).toBe(oid('5'));
        expect(nodeNamed(result, 'c')?.reused).toBe(oid('4'));
      });
    });
  });

  describe('Given a valid carried root with an invalidated child', () => {
    describe('When planning unchanged entries', () => {
      it('Then the invalidated child is mirrored without a reused id', () => {
        // Arrange
        const sut = planCacheTree;
        const carried = node('', 1, [node('c', -1, [])], oid('9'));

        // Act
        const result = sut([entryAt('c/f')], carried);

        // Assert
        expect(result.nodes[0]?.reused).toBe(oid('9'));
        expect(nodeNamed(result, 'c')?.reused).toBeUndefined();
      });
    });
  });

  describe('Given a carried tree whose root no longer matches the entries', () => {
    describe('When a directory sorts before every carried child', () => {
      it('Then that directory is built and the later carried child is reused', () => {
        // Arrange
        const sut = planCacheTree;
        const carried = node('', 1, [node('c', 1, [], oid('4'))], oid('9'));

        // Act
        const result = sut([entryAt('a/f'), entryAt('c/f')], carried);

        // Assert
        expect(nodeNamed(result, 'a')?.reused).toBeUndefined();
        expect(nodeNamed(result, 'c')?.reused).toBe(oid('4'));
      });
    });

    describe('When a directory sorts after every carried child', () => {
      it('Then that directory is built and the earlier carried child is reused', () => {
        // Arrange
        const sut = planCacheTree;
        const carried = node('', 1, [node('a', 1, [], oid('4'))], oid('9'));

        // Act
        const result = sut([entryAt('a/f'), entryAt('c/f')], carried);

        // Assert
        expect(nodeNamed(result, 'a')?.reused).toBe(oid('4'));
        expect(nodeNamed(result, 'c')?.reused).toBeUndefined();
      });
    });
  });

  describe('Given an intent-to-add entry next to a file', () => {
    describe('When planning', () => {
      it('Then the directory and the root are invalid and the build leaves the entry out', () => {
        // Arrange
        const entries = [entryAt('a/f'), entryAt('a/n', ITA), entryAt('b')];
        const sut = planCacheTree;

        // Act
        const result = sut(entries, undefined);

        // Assert
        const a = nodeNamed(result, 'a');
        expect(a?.invalid).toBe(true);
        expect(a?.entryCount).toBe(2);
        expect(result.nodes[0]?.invalid).toBe(true);
        const build = result.builds.find((b) => b.node === result.nodes.indexOf(a as never));
        expect(build?.files.map((f) => f.path)).toEqual(['a/f']);
      });
    });

    describe('When planning', () => {
      it('Then an invalid carried valid-looking node is not reused', () => {
        // Arrange
        const entries = [entryAt('a/f'), entryAt('a/n', ITA)];
        const carried = node('', 2, [node('a', 2, [], oid('1'))], oid('9'));
        const sut = planCacheTree;

        // Act
        const result = sut(entries, carried);

        // Assert
        expect(nodeNamed(result, 'a')?.reused).toBeUndefined();
        expect(result.nodes[0]?.reused).toBeUndefined();
      });
    });
  });

  describe('Given a directory holding only an intent-to-add entry', () => {
    describe('When planning', () => {
      it('Then the node is invalid and its build has no files', () => {
        // Arrange
        const sut = planCacheTree;

        // Act
        const result = sut([entryAt('n/x', ITA)], undefined);

        // Assert
        const n = nodeNamed(result, 'n');
        expect(n?.invalid).toBe(true);
        const build = result.builds.find((b) => b.node === result.nodes.indexOf(n as never));
        expect(build).toEqual({ node: 1, files: [], subtrees: [] });
      });
    });
  });

  describe('Given an unmerged entry in a directory', () => {
    describe('When planning', () => {
      it('Then the chain is invalid and the entry is left out of the files', () => {
        // Arrange
        const entries = [entryAt('a'), entryAt('b/f', STAGE2), entryAt('b/g')];
        const sut = planCacheTree;

        // Act
        const result = sut(entries, undefined);

        // Assert
        expect(nodeNamed(result, 'b')?.invalid).toBe(true);
        expect(nodeNamed(result, 'b')?.entryCount).toBe(2);
        expect(result.nodes[0]?.invalid).toBe(true);
        expect(result.builds[0]?.files.map((f) => f.path)).toEqual(['b/g']);
      });
    });
  });

  describe('Given a carried tree with a subtree the entries no longer have', () => {
    describe('When planning', () => {
      it('Then the subtree has no node and the emitted root counts 5/4', () => {
        // Arrange
        const entries = FIXTURE.filter((p) => p !== 'zzz/f').map((p) => entryAt(p));
        const sut = planCacheTree;

        // Act
        const result = sut(entries, carriedFixture());

        // Assert
        expect(nodeNamed(result, 'zzz')).toBeUndefined();
        const ids = result.nodes.map((n, i) => n.reused ?? (i === 0 ? oid('8') : undefined));
        const emitted = toCacheTreeEntry(result, ids);
        expect([emitted.entryCount, emitted.subtreeCount]).toEqual([5, 4]);
      });
    });
  });

  describe('Given unsorted entries', () => {
    describe('When planning', () => {
      it('Then the plan equals the plan of the sorted entries', () => {
        // Arrange
        const sut = planCacheTree;
        const unsorted = [...fixtureEntries()].reverse();

        // Act
        const result = sut(unsorted, undefined);

        // Assert
        expect(result).toEqual(sut(fixtureEntries(), undefined));
      });
    });
  });
  describe('Given a valid carried tree whose children are out of subtree order', () => {
    describe('When planning unchanged entries', () => {
      it('Then the mirrored children are listed in subtree order', () => {
        // Arrange
        const sut = planCacheTree;
        const carried = node(
          '',
          2,
          [node('bb', 1, [], oid('5')), node('c', 1, [], oid('4'))],
          oid('9'),
        );

        // Act
        const result = sut([entryAt('bb/f'), entryAt('c/f')], carried);

        // Assert
        expect(namesOf(result, result.nodes[0]?.children ?? [])).toEqual(['c', 'bb']);
      });
    });
  });

  describe('Given a valid carried root with a child invalidated but still holding its oid', () => {
    describe('When planning unchanged entries', () => {
      it('Then the child is mirrored without a reused id', () => {
        // Arrange
        const sut = planCacheTree;
        const carried = node('', 1, [node('c', -1, [], oid('4'))], oid('9'));

        // Act
        const result = sut([entryAt('c/f')], carried);

        // Assert
        expect(nodeNamed(result, 'c')?.reused).toBeUndefined();
      });
    });
  });

  describe('Given a carried directory and an unmerged entry sorting before it', () => {
    describe('When planning', () => {
      it('Then the directory is valid and reused', () => {
        // Arrange
        const sut = planCacheTree;
        const carried = node('', 2, [node('b', 1, [], oid('3'))], oid('9'));

        // Act
        const result = sut([entryAt('a', STAGE2), entryAt('b/f')], carried);

        // Assert
        expect(nodeNamed(result, 'b')?.invalid).toBe(false);
        expect(nodeNamed(result, 'b')?.reused).toBe(oid('3'));
      });
    });
  });

  describe('Given an empty index', () => {
    describe('When planning', () => {
      it('Then the root node has no reused and no previousId keys', () => {
        // Arrange
        const sut = planCacheTree;

        // Act
        const result = sut([], undefined);

        // Assert
        expect(result.nodes).toStrictEqual([
          { nameBytes: new Uint8Array(0), entryCount: 0, invalid: false, children: [] },
        ]);
      });
    });
  });

  describe('Given entries whose directories interleave out of order', () => {
    describe('When planning', () => {
      it('Then each directory is one node as in the sorted entries', () => {
        // Arrange
        const sut = planCacheTree;
        const sorted = [entryAt('a/x'), entryAt('a/z'), entryAt('b/y')];
        const interleaved = [entryAt('a/x'), entryAt('b/y'), entryAt('a/z')];

        // Act
        const result = sut(interleaved, undefined);

        // Assert
        expect(result).toEqual(sut(sorted, undefined));
      });
    });
  });
});

describe('toCacheTreeEntry', () => {
  describe('Given a plan with an id for every node', () => {
    describe('When emitting', () => {
      it('Then counts and ids are emitted with children in subtree order', () => {
        // Arrange
        const plan = planCacheTree(fixtureEntries(), undefined);
        const sut = toCacheTreeEntry;

        // Act
        const result = sut(
          plan,
          plan.nodes.map(() => oid('1')),
        );

        // Assert
        expect([result.path, result.entryCount, result.subtreeCount, result.id]).toEqual([
          '',
          6,
          5,
          oid('1'),
        ]);
        expect(result.children.map((c) => c.path)).toEqual(['a', 'b', 'c', 'bb', 'zzz']);
      });
    });
  });

  describe('Given an invalid node and a node without id', () => {
    describe('When emitting', () => {
      it('Then both are emitted as -1 without an id', () => {
        // Arrange
        const plan = planCacheTree([entryAt('a/n', ITA), entryAt('b/f')], undefined);
        const sut = toCacheTreeEntry;

        // Act
        const result = sut(
          plan,
          plan.nodes.map((_, i) => (i === 2 ? undefined : oid('1'))),
        );

        // Assert
        expect(result.children.map((c) => [c.path, c.entryCount, c.id])).toEqual([
          ['a', -1, undefined],
          ['b', -1, undefined],
        ]);
        expect(result.entryCount).toBe(-1);
        expect(result.id).toBeUndefined();
      });
    });
  });

  describe('Given a plan for one valid-UTF-8 directory', () => {
    describe('When emitting', () => {
      it('Then the entries carry exactly their fields and no nameBytes', () => {
        // Arrange
        const plan = planCacheTree([entryAt('a/f')], undefined);
        const sut = toCacheTreeEntry;

        // Act
        const result = sut(
          plan,
          plan.nodes.map(() => oid('1')),
        );

        // Assert
        expect(result).toStrictEqual(node('', 1, [node('a', 1, [], oid('1'))], oid('1')));
      });
    });
  });

  describe('Given a directory name that is not valid UTF-8', () => {
    describe('When emitting', () => {
      it('Then the emitted child keeps its raw bytes', () => {
        // Arrange
        const raw = new Uint8Array([0x61, 0xff, 0x2f, 0x66]);
        const plan = planCacheTree([{ ...entryAt('a�/f'), pathBytes: raw }], undefined);
        const sut = toCacheTreeEntry;

        // Act
        const result = sut(
          plan,
          plan.nodes.map(() => oid('1')),
        );

        // Assert
        expect(result.children[0]?.nameBytes).toEqual(new Uint8Array([0x61, 0xff]));
      });
    });
  });
});

describe('carriedCacheTreeOf', () => {
  const extensionOf = (tree: CacheTreeEntry, width: 20 | 32 = 20) => [
    { signature: 'TREE', data: serializeCacheTree(tree, width) },
  ];

  describe('Given no TREE extension', () => {
    describe('When reading the carried tree', () => {
      it('Then it is undefined', () => {
        // Arrange
        const sut = carriedCacheTreeOf;

        // Act
        const result = sut([{ signature: 'REUC', data: new Uint8Array(0) }], 20);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a TREE payload that does not parse', () => {
    describe('When reading the carried tree', () => {
      it('Then it is undefined', () => {
        // Arrange
        const sut = carriedCacheTreeOf;

        // Act
        const result = sut([{ signature: 'TREE', data: encode('garbage') }], 20);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a TREE naming a subtree twice', () => {
    describe('When reading the carried tree', () => {
      it('Then it is undefined', () => {
        // Arrange
        const twice = node(
          '',
          2,
          [node('a', 1, [], oid('1')), node('a', 1, [], oid('2'))],
          oid('9'),
        );
        const sut = carriedCacheTreeOf;

        // Act
        const result = sut(extensionOf(twice), 20);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a REUC extension before the TREE extension', () => {
    describe('When reading the carried tree', () => {
      it('Then the TREE one is parsed', () => {
        // Arrange
        const sut = carriedCacheTreeOf;
        const extensions = [
          { signature: 'REUC', data: new Uint8Array(0) },
          ...extensionOf(carriedFixture()),
        ];

        // Act
        const result = sut(extensions, 20);

        // Assert
        expect(result).toEqual(carriedFixture());
      });
    });
  });

  describe('Given a well-formed TREE', () => {
    describe('When reading the carried tree', () => {
      it('Then it returns the parsed tree at width 20', () => {
        // Arrange
        const sut = carriedCacheTreeOf;

        // Act
        const result = sut(extensionOf(carriedFixture()), 20);

        // Assert
        expect(result).toEqual(carriedFixture());
      });
    });

    describe('When reading the carried tree', () => {
      it('Then it returns the parsed tree at width 32', () => {
        // Arrange
        const wide = node(
          '',
          1,
          [node('a', 1, [], 'b'.repeat(64) as ObjectId)],
          'c'.repeat(64) as ObjectId,
        );
        const sut = carriedCacheTreeOf;

        // Act
        const result = sut(extensionOf(wide, 32), 32);

        // Assert
        expect(result).toEqual(wide);
      });
    });
  });
});
