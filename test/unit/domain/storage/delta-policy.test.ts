import { describe, expect, it } from 'vitest';
import {
  acceptsDeltaEntry,
  comparePackEmissionOrder,
  DEFAULT_PACK_DEPTH,
  DEFAULT_PACK_WINDOW,
  MAX_OFS_OVERHEAD_BYTES,
  NO_RECENCY,
  type PackEmissionKey,
  resolveDeltaPolicy,
} from '../../../../src/domain/storage/delta-policy.js';
import { PACK_ENTRY_TYPE } from '../../../../src/domain/storage/pack-entry.js';

const key = (
  id: string,
  type: PackEmissionKey['type'],
  uncompressedSize: number,
  nameHash = 0,
  recency: number = NO_RECENCY,
): PackEmissionKey => ({ id, type, uncompressedSize, nameHash, recency });

describe('comparePackEmissionOrder', () => {
  describe('Given two keys of different types', () => {
    describe('When compared', () => {
      it('Then the lower type rank sorts first', () => {
        // Arrange
        const sut = comparePackEmissionOrder;
        const blob = key('b', PACK_ENTRY_TYPE.BLOB, 10);
        const commit = key('a', PACK_ENTRY_TYPE.COMMIT, 10);

        // Act
        const result = sut(commit, blob);

        // Assert
        expect(result).toBeLessThan(0);
      });
    });
  });

  describe('Given two keys of different types whose id ordering disagrees with their type ordering', () => {
    describe('When compared', () => {
      it('Then the lower type rank still sorts first — type is the primary key, not id', () => {
        // Arrange — commit (rank 1) carries the HIGHER id, blob (rank 3) the
        // LOWER one, so a comparator that skipped the type check and fell
        // through to the id tiebreaker would report the opposite sign.
        const sut = comparePackEmissionOrder;
        const commit = key('z', PACK_ENTRY_TYPE.COMMIT, 10);
        const blob = key('a', PACK_ENTRY_TYPE.BLOB, 10);

        // Act
        const result = sut(commit, blob);

        // Assert
        expect(result).toBeLessThan(0);
      });
    });
  });

  describe('Given two keys of the same type whose nameHash order disagrees with their size order', () => {
    describe('When compared', () => {
      it('Then the nameHash order decides, not size', () => {
        // Arrange
        const sut = comparePackEmissionOrder;
        const higherHashSmallerSize = key('a', PACK_ENTRY_TYPE.BLOB, 10, 20);
        const lowerHashBiggerSize = key('b', PACK_ENTRY_TYPE.BLOB, 100, 5);

        // Act
        const result = sut(higherHashSmallerSize, lowerHashBiggerSize);

        // Assert
        expect(result).toBeLessThan(0);
      });
    });
  });

  describe('Given two keys of the same type and size, differing only in nameHash', () => {
    describe('When compared', () => {
      it('Then the larger nameHash sorts first (DESC)', () => {
        // Arrange
        const sut = comparePackEmissionOrder;
        const higherHash = key('z', PACK_ENTRY_TYPE.BLOB, 10, 20);
        const lowerHash = key('a', PACK_ENTRY_TYPE.BLOB, 10, 5);

        // Act
        const result = sut(higherHash, lowerHash);

        // Assert
        expect(result).toBeLessThan(0);
      });
    });
  });

  describe('Given two keys of the same type and different sizes', () => {
    describe('When compared', () => {
      it('Then the larger size sorts first (DESC)', () => {
        // Arrange
        const sut = comparePackEmissionOrder;
        const bigger = key('a', PACK_ENTRY_TYPE.BLOB, 100);
        const smaller = key('b', PACK_ENTRY_TYPE.BLOB, 10);

        // Act
        const result = sut(bigger, smaller);

        // Assert
        expect(result).toBeLessThan(0);
      });
    });
  });

  describe('Given two keys of the same type and nameHash whose size order disagrees with their recency order', () => {
    describe('When compared', () => {
      it('Then the size order decides, not recency', () => {
        // Arrange
        const sut = comparePackEmissionOrder;
        const biggerLaterRecency = key('a', PACK_ENTRY_TYPE.BLOB, 100, 0, 5);
        const smallerEarlierRecency = key('b', PACK_ENTRY_TYPE.BLOB, 10, 0, 1);

        // Act
        const result = sut(biggerLaterRecency, smallerEarlierRecency);

        // Assert
        expect(result).toBeLessThan(0);
      });
    });
  });

  describe('Given two keys of the same type, nameHash and size, differing only in recency', () => {
    describe('When compared', () => {
      it('Then the smaller recency sorts first (ASC)', () => {
        // Arrange
        const sut = comparePackEmissionOrder;
        const earlier = key('z', PACK_ENTRY_TYPE.BLOB, 10, 0, 1);
        const later = key('a', PACK_ENTRY_TYPE.BLOB, 10, 0, 5);

        // Act
        const result = sut(earlier, later);

        // Assert
        expect(result).toBeLessThan(0);
      });
    });
  });

  describe('Given two keys of the same type, nameHash and size, whose recency order disagrees with their id order', () => {
    describe('When compared', () => {
      it('Then the recency order decides, not id', () => {
        // Arrange
        const sut = comparePackEmissionOrder;
        const earlierRecencyHigherId = key('z', PACK_ENTRY_TYPE.BLOB, 10, 0, 1);
        const laterRecencyLowerId = key('a', PACK_ENTRY_TYPE.BLOB, 10, 0, 5);

        // Act
        const result = sut(earlierRecencyHigherId, laterRecencyLowerId);

        // Assert
        expect(result).toBeLessThan(0);
      });
    });
  });

  describe('Given two keys of the same type and size', () => {
    describe('When compared', () => {
      it('Then the lower id sorts first (ASC)', () => {
        // Arrange
        const sut = comparePackEmissionOrder;
        const first = key('aaa', PACK_ENTRY_TYPE.BLOB, 10);
        const second = key('bbb', PACK_ENTRY_TYPE.BLOB, 10);

        // Act
        const result = sut(first, second);

        // Assert
        expect(result).toBeLessThan(0);
      });
    });
  });

  describe('Given two keys both at NO_RECENCY, differing only in id', () => {
    describe('When compared', () => {
      it('Then id decides, exactly as when recency is never supplied', () => {
        // Arrange
        const sut = comparePackEmissionOrder;
        const first = key('ccc', PACK_ENTRY_TYPE.BLOB, 10, 0, NO_RECENCY);
        const second = key('ddd', PACK_ENTRY_TYPE.BLOB, 10, 0, NO_RECENCY);

        // Act
        const result = sut(first, second);

        // Assert
        expect(result).toBeLessThan(0);
      });
    });
  });

  describe('Given two distinct keys with distinct recencies', () => {
    describe('When compared in both directions', () => {
      it('Then the order is a strict total order — never zero for distinct recencies', () => {
        // Arrange
        const sut = comparePackEmissionOrder;
        const a = key('aaa', PACK_ENTRY_TYPE.TREE, 5, 0, 1);
        const b = key('bbb', PACK_ENTRY_TYPE.TREE, 5, 0, 2);

        // Act
        const forward = sut(a, b);
        const backward = sut(b, a);

        // Assert
        expect(forward).not.toBe(0);
        expect(Math.sign(forward)).toBe(-Math.sign(backward));
      });
    });
  });

  describe('Given two distinct keys', () => {
    describe('When compared in both directions', () => {
      it('Then the order is a strict total order — never zero for distinct ids', () => {
        // Arrange
        const sut = comparePackEmissionOrder;
        const a = key('aaa', PACK_ENTRY_TYPE.TREE, 5);
        const b = key('bbb', PACK_ENTRY_TYPE.TREE, 5);

        // Act
        const forward = sut(a, b);
        const backward = sut(b, a);

        // Assert
        expect(forward).not.toBe(0);
        expect(Math.sign(forward)).toBe(-Math.sign(backward));
      });
    });
  });

  describe('Given two identical keys (duplicate oid)', () => {
    describe('When compared', () => {
      it('Then the comparator reports equal', () => {
        // Arrange
        const sut = comparePackEmissionOrder;
        const a = key('same', PACK_ENTRY_TYPE.BLOB, 5);
        const b = key('same', PACK_ENTRY_TYPE.BLOB, 5);

        // Act
        const result = sut(a, b);

        // Assert
        expect(result).toBe(0);
      });
    });
  });
});

describe('acceptsDeltaEntry', () => {
  describe('Given a delta strictly smaller than the content once overhead is added', () => {
    describe('When checked', () => {
      it('Then it is accepted', () => {
        // Arrange
        const sut = acceptsDeltaEntry;

        // Act
        const result = sut(10, 10 + MAX_OFS_OVERHEAD_BYTES + 1);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a delta whose length plus overhead exactly equals the content length', () => {
    describe('When checked', () => {
      it('Then it is rejected (ties go to the base)', () => {
        // Arrange
        const sut = acceptsDeltaEntry;

        // Act
        const result = sut(10, 10 + MAX_OFS_OVERHEAD_BYTES);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a delta one byte larger than the content once overhead is added', () => {
    describe('When checked', () => {
      it('Then it is rejected', () => {
        // Arrange
        const sut = acceptsDeltaEntry;

        // Act
        const result = sut(10, 10 + MAX_OFS_OVERHEAD_BYTES - 1);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a pair that only flips verdict because of the overhead term', () => {
    describe('When checked with and without the overhead margin', () => {
      it('Then dropping MAX_OFS_OVERHEAD_BYTES would have accepted, but the real rule rejects', () => {
        // Arrange
        const sut = acceptsDeltaEntry;
        const deltaLength = 10;
        const contentLength = 10 + MAX_OFS_OVERHEAD_BYTES - 2;

        // Act
        const withOverhead = sut(deltaLength, contentLength);
        const withoutOverhead = deltaLength < contentLength;

        // Assert
        expect(withOverhead).toBe(false);
        expect(withoutOverhead).toBe(true);
      });
    });
  });
});

describe('resolveDeltaPolicy', () => {
  describe('Given an empty config', () => {
    describe('When resolved', () => {
      it('Then window and depth default to 10 and 50', () => {
        // Arrange
        const sut = resolveDeltaPolicy;

        // Act
        const result = sut({});

        // Assert
        expect(result.window).toBe(DEFAULT_PACK_WINDOW);
        expect(result.maxDepth).toBe(DEFAULT_PACK_DEPTH);
        expect(result.enabled).toBe(true);
        expect(result.windowMemoryBudget).toBe(0);
      });
    });
  });

  describe('Given window = 0 alone', () => {
    describe('When resolved', () => {
      it('Then delta emission is disabled', () => {
        // Arrange
        const sut = resolveDeltaPolicy;

        // Act
        const result = sut({ window: 0 });

        // Assert
        expect(result.enabled).toBe(false);
      });
    });
  });

  describe('Given window = -1 alone', () => {
    describe('When resolved', () => {
      it('Then delta emission is disabled', () => {
        // Arrange
        const sut = resolveDeltaPolicy;

        // Act
        const result = sut({ window: -1 });

        // Assert
        expect(result.enabled).toBe(false);
      });
    });
  });

  describe('Given depth = 0 alone', () => {
    describe('When resolved', () => {
      it('Then delta emission is disabled', () => {
        // Arrange
        const sut = resolveDeltaPolicy;

        // Act
        const result = sut({ depth: 0 });

        // Assert
        expect(result.enabled).toBe(false);
      });
    });
  });

  describe('Given depth = -1 alone', () => {
    describe('When resolved', () => {
      it('Then delta emission is disabled', () => {
        // Arrange
        const sut = resolveDeltaPolicy;

        // Act
        const result = sut({ depth: -1 });

        // Assert
        expect(result.enabled).toBe(false);
      });
    });
  });

  describe('Given depth = 250, above tsgit reader cap', () => {
    describe('When resolved', () => {
      it('Then maxDepth clamps to 50', () => {
        // Arrange
        const sut = resolveDeltaPolicy;

        // Act
        const result = sut({ depth: 250 });

        // Assert
        expect(result.maxDepth).toBe(50);
      });
    });
  });

  describe('Given depth = 10, below the reader cap', () => {
    describe('When resolved', () => {
      it('Then maxDepth is the configured value, unclamped', () => {
        // Arrange
        const sut = resolveDeltaPolicy;

        // Act
        const result = sut({ depth: 10 });

        // Assert
        expect(result.maxDepth).toBe(10);
      });
    });
  });

  describe('Given no windowMemory in config', () => {
    describe('When resolved', () => {
      it('Then windowMemoryBudget is 0 (unlimited)', () => {
        // Arrange
        const sut = resolveDeltaPolicy;

        // Act
        const result = sut({});

        // Assert
        expect(result.windowMemoryBudget).toBe(0);
      });
    });
  });

  describe('Given a windowMemory value in config', () => {
    describe('When resolved', () => {
      it('Then windowMemoryBudget carries that value', () => {
        // Arrange
        const sut = resolveDeltaPolicy;

        // Act
        const result = sut({ windowMemory: 65536 });

        // Assert
        expect(result.windowMemoryBudget).toBe(65536);
      });
    });
  });
});
