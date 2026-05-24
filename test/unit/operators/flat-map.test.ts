import { describe, expect, it } from 'vitest';
import { flatMap } from '../../../src/operators/flat-map.js';
import { toArray } from '../../../src/operators/to-array.js';
import { abortableRange, fromArray, throwingAt, trackedRange } from './fixtures.js';

describe('flatMap', () => {
  it('Given a mapper returning Iterable<U> (array), When iterated, Then values are flattened in order', async () => {
    // Arrange
    const sut = flatMap((n: number) => [n, n + 10]);

    // Act
    const result = await toArray(sut(fromArray([1, 2, 3])));

    // Assert
    expect(result).toEqual([1, 11, 2, 12, 3, 13]);
  });

  it('Given a mapper returning AsyncIterable<U>, When iterated, Then values are flattened in order', async () => {
    // Arrange
    const sut = flatMap((n: number) => fromArray([n, n + 100]));

    // Act
    const result = await toArray(sut(fromArray([1, 2])));

    // Assert
    expect(result).toEqual([1, 101, 2, 102]);
  });

  it('Given a mapper returning Promise<Iterable<U>>, When iterated, Then resolves before inner iteration begins', async () => {
    // Arrange
    const sut = flatMap(async (n: number) => [n, n * 2]);

    // Act
    const result = await toArray(sut(fromArray([1, 2])));

    // Assert
    expect(result).toEqual([1, 2, 2, 4]);
  });

  it('Given a mapper returning Promise<AsyncIterable<U>>, When iterated, Then same flattening', async () => {
    // Arrange
    const sut = flatMap(async (n: number) => fromArray([n, n + 1]));

    // Act
    const result = await toArray(sut(fromArray([10, 20])));

    // Assert
    expect(result).toEqual([10, 11, 20, 21]);
  });

  it('Given a mapper returning empty iterable for a source item, When iterated, Then that item contributes 0 outputs', async () => {
    // Arrange
    const sut = flatMap((n: number) => (n % 2 === 0 ? [n] : []));

    // Act
    const result = await toArray(sut(fromArray([1, 2, 3, 4])));

    // Assert
    expect(result).toEqual([2, 4]);
  });

  it('Given a two-item source [A, B], When iterated, Then all A inner items appear before any B inner items', async () => {
    // Arrange
    const sut = flatMap((n: number) => [`${n}a`, `${n}b`, `${n}c`]);

    // Act
    const result = await toArray(sut(fromArray([1, 2])));

    // Assert
    expect(result).toEqual(['1a', '1b', '1c', '2a', '2b', '2c']);
  });

  it('Given a mapper returning Promise<[x]> whose resolution ticks a counter, When one outer item yields, Then counter is 1', async () => {
    // Arrange
    let ticks = 0;
    const sut = flatMap(async (n: number) => {
      ticks += 1;
      return [n];
    });

    // Act
    await toArray(sut(fromArray([42])));

    // Assert
    expect(ticks).toBe(1);
  });

  it('Given a mapper whose inner iterable throws mid-yield, When the outer reaches that inner, Then outer throws AND source returnCalled() is true', async () => {
    // Arrange
    const source = trackedRange(10);
    const sut = flatMap((n: number) => {
      if (n === 2) {
        return throwingAt(0, 5);
      }
      return [n];
    });

    // Act / Assert
    // Assert
    await expect(toArray(sut(source.source))).rejects.toThrow(/threw at item 0/);
    expect(source.returnCalled()).toBe(true);
  });

  it('Given an outer throwingAt(2, 10), When outer throws, Then flatMap generator throws', async () => {
    // Arrange
    const sut = flatMap((n: number) => [n]);

    // Act / Assert
    // Assert
    await expect(toArray(sut(throwingAt(2, 10)))).rejects.toThrow(/threw at item 2/);
  });

  it('Given one-item outer and flatMap(() => innerTrackedRange(100)), When manual for-await breaks after first inner yield, Then inner returnCalled() is true', async () => {
    // Arrange
    const inner = trackedRange(100);
    const sut = flatMap(() => inner.source);

    // Act — manual consumer, break after 1
    const seen: number[] = [];
    for await (const v of sut(fromArray([0]))) {
      seen.push(v);
      if (seen.length >= 1) break;
    }

    // Assert
    expect(seen).toEqual([0]);
    expect(inner.returnCalled()).toBe(true);
  });

  it('Given multi-item outer trackedRange and flatMap to a fresh inner per outer, When consumer breaks mid-first-inner, Then both outer and inner returnCalled() are true', async () => {
    // Arrange — outer must be aborted too, not only inner.
    const outer = trackedRange(10);
    const firstInner = trackedRange(100);
    let innerCallCount = 0;
    const sut = flatMap(() => {
      innerCallCount += 1;
      return firstInner.source;
    });

    // Act — break mid first inner, second outer item never pulled
    const seen: number[] = [];
    for await (const v of sut(outer.source)) {
      seen.push(v);
      if (seen.length >= 1) break;
    }

    // Assert — inner cleaned up, outer cleaned up, mapper only called once
    expect(seen).toEqual([0]);
    expect(firstInner.returnCalled()).toBe(true);
    expect(outer.returnCalled()).toBe(true);
    expect(innerCallCount).toBe(1);
  });

  it('Given a trackedRange(100) outer and a consumer that throws on first yield, When the throw exits, Then outer returnCalled() is true', async () => {
    // Arrange
    const source = trackedRange(100);
    const sut = flatMap((n: number) => [n]);

    // Act
    try {
      for await (const _ of sut(source.source)) {
        throw new Error('consumer-throw');
      }
    } catch {
      // swallow
    }

    // Assert
    expect(source.returnCalled()).toBe(true);
  });

  it('Given an abortableRange(3, 100) outer and mapper returning [value], When iterated to completion, Then exactly 3 items yielded', async () => {
    // Arrange
    const source = abortableRange(3, 100);
    const sut = flatMap((n: number) => [n]);

    // Act
    const result = await toArray(sut(source));

    // Assert
    expect(result).toEqual([0, 1, 2]);
  });
});
