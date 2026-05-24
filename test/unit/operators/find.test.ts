import { describe, expect, it, vi } from 'vitest';
import { find } from '../../../src/operators/find.js';
import { awaitable, fromArray, pullCounter, throwingPredicate, trackedRange } from './fixtures.js';

describe('find', () => {
  it('Given a source [1,2,3] and predicate x === 2, When awaited, Then 2 is returned', async () => {
    // Arrange
    const sut = find((n: number) => n === 2);

    // Act
    const result = await sut(fromArray([1, 2, 3]));

    // Assert
    expect(result).toBe(2);
  });

  it('Given a predicate that never matches, When awaited, Then undefined is returned', async () => {
    // Arrange
    const sut = find(() => false);

    // Act
    const result = await sut(fromArray([1, 2, 3]));

    // Assert
    expect(result).toBeUndefined();
  });

  it('Given an empty source, When awaited, Then undefined is returned', async () => {
    // Arrange
    const sut = find(() => true);

    // Act
    const result = await sut(fromArray<number>([]));

    // Assert
    expect(result).toBeUndefined();
  });

  it('Given match precedes non-matching items, When awaited, Then match returned and predicate short-circuits at exactly 2 calls', async () => {
    // Arrange
    const spy = vi.fn((n: number) => n === 2);
    const sut = find(spy);

    // Act
    const result = await sut(fromArray([1, 2, 5]));

    // Assert
    expect(result).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('Given a match at index 0 and a throwingPredicate that would throw at index 1, When awaited, Then match returned and throw never fires', async () => {
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

  it('Given a throwingPredicate that fires before any match, When awaited, Then error propagates and no value is returned', async () => {
    // Arrange
    const boom = new Error('pred-boom');
    const sut = find(throwingPredicate<number>((n) => n === 2, boom));

    // Act / Assert
    // Assert
    await expect(sut(fromArray([1, 2, 3]))).rejects.toBe(boom);
  });

  it('Given a predicate wrapped via awaitable<boolean>(fn), When awaited, Then resolved boolean determines inclusion', async () => {
    // Arrange
    const sut = find((n: number) => awaitable(() => n >= 2));

    // Act
    const result = await sut(fromArray([1, 2, 3]));

    // Assert
    expect(result).toBe(2);
  });

  it('Given a match at index 2 of trackedRange(100), When awaited, Then returnCalled() is true', async () => {
    // Arrange
    const source = trackedRange(100);
    const sut = find((n: number) => n === 2);

    // Act
    const result = await sut(source.source);

    // Assert
    expect(result).toBe(2);
    expect(source.returnCalled()).toBe(true);
  });

  it('Given a match at index 2 of pullCounter, When awaited, Then pullCount() === 3 (index-of-match + 1 source pulls)', async () => {
    // Arrange
    const source = pullCounter();
    const sut = find((n: number) => n === 2);

    // Act
    await sut(source.source);

    // Assert
    expect(source.pullCount()).toBe(3);
  });
});
