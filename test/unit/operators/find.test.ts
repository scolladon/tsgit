import { describe, expect, it, vi } from 'vitest';
import { find } from '../../../src/operators/find.js';
import { awaitable, fromArray, pullCounter, throwingPredicate, trackedRange } from './fixtures.js';

describe('find', () => {
  describe('Given a source [1,2,3] and predicate x === 2', () => {
    describe('When awaited', () => {
      it('Then 2 is returned', async () => {
        // Arrange
        const sut = find((n: number) => n === 2);

        // Act
        const result = await sut(fromArray([1, 2, 3]));

        // Assert
        expect(result).toBe(2);
      });
    });
  });

  describe('Given a predicate that never matches', () => {
    describe('When awaited', () => {
      it('Then undefined is returned', async () => {
        // Arrange
        const sut = find(() => false);

        // Act
        const result = await sut(fromArray([1, 2, 3]));

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given an empty source', () => {
    describe('When awaited', () => {
      it('Then undefined is returned', async () => {
        // Arrange
        const sut = find(() => true);

        // Act
        const result = await sut(fromArray<number>([]));

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given match precedes non-matching items', () => {
    describe('When awaited', () => {
      it('Then match returned and predicate short-circuits at exactly 2 calls', async () => {
        // Arrange
        const spy = vi.fn((n: number) => n === 2);
        const sut = find(spy);

        // Act
        const result = await sut(fromArray([1, 2, 5]));

        // Assert
        expect(result).toBe(2);
        expect(spy).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Given a match at index 0 and a throwingPredicate that would throw at index 1', () => {
    describe('When awaited', () => {
      it('Then match returned and throw never fires', async () => {
        // Arrange — proves the short-circuit happens BEFORE the would-be-throw
        const throwAt = 99; // never reached in [10]
        const spy = vi.fn((n: number) => {
          if (n === throwAt) throw new Error('should never fire');
          return n === 10;
        });
        const sut = find(spy);

        // Act
        const result = await sut(fromArray([10, throwAt, throwAt]));

        // Assert
        expect(result).toBe(10);
        expect(spy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Given a throwingPredicate that fires before any match', () => {
    describe('When awaited', () => {
      it('Then error propagates and no value is returned', async () => {
        // Arrange
        const boom = new Error('pred-boom');
        const sut = find(throwingPredicate<number>((n) => n === 2, boom));

        // Act / Assert
        await expect(sut(fromArray([1, 2, 3]))).rejects.toBe(boom);
      });
    });
  });

  describe('Given a predicate wrapped via awaitable<boolean>(fn)', () => {
    describe('When awaited', () => {
      it('Then resolved boolean determines inclusion', async () => {
        // Arrange
        const sut = find((n: number) => awaitable(() => n >= 2));

        // Act
        const result = await sut(fromArray([1, 2, 3]));

        // Assert
        expect(result).toBe(2);
      });
    });
  });

  describe('Given a match at index 2 of trackedRange(100)', () => {
    describe('When awaited', () => {
      it('Then returnCalled() is true', async () => {
        // Arrange
        const source = trackedRange(100);
        const sut = find((n: number) => n === 2);

        // Act
        const result = await sut(source.source);

        // Assert
        expect(result).toBe(2);
        expect(source.returnCalled()).toBe(true);
      });
    });
  });

  describe('Given a match at index 2 of pullCounter', () => {
    describe('When awaited', () => {
      it('Then pullCount() === 3 (index-of-match + 1 source pulls)', async () => {
        // Arrange
        const source = pullCounter();
        const sut = find((n: number) => n === 2);

        // Act
        await sut(source.source);

        // Assert
        expect(source.pullCount()).toBe(3);
      });
    });
  });
});
