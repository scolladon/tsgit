import { describe, expect, it } from 'vitest';

import type { TsgitError } from '../../../../src/domain/error.js';
import { serializeCacheTree } from '../../../../src/domain/git-index/cache-tree.js';
import type { CacheTreeEntry } from '../../../../src/domain/git-index/index-entry.js';
import { concatBytes, encode, hexToBytes } from '../../../../src/domain/objects/encoding.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';

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
