import { describe, expect, it } from 'vitest';
import {
  packPositionMap,
  revIndexPositions,
} from '../../../../../src/application/primitives/internal/pack-positions.js';
import type { ObjectId } from '../../../../../src/domain/objects/object-id.js';
import {
  type PackRevIndex,
  parsePackIndex,
  parsePackRevIndex,
} from '../../../../../src/domain/storage/index.js';
import {
  buildRevIndex,
  buildTestIndex,
  type TestIndexEntry,
} from '../../../domain/storage/arbitraries.js';

const DIGEST_LENGTH = 20;

function makeEntry(id: string, offset: number): TestIndexEntry {
  return { id: id as ObjectId, offset, crc32: 0 };
}

/** A hex id whose ordinal grows with `i`, so entries built from an ascending
 *  `i` sort into the SAME order by oid as by array position. */
function oidAt(i: number): string {
  return `${(0x10 + i).toString(16).padStart(2, '0')}${'0'.repeat(38)}`;
}

function buildIndex(offsets: ReadonlyArray<number>) {
  const entries = offsets.map((offset, i) => makeEntry(oidAt(i), offset));
  return parsePackIndex(buildTestIndex(entries), DIGEST_LENGTH);
}

function buildRev(body: ReadonlyArray<number>): PackRevIndex {
  const bytes = buildRevIndex({
    hashId: 1,
    digestLength: DIGEST_LENGTH,
    body,
    packChecksum: new Uint8Array(DIGEST_LENGTH),
  });
  return parsePackRevIndex(bytes, DIGEST_LENGTH, body.length);
}

describe('packPositionMap', () => {
  describe('Given a pack index with 0 entries', () => {
    describe('When packPositionMap is called', () => {
      it('Then returns an empty Uint32Array', () => {
        // Arrange
        const index = buildIndex([]);
        const sut = packPositionMap;

        // Act
        const result = sut(index);

        // Assert
        expect(result).toEqual(new Uint32Array(0));
      });
    });
  });

  describe('Given a pack index whose entries are already ascending by offset', () => {
    describe('When packPositionMap is called', () => {
      it('Then it returns the identity permutation', () => {
        // Arrange
        const index = buildIndex([10, 20, 30]);
        const sut = packPositionMap;

        // Act
        const result = sut(index);

        // Assert — index position i already holds the i-th smallest offset
        expect(result).toEqual(Uint32Array.of(0, 1, 2));
      });
    });
  });

  describe('Given a pack index whose entries are stored out of offset order', () => {
    describe('When packPositionMap is called', () => {
      it('Then it returns the index positions reordered by ascending offset', () => {
        // Arrange — index position 0 holds offset 30, position 1 holds 10,
        // position 2 holds 20: ascending-offset order is [1, 2, 0].
        const index = buildIndex([30, 10, 20]);
        const sut = packPositionMap;

        // Act
        const result = sut(index);

        // Assert
        expect(result).toEqual(Uint32Array.of(1, 2, 0));
      });
    });
  });
});

describe('revIndexPositions', () => {
  describe('Given a .rev body that is a valid permutation', () => {
    describe('When revIndexPositions is called', () => {
      it('Then it returns the body read straight into a Uint32Array, in order', () => {
        // Arrange
        const rev = buildRev([2, 0, 1]);
        const sut = revIndexPositions;

        // Act
        const result = sut(rev, 3);

        // Assert
        expect(result).toEqual(Uint32Array.of(2, 0, 1));
      });
    });
  });

  describe('Given a .rev body whose first stored value equals objectCount', () => {
    describe('When revIndexPositions is called', () => {
      it('Then it returns undefined — one past the last valid index position', () => {
        // Arrange
        const rev = buildRev([3, 0, 1]);
        const sut = revIndexPositions;

        // Act
        const result = sut(rev, 3);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a .rev body whose LAST stored value is out of range', () => {
    describe('When revIndexPositions is called', () => {
      it('Then it returns undefined — the bound is checked for every position, not just the first', () => {
        // Arrange
        const rev = buildRev([0, 1, 99]);
        const sut = revIndexPositions;

        // Act
        const result = sut(rev, 3);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given an empty .rev body', () => {
    describe('When revIndexPositions is called with objectCount 0', () => {
      it('Then it returns an empty Uint32Array', () => {
        // Arrange
        const rev = buildRev([]);
        const sut = revIndexPositions;

        // Act
        const result = sut(rev, 0);

        // Assert
        expect(result).toEqual(new Uint32Array(0));
      });
    });
  });
});
