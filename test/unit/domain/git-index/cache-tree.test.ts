import { describe, expect, it } from 'vitest';

import type { TsgitError } from '../../../../src/domain/error.js';
import {
  invalidateCacheTree,
  serializeCacheTree,
} from '../../../../src/domain/git-index/cache-tree.js';
import type { CacheTreeEntry } from '../../../../src/domain/git-index/index-entry.js';
import { parseCacheTree } from '../../../../src/domain/git-index/index-parser.js';
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

const fp = (...paths: string[]): FilePath[] => paths as FilePath[];

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
        serializeCacheTree(
          invalidateCacheTree(parseCacheTree(data, 20), ['a/\uFEFFb/x' as FilePath]),
          20,
        );

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
        serializeCacheTree(invalidateCacheTree(parseCacheTree(data, 20), ['a/c' as FilePath]), 20);

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
        serializeCacheTree(
          invalidateCacheTree(parseCacheTree(data, 20), ['a/\uFEFFb' as FilePath]),
          20,
        );

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
