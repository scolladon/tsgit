import { describe, expect, it } from 'vitest';
import { boundedMap } from '../../../../../src/application/primitives/internal/bounded-map.js';

describe('boundedMap', () => {
  describe('Given an empty array', () => {
    describe('When boundedMap is called', () => {
      it('Then resolves to an empty array without invoking worker', async () => {
        // Arrange
        const sut = boundedMap;
        let calls = 0;
        const worker = async (_item: number): Promise<number> => {
          calls += 1;
          return _item;
        };

        // Act
        const result = await sut([], 4, worker);

        // Assert
        expect(result).toEqual([]);
        expect(calls).toBe(0);
      });
    });
  });

  describe('Given [1,2,3,4] with limit=2', () => {
    describe('When boundedMap is called with a doubling worker', () => {
      it('Then resolves to exactly [2,4,6,8] in input order', async () => {
        // Arrange
        const sut = boundedMap;

        // Act
        const result = await sut([1, 2, 3, 4], 2, async (n) => n * 2);

        // Assert — exact length + values kills the <= EqualityOperator mutant
        expect(result).toEqual([2, 4, 6, 8]);
        expect(result).toHaveLength(4);
      });
    });
  });

  describe('Given [1,2,3,4,5] with limit=2', () => {
    describe('When boundedMap is called', () => {
      it('Then results are in input order regardless of completion order', async () => {
        // Arrange
        const sut = boundedMap;
        // Worker resolves in reverse: item 1 takes longest, item 5 fastest.
        const worker = async (n: number): Promise<number> => {
          await new Promise<void>((resolve) => setTimeout(resolve, (6 - n) * 2));
          return n * 10;
        };

        // Act
        const result = await sut([1, 2, 3, 4, 5], 2, worker);

        // Assert — ordering preserved despite staggered completion
        expect(result).toEqual([10, 20, 30, 40, 50]);
      });
    });
  });

  describe('Given an array of 10 items with limit=3', () => {
    describe('When boundedMap runs', () => {
      it('Then worker is invoked exactly once per item with the correct item', async () => {
        // Arrange
        const sut = boundedMap;
        const seen: number[] = [];
        const worker = async (item: number): Promise<number> => {
          seen.push(item);
          return item;
        };

        // Act
        await sut([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, worker);

        // Assert — every item processed, no dupes, no skips
        expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      });
    });
  });

  describe('Given limit greater than array size', () => {
    describe('When boundedMap runs', () => {
      it('Then concurrency caps at array length (no over-spawned workers)', async () => {
        // Arrange
        const sut = boundedMap;
        let inFlight = 0;
        let maxInFlight = 0;
        const worker = async (item: number): Promise<number> => {
          inFlight += 1;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          await Promise.resolve();
          inFlight -= 1;
          return item;
        };

        // Act
        await sut([1, 2, 3], 100, worker);

        // Assert — at most 3 workers (item count), not 100
        expect(maxInFlight).toBeLessThanOrEqual(3);
      });
    });
  });

  describe('Given limit smaller than array size', () => {
    describe('When boundedMap runs', () => {
      it('Then in-flight count never exceeds limit', async () => {
        // Arrange
        const sut = boundedMap;
        let inFlight = 0;
        let maxInFlight = 0;
        const items = Array.from({ length: 50 }, (_, i) => i);
        const worker = async (item: number): Promise<number> => {
          inFlight += 1;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          await Promise.resolve();
          inFlight -= 1;
          return item;
        };

        // Act
        await sut(items, 4, worker);

        // Assert — concurrency cap respected, genuine parallelism observed
        expect(maxInFlight).toBeLessThanOrEqual(4);
        expect(maxInFlight).toBeGreaterThan(1);
      });
    });
  });

  describe('Given worker rejects on one item', () => {
    describe('When boundedMap runs', () => {
      it('Then the rejection propagates', async () => {
        // Arrange
        const sut = boundedMap;
        const worker = async (item: number): Promise<number> => {
          if (item === 5) throw new Error('boom');
          return item;
        };

        // Act / Assert
        await expect(sut([1, 2, 3, 4, 5, 6], 2, worker)).rejects.toThrow('boom');
      });
    });
  });
});
