import { describe, expect, it } from 'vitest';

import type { TsgitError } from '../../../../src/domain/error.js';
import {
  invalidateCacheTree,
  serializeCacheTree,
} from '../../../../src/domain/git-index/cache-tree.js';
import type { CacheTreeEntry } from '../../../../src/domain/git-index/index-entry.js';
import { parseCacheTree } from '../../../../src/domain/git-index/index-parser.js';
import type { IndexPath } from '../../../../src/domain/git-index/index-path-key.js';
import { concatBytes, encode, hexToBytes } from '../../../../src/domain/objects/encoding.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/object-id.js';

const NUL = new Uint8Array([0]);

function oid(hexLength: 40 | 64, digit: string): ObjectId {
  return digit.repeat(hexLength) as ObjectId;
}

function tree(hexLength: 40 | 64): CacheTreeEntry {
  return {
    path: '',
    entryCount: 3,
    subtreeCount: 2,
    id: oid(hexLength, 'a'),
    children: [
      { path: 'd', entryCount: 2, subtreeCount: 0, id: oid(hexLength, 'b'), children: [] },
      { path: 'x', entryCount: -1, subtreeCount: 0, children: [] },
    ],
  };
}

function expectedBytes(hexLength: 40 | 64): Uint8Array {
  return concatBytes([
    NUL,
    encode('3 2\n'),
    hexToBytes(oid(hexLength, 'a')),
    encode('d'),
    NUL,
    encode('2 0\n'),
    hexToBytes(oid(hexLength, 'b')),
    encode('x'),
    NUL,
    encode('-1 0\n'),
  ]);
}

describe('serializeCacheTree', () => {
  describe('Given a root with one valid subtree d and an invalidated subtree x', () => {
    describe('When serializeCacheTree at width 20', () => {
      it('Then the bytes equal the literal encoding', () => {
        // Arrange
        const sut = serializeCacheTree;

        // Act
        const result = sut(tree(40), 20);

        // Assert
        expect(result).toEqual(expectedBytes(40));
      });
    });

    describe('When serializeCacheTree at width 32', () => {
      it('Then the oids are 32 bytes wide', () => {
        // Arrange
        const sut = serializeCacheTree;

        // Act
        const result = sut(tree(64), 32);

        // Assert
        expect(result).toEqual(expectedBytes(64));
      });
    });
  });

  describe('Given a root whose oid is 32 bytes wide', () => {
    describe('When serializeCacheTree at width 20', () => {
      it('Then it refuses with the width reason', () => {
        // Arrange
        const sut = serializeCacheTree;

        // Act
        let caught: TsgitError | undefined;
        try {
          sut(tree(64), 20);
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'INVALID_INDEX_ENTRY',
          offset: 0,
          reason: 'cache-tree oid width does not match the digest length',
        });
      });
    });
  });
});

const fp = (...paths: string[]): IndexPath[] => paths.map((path) => ({ path: path as FilePath }));

function baseTree(): CacheTreeEntry {
  const e: CacheTreeEntry = {
    path: 'e',
    entryCount: 1,
    subtreeCount: 0,
    id: oid(40, 'e'),
    children: [],
  };
  const d: CacheTreeEntry = {
    path: 'd',
    entryCount: 2,
    subtreeCount: 1,
    id: oid(40, 'd'),
    children: [e],
  };
  const x: CacheTreeEntry = {
    path: 'x',
    entryCount: 1,
    subtreeCount: 0,
    id: oid(40, '1'),
    children: [],
  };
  return { path: '', entryCount: 5, subtreeCount: 2, id: oid(40, 'a'), children: [d, x] };
}

describe('invalidateCacheTree', () => {
  describe('Given the base tree', () => {
    describe('When invalidateCacheTree(["d/c"])', () => {
      it('Then root and d are -1 without id, e and x are the same objects', () => {
        // Arrange
        const root = baseTree();
        const sut = invalidateCacheTree;

        // Act
        const result = sut(root, fp('d/c'));

        // Assert
        expect(result.entryCount).toBe(-1);
        expect(result).not.toHaveProperty('id');
        expect(result.children[0]?.entryCount).toBe(-1);
        expect(result.children[0]).not.toHaveProperty('id');
        expect(result.children[0]?.children[0]).toBe(root.children[0]?.children[0]);
        expect(result.children[1]).toBe(root.children[1]);
      });
    });

    describe('When invalidateCacheTree(["d/e/n"])', () => {
      it('Then root, d and e are -1 and x is the same object', () => {
        // Arrange
        const root = baseTree();
        const sut = invalidateCacheTree;

        // Act
        const result = sut(root, fp('d/e/n'));

        // Assert
        expect(result.entryCount).toBe(-1);
        expect(result.children[0]?.entryCount).toBe(-1);
        expect(result.children[0]?.children[0]?.entryCount).toBe(-1);
        expect(result.children[0]?.children[0]).not.toHaveProperty('id');
        expect(result.children[1]).toBe(root.children[1]);
      });
    });

    describe('When invalidateCacheTree(["x"]) where x is a subtree name', () => {
      it('Then x is removed and root subtreeCount is 1', () => {
        // Arrange
        const root = baseTree();
        const sut = invalidateCacheTree;

        // Act
        const result = sut(root, fp('x'));

        // Assert
        expect(result.children.map((c) => c.path)).toEqual(['d']);
        expect(result.subtreeCount).toBe(1);
        expect(result.entryCount).toBe(-1);
        expect(result.children[0]).toBe(root.children[0]);
      });
    });

    describe('When invalidateCacheTree(["b", "d/b2", "q/r"])', () => {
      it('Then only the root and d chains are invalidated and no node is created', () => {
        // Arrange
        const root = baseTree();
        const sut = invalidateCacheTree;

        // Act
        const result = sut(root, fp('b', 'd/b2', 'q/r'));

        // Assert
        expect(result.children.map((c) => c.path)).toEqual(['d', 'x']);
        expect(result.entryCount).toBe(-1);
        expect(result.children[0]?.entryCount).toBe(-1);
        expect(result.children[0]?.children[0]).toBe(root.children[0]?.children[0]);
        expect(result.children[1]).toBe(root.children[1]);
      });
    });

    describe('When invalidateCacheTree([])', () => {
      it('Then the root itself is returned', () => {
        // Arrange
        const root = baseTree();
        const sut = invalidateCacheTree;

        // Act
        const result = sut(root, []);

        // Assert
        expect(result).toBe(root);
      });
    });
  });
});

describe('Given sibling cache-tree names that do not survive a UTF-8 round trip', () => {
  const node = (name: Uint8Array, header: string, id: string, children: Uint8Array[] = []) =>
    concatBytes([
      name,
      NUL,
      encode(header),
      id === '' ? new Uint8Array(0) : hexToBytes(id),
      ...children,
    ]);
  const BOM_B = new Uint8Array([0xef, 0xbb, 0xbf, 0x62]);
  const LONE_FF = new Uint8Array([0xff]);
  const ID_B = 'b'.repeat(40);
  const ID_BOM = 'c'.repeat(40);
  const ID_FF = 'd'.repeat(40);
  const carried = [
    node(encode('b'), '1 0\n', ID_B),
    node(BOM_B, '1 0\n', ID_BOM),
    node(LONE_FF, '1 0\n', ID_FF),
  ];
  const original = node(new Uint8Array(0), '4 1\n', 'a'.repeat(40), [
    node(encode('a'), '4 4\n', 'e'.repeat(40), [
      ...carried,
      node(encode('c'), '1 0\n', 'f'.repeat(40)),
    ]),
  ]);

  describe('When a path below the BOM-named subtree is invalidated', () => {
    it('Then the invalidated subtree keeps its exact name bytes', () => {
      // Arrange
      const sut = (data: Uint8Array): Uint8Array =>
        serializeCacheTree(invalidateCacheTree(parseCacheTree(data, 20), fp('a/\uFEFFb/x')), 20);

      // Act
      const result = sut(original);

      // Assert
      const expected = node(new Uint8Array(0), '-1 1\n', '', [
        node(encode('a'), '-1 4\n', '', [
          carried[0] as Uint8Array,
          node(BOM_B, '-1 0\n', ''),
          carried[2] as Uint8Array,
          node(encode('c'), '1 0\n', 'f'.repeat(40)),
        ]),
      ]);
      expect(result).toEqual(expected);
    });
  });

  describe('When an unrelated sibling path is invalidated', () => {
    it('Then the untouched subtrees keep their exact name bytes', () => {
      // Arrange
      const sut = (data: Uint8Array): Uint8Array =>
        serializeCacheTree(invalidateCacheTree(parseCacheTree(data, 20), fp('a/c')), 20);

      // Act
      const result = sut(original);

      // Assert
      const expected = node(new Uint8Array(0), '-1 1\n', '', [
        node(encode('a'), '-1 3\n', '', carried),
      ]);
      expect(result).toEqual(expected);
    });

    it('Then a path component sharing the lossy decode of a sibling does not remove it', () => {
      // Arrange
      const sut = (data: Uint8Array): Uint8Array =>
        serializeCacheTree(invalidateCacheTree(parseCacheTree(data, 20), fp('a/\uFEFFb')), 20);

      // Act
      const result = sut(original);

      // Assert
      const survivors = [
        carried[0],
        carried[2],
        node(encode('c'), '1 0\n', 'f'.repeat(40)),
      ] as Uint8Array[];
      const expected = node(new Uint8Array(0), '-1 1\n', '', [
        node(encode('a'), '-1 3\n', '', survivors),
      ]);
      expect(result).toEqual(expected);
    });
  });
});

describe('Given an invalidated entry that still carries an id', () => {
  describe('When serializeCacheTree writes it', () => {
    it('Then no oid follows the header, as git writes none for an invalid entry', () => {
      // Arrange
      const root: CacheTreeEntry = {
        path: '',
        entryCount: -1,
        subtreeCount: 0,
        id: oid(40, 'a'),
        children: [],
      };
      const sut = serializeCacheTree;

      // Act
      const result = sut(root, 20);

      // Assert
      expect(result).toEqual(concatBytes([NUL, encode('-1 0\n')]));
    });
  });
});

describe('Given a subtree whose raw name bytes are plain ASCII', () => {
  const asciiNamed = (): CacheTreeEntry => ({
    path: '',
    entryCount: 1,
    subtreeCount: 1,
    id: oid(40, 'a'),
    children: [
      {
        path: 'd',
        nameBytes: encode('d'),
        entryCount: 1,
        subtreeCount: 0,
        id: oid(40, 'b'),
        children: [],
      },
    ],
  });

  describe('When a path below it is invalidated', () => {
    it('Then that subtree is matched by its name and invalidated', () => {
      // Arrange
      const sut = invalidateCacheTree;

      // Act
      const result = sut(asciiNamed(), fp('d/f'));

      // Assert
      expect(result.children[0]?.entryCount).toBe(-1);
    });
  });
});

describe('Given a tree without raw name bytes', () => {
  describe('When a path is invalidated', () => {
    it('Then the rebuilt nodes carry no nameBytes key', () => {
      // Arrange
      const sut = invalidateCacheTree;

      // Act
      const result = sut(baseTree(), fp('d/c'));

      // Assert
      expect(result).not.toHaveProperty('nameBytes');
      expect(result.children[0]).not.toHaveProperty('nameBytes');
    });
  });
});

describe('Given subtrees named by raw non-UTF-8 bytes', () => {
  const FF = Uint8Array.of(0xff);
  const lossyChild = (): CacheTreeEntry => ({
    path: '\uFFFD',
    nameBytes: FF,
    entryCount: 1,
    subtreeCount: 0,
    id: oid(40, 'b'),
    children: [],
  });
  const validSibling = (path: string, digit: string): CacheTreeEntry => ({
    path,
    entryCount: 1,
    subtreeCount: 0,
    id: oid(40, digit),
    children: [],
  });
  const rootOf = (children: CacheTreeEntry[]): CacheTreeEntry => ({
    path: '',
    entryCount: 3,
    subtreeCount: children.length,
    id: oid(40, 'a'),
    children,
  });
  const lossyChange: IndexPath = {
    path: '\uFFFD/x' as FilePath,
    pathBytes: Uint8Array.of(0xff, 0x2f, 0x78),
  };

  describe('When a lossy path below the raw-named subtree is invalidated', () => {
    it('Then that subtree is invalidated, keeps its nameBytes, and a sibling is untouched', () => {
      // Arrange
      const sibling = validSibling('a', 'c');
      const root = rootOf([lossyChild(), sibling]);
      const sut = invalidateCacheTree;

      // Act
      const result = sut(root, [lossyChange]);

      // Assert
      expect(result.children[0]?.entryCount).toBe(-1);
      expect(result.children[0]).not.toHaveProperty('id');
      expect(result.children[0]?.nameBytes).toEqual(FF);
      expect(result.children[1]).toBe(sibling);
    });
  });

  describe('When a lossy path is invalidated beside a subtree named by the literal U+FFFD', () => {
    it('Then only the raw-named subtree is invalidated', () => {
      // Arrange
      const twin = validSibling('\uFFFD', 'c');
      const root = rootOf([lossyChild(), twin]);
      const sut = invalidateCacheTree;

      // Act
      const result = sut(root, [lossyChange]);

      // Assert
      expect(result.children[0]?.entryCount).toBe(-1);
      expect(result.children[1]).toBe(twin);
    });
  });

  describe('When a BOM path is invalidated', () => {
    it('Then the subtree whose nameBytes start with the BOM bytes is invalidated', () => {
      // Arrange
      const bomChild: CacheTreeEntry = {
        path: 'a',
        nameBytes: Uint8Array.of(0xef, 0xbb, 0xbf, 0x61),
        entryCount: 1,
        subtreeCount: 0,
        id: oid(40, 'b'),
        children: [],
      };
      const sibling = validSibling('a', 'c');
      const root = rootOf([bomChild, sibling]);
      const sut = invalidateCacheTree;

      // Act
      const result = sut(root, fp('\uFEFFa/x'));

      // Assert
      expect(result.children[0]?.entryCount).toBe(-1);
      expect(result.children[1]).toBe(sibling);
    });
  });
});
