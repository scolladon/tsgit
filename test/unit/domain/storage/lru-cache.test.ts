import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createLruCache } from '../../../../src/domain/storage/lru-cache.js';

describe('lru-cache', () => {
  describe('basic operations', () => {
    describe('Given a new cache(100)', () => {
      describe('When getting non-existent key', () => {
        it('Then returns undefined', () => {
          // Arrange
          const sut = createLruCache<string>(100);

          // Act
          const result = sut.get('missing');

          // Assert
          expect(result).toBeUndefined();
        });
      });
      describe('When checking has for non-existent key', () => {
        it('Then returns false', () => {
          // Arrange
          const sut = createLruCache<string>(100);

          // Act & Assert
          expect(sut.has('missing')).toBe(false);
        });
      });
    });

    describe("Given cache(100) with set('a', v, 50)", () => {
      describe("When getting 'a'", () => {
        it('Then returns v', () => {
          // Arrange
          const sut = createLruCache<string>(100);
          sut.set('a', 'value-a', 50);

          // Act
          const result = sut.get('a');

          // Assert
          expect(result).toBe('value-a');
        });
      });
      describe("When checking has('a')", () => {
        it('Then returns true', () => {
          // Arrange
          const sut = createLruCache<string>(100);
          sut.set('a', 'value-a', 50);

          // Act & Assert
          expect(sut.has('a')).toBe(true);
        });
      });
      describe('When checking currentSize', () => {
        it('Then equals 50', () => {
          // Arrange
          const sut = createLruCache<string>(100);
          sut.set('a', 'value-a', 50);

          // Act & Assert
          expect(sut.currentSize).toBe(50);
        });
      });
      describe('When checking entryCount', () => {
        it('Then equals 1', () => {
          // Arrange
          const sut = createLruCache<string>(100);
          sut.set('a', 'value-a', 50);

          // Act & Assert
          expect(sut.entryCount).toBe(1);
        });
      });
      describe('When checking maxSize', () => {
        it('Then equals 100', () => {
          // Arrange
          const sut = createLruCache<string>(100);

          // Act & Assert
          expect(sut.maxSize).toBe(100);
        });
      });
    });
  });

  describe('eviction', () => {
    describe('Given a cache(100) with two entries then a third that overflows it', () => {
      describe('When the third entry is set', () => {
        it.each([
          {
            sizes: [60, 40, 20] as const,
            outcome: 'the LRU entry (a) is evicted once the exact-100 cap is exceeded',
          },
          {
            sizes: [40, 40, 40] as const,
            outcome: 'the LRU entry (a) is evicted, b and c remain',
          },
        ])('Then $outcome', ({ sizes: [aSize, bSize, cSize] }) => {
          // Arrange
          const sut = createLruCache<string>(100);
          sut.set('a', 'val-a', aSize);
          sut.set('b', 'val-b', bSize);

          // Act
          sut.set('c', 'val-c', cSize);

          // Assert
          expect(sut.get('a')).toBeUndefined();
          expect(sut.get('b')).toBe('val-b');
          expect(sut.get('c')).toBe('val-c');
        });
      });
    });

    describe('Given cache(100) with A(40) then B(40)', () => {
      describe('When getting A then adding C(40)', () => {
        it('Then B evicted (A promoted)', () => {
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
    });
  });

  describe('size tracking', () => {
    describe('Given cache(100) with A(50)', () => {
      describe('When updating A with byteSize 80', () => {
        it('Then currentSize is 80', () => {
          // Arrange
          const sut = createLruCache<string>(100);
          sut.set('a', 'old', 50);

          // Act
          sut.set('a', 'new', 80);

          // Assert
          expect(sut.currentSize).toBe(80);
          expect(sut.get('a')).toBe('new');
        });
      });
    });

    describe('Given cache(100) with A(50) and B(30)', () => {
      describe('When updating A with byteSize 90', () => {
        it('Then B evicted, currentSize is 90', () => {
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
    });
  });

  describe('delete and clear', () => {
    describe('Given cache with entries', () => {
      describe('When deleting existing key', () => {
        it('Then returns true and size decreases', () => {
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
      });
      describe('When deleting non-existent key', () => {
        it('Then returns false', () => {
          // Arrange
          const sut = createLruCache<string>(100);

          // Act
          const result = sut.delete('missing');

          // Assert
          expect(result).toBe(false);
        });
      });
      describe('When clearing', () => {
        it('Then entryCount=0, currentSize=0', () => {
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
      });
    });

    describe('Given cleared cache', () => {
      describe('When getting previously set key', () => {
        it('Then returns undefined', () => {
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
    });
  });

  describe('edge cases', () => {
    describe('Given cache(0)', () => {
      describe('When setting any entry', () => {
        it('Then entry is immediately evicted (no-op cache)', () => {
          // Arrange
          const sut = createLruCache<string>(0);

          // Act
          sut.set('a', 'val-a', 10);

          // Assert
          expect(sut.get('a')).toBeUndefined();
        });
      });
      describe('When checking currentSize after set', () => {
        it('Then equals 0', () => {
          // Arrange
          const sut = createLruCache<string>(0);

          // Act
          sut.set('a', 'val-a', 10);

          // Assert
          expect(sut.currentSize).toBe(0);
        });
      });
    });

    describe('Given cache(50) with single 200-byte entry', () => {
      describe('When getting immediately after set', () => {
        it('Then returns undefined', () => {
          // Arrange
          const sut = createLruCache<string>(50);

          // Act
          sut.set('big', 'large-value', 200);

          // Assert
          expect(sut.get('big')).toBeUndefined();
        });
      });
    });

    describe('Given cache(50) holding a(30)', () => {
      describe('When setting an over-cap 200-byte entry', () => {
        it('Then the existing entry is left untouched (set is a pure no-op)', () => {
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
      });
    });

    describe('Given a cache where the sole head node is removed twice via delete then refilled', () => {
      describe('When two entries force eviction', () => {
        it('Then currentSize reflects only live entries', () => {
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
      });
    });

    describe('Given set with byteSize=0', () => {
      describe('When calling', () => {
        it('Then throws Error with message indicating byteSize must be positive', () => {
          // Arrange
          const sut = createLruCache<string>(100);

          // Act & Assert
          expect(() => sut.set('a', 'val', 0)).toThrow('byteSize must be positive');
        });
      });
    });

    describe('Given set with negative byteSize', () => {
      describe('When calling', () => {
        it('Then throws Error', () => {
          // Arrange
          const sut = createLruCache<string>(100);

          // Act & Assert
          expect(() => sut.set('a', 'val', -1)).toThrow('byteSize must be positive');
        });
      });
    });

    describe('Given cache(100) with entries totaling exactly 100', () => {
      describe('When checking', () => {
        it('Then no eviction occurs', () => {
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
      });
    });

    describe('Given cache with 3 entries', () => {
      describe('When deleting middle entry', () => {
        it('Then remaining entries accessible in correct order', () => {
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
      });
    });

    describe('Given cache(100) with A then B', () => {
      describe('When calling has(A) then adding C that evicts', () => {
        it('Then A is evicted (has does not promote)', () => {
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
    });
  });

  describe('property-based tests', () => {
    describe('Given any sequence of set operations', () => {
      describe('When checking currentSize', () => {
        it('Then never exceeds maxSize', () => {
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
      });
    });

    describe('Given set(k, v, s) then get(k)', () => {
      describe('When checking result', () => {
        it('Then equals v', () => {
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
      });
    });

    describe('Given any sequence of operations', () => {
      describe('When clear() is called', () => {
        it('Then entryCount === 0 and currentSize === 0', () => {
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
  });

  describe('entry-cap boundary (isolated from byte cap)', () => {
    describe('Given createLruCache(huge, 10) and 9 entries set', () => {
      describe('When entryCount is read', () => {
        it('Then equals 9 (just-under)', () => {
          // Arrange
          const sut = createLruCache<number>(Number.MAX_SAFE_INTEGER, 10);

          // Act
          for (let i = 0; i < 9; i += 1) sut.set(`k${i}`, i, 10);

          // Assert
          expect(sut.entryCount).toBe(9);
        });
      });
    });

    describe('Given createLruCache(huge, 10) and exactly 10 entries set', () => {
      describe('When entryCount is read', () => {
        it('Then equals 10 and oldest still present (at)', () => {
          // Arrange
          const sut = createLruCache<number>(Number.MAX_SAFE_INTEGER, 10);

          // Act
          for (let i = 0; i < 10; i += 1) sut.set(`k${i}`, i, 10);

          // Assert
          expect(sut.entryCount).toBe(10);
          expect(sut.has('k0')).toBe(true);
        });
      });
    });

    describe('Given createLruCache(huge, 10) and 11 entries set', () => {
      describe('When entryCount is read', () => {
        it('Then equals 10 and oldest key is evicted (just-over)', () => {
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
    });
  });

  describe('backward-compat single-arg', () => {
    describe('Given createLruCache(1024) legacy single-arg call', () => {
      describe('When 1000 tiny entries set within budget', () => {
        it('Then all 1000 are present', () => {
          // Arrange
          const sut = createLruCache<number>(1024);

          // Act
          for (let i = 0; i < 1000; i += 1) sut.set(`k${i}`, i, 1);

          // Assert
          expect(sut.entryCount).toBe(1000);
        });
      });
    });
  });

  describe('combined caps first-hit', () => {
    describe('Given createLruCache(100, 10) and 11 tiny entries', () => {
      describe('When filled', () => {
        it('Then entry cap fires first (entryCount capped at 10)', () => {
          // Arrange
          const sut = createLruCache<number>(100, 10);

          // Act
          for (let i = 0; i < 11; i += 1) sut.set(`k${i}`, i, 5);

          // Assert
          expect(sut.entryCount).toBe(10);
          expect(sut.currentSize).toBeLessThanOrEqual(100);
        });
      });
    });

    describe('Given createLruCache(100, 10) and 2 × 100-byte entries', () => {
      describe('When the second is set', () => {
        it('Then byte cap fires first (oldest evicted)', () => {
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
  });
});
