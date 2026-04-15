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

    it('Given any sequence of operations, after clear(), entryCount === 0 and currentSize === 0', () => {
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
});
