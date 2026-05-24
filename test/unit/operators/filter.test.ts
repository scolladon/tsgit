import { describe, expect, it, vi } from 'vitest';
import { filter } from '../../../src/operators/filter.js';
import { toArray } from '../../../src/operators/to-array.js';
import {
  abortableRange,
  awaitable,
  fromArray,
  pullCounter,
  throwingPredicate,
  trackedRange,
} from './fixtures.js';

describe('filter', () => {
  it('Given a source [1,2,3,4] and predicate x % 2 === 0, When sut is iterated, Then [2,4] is yielded in order', async () => {
    // Arrange
    const sut = filter((n: number) => n % 2 === 0);

    // Act
    const result = await toArray(sut(fromArray([1, 2, 3, 4])));

    // Assert
    expect(result).toEqual([2, 4]);
  });

  it('Given a predicate returning true for all items, When invoked, Then toArray(sut(source)) deep-equals toArray(source)', async () => {
    // Arrange
    const input = [1, 2, 3];
    const sut = filter(() => true);

    // Act
    const filtered = await toArray(sut(fromArray(input)));
    const passthrough = await toArray(fromArray(input));

    // Assert
    expect(filtered).toEqual(passthrough);
  });

  it('Given a predicate returning false for all items, When invoked, Then toArray output is []', async () => {
    // Arrange
    const sut = filter(() => false);

    // Act
    const result = await toArray(sut(fromArray([1, 2, 3])));

    // Assert
    expect(result).toEqual([]);
  });

  it('Given an async predicate returning Promise<true>, When sut yields, Then item is included', async () => {
    // Arrange
    const sut = filter(async (n: number) => n > 0);

    // Act
    const result = await toArray(sut(fromArray([-1, 1, -2, 2])));

    // Assert
    expect(result).toEqual([1, 2]);
  });

  it('Given a predicate wrapped via awaitable<boolean>(fn), When sut is iterated, Then items pass through correctly', async () => {
    // Arrange
    const sut = filter((n: number) => awaitable(() => n > 1));

    // Act
    const result = await toArray(sut(fromArray([0, 1, 2, 3])));

    // Assert
    expect(result).toEqual([2, 3]);
  });

  it('Given a throwingPredicate that throws on item k, When sut is iterated past k-1, Then error bubbles AND source returnCalled() is true', async () => {
    // Arrange
    const source = trackedRange(10);
    const boom = new Error('pred-boom');
    const sut = filter(throwingPredicate<number>((n) => n === 2, boom));

    // Act / Assert
    // Assert
    await expect(toArray(sut(source.source))).rejects.toBe(boom);
    expect(source.returnCalled()).toBe(true);
  });

  it('Given a predicate-spy and consumer breaking at item 5 of 100, When sut is iterated, Then predicate is called exactly 5 times', async () => {
    // Arrange
    const spy = vi.fn((_n: number) => true);
    const sut = filter(spy);

    // Act
    let taken = 0;
    for await (const _ of sut(trackedRange(100).source)) {
      taken += 1;
      if (taken >= 5) break;
    }

    // Assert
    expect(spy).toHaveBeenCalledTimes(5);
  });

  it('Given a pullCounter source and filter(() => true), When consumer pulls 5 items, Then pullCount() is 5', async () => {
    // Arrange
    const source = pullCounter();
    const sut = filter(() => true);

    // Act
    let taken = 0;
    for await (const _ of sut(source.source)) {
      taken += 1;
      if (taken >= 5) break;
    }

    // Assert
    expect(source.pullCount()).toBe(5);
  });

  it('Given a predicate () => true on source [1], When sut is iterated, Then [1] is yielded', async () => {
    // Arrange
    const sut = filter(() => true);

    // Act
    const result = await toArray(sut(fromArray([1])));

    // Assert
    expect(result).toEqual([1]);
  });

  it('Given the same source [1] but predicate () => false, When sut is iterated, Then [] is yielded', async () => {
    // Arrange
    const sut = filter(() => false);

    // Act
    const result = await toArray(sut(fromArray([1])));

    // Assert
    expect(result).toEqual([]);
  });

  it('Given a predicate returning Promise<boolean> resolving on next microtask, When sut is iterated, Then items arrive in source order', async () => {
    // Arrange
    const sut = filter(async (n: number) => n > 0);

    // Act
    const result = await toArray(sut(fromArray([1, 2, 3, 4, 5])));

    // Assert
    expect(result).toEqual([1, 2, 3, 4, 5]);
  });

  it('Given a trackedRange(100) and a consumer that throws after 3 items, When the throw exits for-await, Then trackedRange.returnCalled() is true', async () => {
    // Arrange
    const source = trackedRange(100);
    const sut = filter(() => true);

    // Act
    let count = 0;
    try {
      for await (const _ of sut(source.source)) {
        count += 1;
        if (count >= 3) throw new Error('consumer-throw');
      }
    } catch {
      // swallow
    }

    // Assert
    expect(source.returnCalled()).toBe(true);
  });

  it('Given an abortableRange(5, 100) and filter(() => true), When sut is iterated to completion, Then exactly [0,1,2,3,4] is yielded', async () => {
    // Arrange
    const source = abortableRange(5, 100);
    const sut = filter(() => true);

    // Act
    const result = await toArray(sut(source));

    // Assert
    expect(result).toEqual([0, 1, 2, 3, 4]);
  });
});
