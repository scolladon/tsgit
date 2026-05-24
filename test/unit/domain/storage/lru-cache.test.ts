import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createLruCache } from '../../../../src/domain/storage/lru-cache.js';

describe('lru-cache', () => {
  describe('basic operations', () => {
    it('Given a new cache(100), When getting non-existent key, Then returns undefined', () => {
      // Arrange
      const sut = createLruCache<string>(100);

      // Act
      const result = sut.get('missing');

      // Assert
      expect(result).toBeUndefined();
    });

    it('Given a new cache(100), When checking has for non-existent key, Then returns false', () => {
      // Arrange
      const sut = createLruCache<string>(100);

      // Act & Assert
      expect(sut.has('missing')).toBe(false);
    });

    it("Given cache(100) with set('a', v, 50), When getting 'a', Then returns v", () => {
      // Arrange
      const sut = createLruCache<string>(100);
      sut.set('a', 'value-a', 50);

      // Act
      const result = sut.get('a');

      // Assert
      expect(result).toBe('value-a');
    });

    it("Given cache(100) with set('a', v, 50), When checking has('a'), Then returns true", () => {
      // Arrange
      const sut = createLruCache<string>(100);
      sut.set('a', 'value-a', 50);

      // Act & Assert
      expect(sut.has('a')).toBe(true);
    });

    it("Given cache(100) with set('a', v, 50), When checking currentSize, Then equals 50", () => {
      // Arrange
      const sut = createLruCache<string>(100);
      sut.set('a', 'value-a', 50);

      // Act & Assert
      expect(sut.currentSize).toBe(50);
    });

    it("Given cache(100) with set('a', v, 50), When checking entryCount, Then equals 1", () => {
      // Arrange
      const sut = createLruCache<string>(100);
      sut.set('a', 'value-a', 50);

      // Act & Assert
      expect(sut.entryCount).toBe(1);
    });

    it("Given cache(100) with set('a', v, 50), When checking maxSize, Then equals 100", () => {
      // Arrange
      const sut = createLruCache<string>(100);

      // Act & Assert
      expect(sut.maxSize).toBe(100);
    });
  });

  describe('eviction', () => {
    it('Given cache(100) with entries totaling 100, When adding entry that pushes over 100, Then LRU entry evicted', () => {
      // Arrange
      const sut = createLruCache<string>(100);
      sut.set('a', 'val-a', 60);
      sut.set('b', 'val-b', 40);

      // Act
      sut.set('c', 'val-c', 20);

      // Assert
      expect(sut.get('a')).toBeUndefined();
      expect(sut.get('b')).toBe('val-b');
      expect(sut.get('c')).toBe('val-c');
    });

    it('Given cache(100) with A(40) then B(40) then C(40), When checking, Then A evicted, B and C remain', () => {
      // Arrange
      const sut = createLruCache<string>(100);
      sut.set('a', 'val-a', 40);
      sut.set('b', 'val-b', 40);

      // Act
      sut.set('c', 'val-c', 40);

      // Assert
      expect(sut.get('a')).toBeUndefined();
      expect(sut.get('b')).toBe('val-b');
      expect(sut.get('c')).toBe('val-c');
    });

    it('Given cache(100) with A(40) then B(40), When getting A then adding C(40), Then B evicted (A promoted)', () => {
      // Arrange
      const sut = createLruCache<string>(100);
      sut.set('a', 'val-a', 40);
      sut.set('b', 'val-b', 40);
      sut.get('a');

      // Act
      sut.set('c', 'val-c', 40);

      // Assert
      expect(sut.get('a')).toBe('val-a');
      expect(sut.get('b')).toBeUndefined();
      expect(sut.get('c')).toBe('val-c');
    });
  });

  describe('size tracking', () => {
    it('Given cache(100) with A(50), When updating A with byteSize 80, Then currentSize is 80', () => {
      // Arrange
      const sut = createLruCache<string>(100);
      sut.set('a', 'old', 50);

      // Act
      sut.set('a', 'new', 80);

      // Assert
      expect(sut.currentSize).toBe(80);
      expect(sut.get('a')).toBe('new');
    });

    it('Given cache(100) with A(50) and B(30), When updating A with byteSize 90, Then B evicted, currentSize is 90', () => {
      // Arrange
      const sut = createLruCache<string>(100);
      sut.set('a', 'val-a', 50);
      sut.set('b', 'val-b', 30);

      // Act
      sut.set('a', 'new-a', 90);

      // Assert
      expect(sut.get('b')).toBeUndefined();
      expect(sut.currentSize).toBe(90);
    });
  });

  describe('delete and clear', () => {
    it('Given cache with entries, When deleting existing key, Then returns true and size decreases', () => {
      // Arrange
      const sut = createLruCache<string>(100);
      sut.set('a', 'val-a', 50);

      // Act
      const result = sut.delete('a');

      // Assert
      expect(result).toBe(true);
      expect(sut.currentSize).toBe(0);
      expect(sut.entryCount).toBe(0);
    });

    it('Given cache with entries, When deleting non-existent key, Then returns false', () => {
      // Arrange
      const sut = createLruCache<string>(100);

      // Act
      const result = sut.delete('missing');

      // Assert
      expect(result).toBe(false);
    });

    it('Given cache with entries, When clearing, Then entryCount=0, currentSize=0', () => {
      // Arrange
      const sut = createLruCache<string>(100);
      sut.set('a', 'val-a', 30);
      sut.set('b', 'val-b', 40);

      // Act
      sut.clear();

      // Assert
      expect(sut.entryCount).toBe(0);
      expect(sut.currentSize).toBe(0);
    });

    it('Given cleared cache, When getting previously set key, Then returns undefined', () => {
      // Arrange
      const sut = createLruCache<string>(100);
      sut.set('a', 'val-a', 30);
      sut.clear();

      // Act
      const result = sut.get('a');

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('Given cache(0), When setting any entry, Then entry is immediately evicted (no-op cache)', () => {
      // Arrange
      const sut = createLruCache<string>(0);

      // Act
      sut.set('a', 'val-a', 10);

      // Assert
      expect(sut.get('a')).toBeUndefined();
    });

    it('Given cache(0), When checking currentSize after set, Then equals 0', () => {
      // Arrange
      const sut = createLruCache<string>(0);

      // Act
      sut.set('a', 'val-a', 10);

      // Assert
      expect(sut.currentSize).toBe(0);
    });

    it('Given cache(50) with single 200-byte entry, When getting immediately after set, Then returns undefined', () => {
      // Arrange
      const sut = createLruCache<string>(50);

      // Act
      sut.set('big', 'large-value', 200);

      // Assert
      expect(sut.get('big')).toBeUndefined();
    });

    it('Given cache(50) holding a(30), When setting an over-cap 200-byte entry, Then the existing entry is left untouched (set is a pure no-op)', () => {
      // Arrange — kills the L92 `byteSize > maxSizeBytes` ConditionalExpression
      // `false` mutant AND the L92 `{ return; }` BlockStatement `{}` mutant:
      // without the early return, the over-cap entry is inserted and the
      // subsequent evict() walk also evicts the pre-existing 'a'.
      const sut = createLruCache<string>(50);
      sut.set('a', 'A', 30);

      // Act
      sut.set('big', 'large-value', 200);

      // Assert — 'a' survives; the over-cap set changed nothing.
      expect(sut.get('a')).toBe('A');
      expect(sut.currentSize).toBe(30);
      expect(sut.entryCount).toBe(1);
      expect(sut.get('big')).toBeUndefined();
    });

    it('Given a cache where the sole head node is removed twice via delete then refilled, When two entries force eviction, Then currentSize reflects only live entries', () => {
      // Arrange — exercises removeNode on a head node (node.prev === null) so
      // the L32 else-branch `head = node.next` matters. Without it, `head`
      // stays a dead node, a later addToHead wires a live node's `.next` to
      // the dead node, and a subsequent removeNode skips the tail update —
      // leaving a dead node as `tail`. evict() then decrements currentSize by
      // the dead node's stale byteSize (60 instead of the correct 60-only-live).
      const sut = createLruCache<string>(100);
      sut.set('a', 'A', 10);
      sut.delete('a'); // removeNode on sole head node
      sut.set('b', 'B', 10);
      sut.delete('b'); // removeNode on sole head node again

      // Act — two 60-byte entries: total 120 > 100 forces one eviction.
      sut.set('c', 'C', 60);
      sut.set('d', 'D', 60);

      // Assert — exactly one live entry of 60 bytes remains.
      expect(sut.entryCount).toBe(1);
      expect(sut.currentSize).toBe(60);
      expect(sut.get('d')).toBe('D');
      expect(sut.get('c')).toBeUndefined();
    });

    it('Given set with byteSize=0, When calling, Then throws Error with message indicating byteSize must be positive', () => {
      // Arrange
      const sut = createLruCache<string>(100);

      // Act & Assert
      expect(() => sut.set('a', 'val', 0)).toThrow('byteSize must be positive');
    });

    it('Given set with negative byteSize, When calling, Then throws Error', () => {
      // Arrange
      const sut = createLruCache<string>(100);

      // Act & Assert
      expect(() => sut.set('a', 'val', -1)).toThrow('byteSize must be positive');
    });

    it('Given cache(100) with entries totaling exactly 100, When checking, Then no eviction occurs', () => {
      // Arrange
      const sut = createLruCache<string>(100);
      sut.set('a', 'val-a', 50);
      sut.set('b', 'val-b', 50);

      // Assert — currentSize === maxSize, nothing evicted
      expect(sut.entryCount).toBe(2);
      expect(sut.currentSize).toBe(100);
      expect(sut.get('a')).toBe('val-a');
      expect(sut.get('b')).toBe('val-b');
    });

    it('Given cache with 3 entries, When deleting middle entry, Then remaining entries accessible in correct order', () => {
      // Arrange
      const sut = createLruCache<string>(100);
      sut.set('a', 'val-a', 10);
      sut.set('b', 'val-b', 10);
      sut.set('c', 'val-c', 10);

      // Act — delete middle
      sut.delete('b');

      // Assert — remaining entries still accessible, eviction order correct
      expect(sut.entryCount).toBe(2);
      expect(sut.get('a')).toBe('val-a');
      expect(sut.get('c')).toBe('val-c');

      // Add entries to force eviction of 'a' (LRU after 'c' was promoted by get above)
      sut.set('d', 'val-d', 85);
      expect(sut.get('a')).toBeUndefined();
      expect(sut.get('c')).toBe('val-c');
    });

    it('Given cache(100) with A then B, When calling has(A) then adding C that evicts, Then A is evicted (has does not promote)', () => {
      // Arrange
      const sut = createLruCache<string>(100);
      sut.set('a', 'val-a', 40);
      sut.set('b', 'val-b', 40);
      sut.has('a');

      // Act
      sut.set('c', 'val-c', 40);

      // Assert
      expect(sut.get('a')).toBeUndefined();
      expect(sut.get('b')).toBe('val-b');
      expect(sut.get('c')).toBe('val-c');
    });
  });

  describe('property-based tests', () => {
    it('Given any sequence of set operations, When checking currentSize, Then never exceeds maxSize', () => {
      fc.assert(
        fc.property(
          fc.array(fc.tuple(fc.string(), fc.integer({ min: 1, max: 1000 }))),
          fc.integer({ min: 1, max: 10000 }),
          (entries, maxSize) => {
            // Arrange
            const sut = createLruCache<null>(maxSize);

            // Act
            for (const [key, size] of entries) {
              sut.set(key, null, size);
            }

            // Assert
            expect(sut.currentSize).toBeLessThanOrEqual(maxSize);
          },
        ),
      );
    });

    it('Given set(k, v, s) then get(k), When checking result, Then equals v', () => {
      fc.assert(
        fc.property(
          fc.string(),
          fc.string(),
          fc.integer({ min: 1, max: 100 }),
          (key, value, size) => {
            // Arrange
            const sut = createLruCache<string>(1000);

            // Act
            sut.set(key, value, size);
            const result = sut.get(key);

            // Assert
            expect(result).toBe(value);
          },
        ),
      );
    });

    it('Given any sequence of operations, When clear() is called, Then entryCount === 0 and currentSize === 0', () => {
      fc.assert(
        fc.property(
          fc.array(fc.tuple(fc.string(), fc.integer({ min: 1, max: 100 }))),
          (entries) => {
            // Arrange
            const sut = createLruCache<null>(1000);
            for (const [key, size] of entries) {
              sut.set(key, null, size);
            }

            // Act
            sut.clear();

            // Assert
            expect(sut.entryCount).toBe(0);
            expect(sut.currentSize).toBe(0);
          },
        ),
      );
    });
  });

  describe('entry-cap boundary (isolated from byte cap)', () => {
    it('Given createLruCache(huge, 10) and 9 entries set, When entryCount is read, Then equals 9 (just-under)', () => {
      // Arrange
      const sut = createLruCache<number>(Number.MAX_SAFE_INTEGER, 10);

      // Act
      for (let i = 0; i < 9; i += 1) sut.set(`k${i}`, i, 10);

      // Assert
      expect(sut.entryCount).toBe(9);
    });

    it('Given createLruCache(huge, 10) and exactly 10 entries set, When entryCount is read, Then equals 10 and oldest still present (at)', () => {
      // Arrange
      const sut = createLruCache<number>(Number.MAX_SAFE_INTEGER, 10);

      // Act
      for (let i = 0; i < 10; i += 1) sut.set(`k${i}`, i, 10);

      // Assert
      expect(sut.entryCount).toBe(10);
      expect(sut.has('k0')).toBe(true);
    });

    it('Given createLruCache(huge, 10) and 11 entries set, When entryCount is read, Then equals 10 and oldest key is evicted (just-over)', () => {
      // Arrange
      const sut = createLruCache<number>(Number.MAX_SAFE_INTEGER, 10);

      // Act
      for (let i = 0; i < 11; i += 1) sut.set(`k${i}`, i, 10);

      // Assert
      expect(sut.entryCount).toBe(10);
      expect(sut.has('k0')).toBe(false);
      expect(sut.has('k10')).toBe(true);
    });
  });

  describe('backward-compat single-arg', () => {
    it('Given createLruCache(1024) legacy single-arg call, When 1000 tiny entries set within budget, Then all 1000 are present', () => {
      // Arrange
      const sut = createLruCache<number>(1024);

      // Act
      for (let i = 0; i < 1000; i += 1) sut.set(`k${i}`, i, 1);

      // Assert
      expect(sut.entryCount).toBe(1000);
    });
  });

  describe('combined caps first-hit', () => {
    it('Given createLruCache(100, 10) and 11 tiny entries, When filled, Then entry cap fires first (entryCount capped at 10)', () => {
      // Arrange
      const sut = createLruCache<number>(100, 10);

      // Act
      for (let i = 0; i < 11; i += 1) sut.set(`k${i}`, i, 5);

      // Assert
      expect(sut.entryCount).toBe(10);
      expect(sut.currentSize).toBeLessThanOrEqual(100);
    });

    it('Given createLruCache(100, 10) and 2 × 100-byte entries, When the second is set, Then byte cap fires first (oldest evicted)', () => {
      // Arrange
      const sut = createLruCache<number>(100, 10);

      // Act
      sut.set('a', 1, 100);
      sut.set('b', 2, 100);

      // Assert
      expect(sut.has('a')).toBe(false);
      expect(sut.has('b')).toBe(true);
      expect(sut.currentSize).toBe(100);
    });
  });
});
