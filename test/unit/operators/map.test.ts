import { expectTypeOf } from 'expect-type';
import { describe, expect, it } from 'vitest';
import { map } from '../../../src/operators/map.js';
import { toArray } from '../../../src/operators/to-array.js';
import { abortableRange, awaitable, fromArray, pullCounter, trackedRange } from './fixtures.js';

describe('map', () => {
  it('Given a source [1,2,3] and mapper x => x * 2, When sut is iterated, Then [2,4,6] is yielded', async () => {
    // Arrange
    const sut = map((n: number) => n * 2);

    // Act
    const result = await toArray(sut(fromArray([1, 2, 3])));

    // Assert
    expect(result).toEqual([2, 4, 6]);
  });

  it('Given a source of length N, When sut is iterated, Then the output length equals N', async () => {
    // Arrange
    const sut = map((n: number) => n);

    // Act
    const result = await toArray(sut(fromArray([10, 20, 30, 40, 50])));

    // Assert
    expect(result).toHaveLength(5);
  });

  it('Given map(x => x) (identity), When invoked, Then toArray(sut(source)) deep-equals toArray(source)', async () => {
    // Arrange
    const input = [7, 8, 9];
    const sut = map((n: number) => n);

    // Act
    const mapped = await toArray(sut(fromArray(input)));
    const passthrough = await toArray(fromArray(input));

    // Assert
    expect(mapped).toEqual(passthrough);
  });

  it('Given an async mapper returning Promise<U>, When sut yields, Then the resolved U is yielded', async () => {
    // Arrange
    const sut = map(async (n: number) => `v=${n}`);

    // Act
    const result = await toArray(sut(fromArray([1, 2])));

    // Assert
    expect(result).toEqual(['v=1', 'v=2']);
  });

  it('Given a mapper wrapped via awaitable<U>(fn), When sut is iterated, Then items are transformed correctly', async () => {
    // Arrange
    const sut = map((n: number) => awaitable(() => n + 1));

    // Act
    const result = await toArray(sut(fromArray([1, 2, 3])));

    // Assert
    expect(result).toEqual([2, 3, 4]);
  });

  it('Given a mapper that throws on item k, When sut is iterated past k-1, Then error bubbles and trackedRange.returnCalled() is true', async () => {
    // Arrange — sentinel identity check, not regex, to resist wrap-and-rethrow mutants
    const boom = new Error('mapper-boom');
    const source = trackedRange(10);
    const sut = map((n: number) => {
      if (n === 2) throw boom;
      return n;
    });

    // Act / Assert
    await expect(toArray(sut(source.source))).rejects.toBe(boom);
    expect(source.returnCalled()).toBe(true);
  });

  it('Given a mapper returning Promise<U> whose resolution ticks a counter, When sut yields 3 items, Then counter reads 3 at completion', async () => {
    // Arrange
    let ticks = 0;
    const sut = map(async (n: number) => {
      ticks += 1;
      return n + 1;
    });

    // Act
    await toArray(sut(fromArray([1, 2, 3])));

    // Assert
    expect(ticks).toBe(3);
  });

  it('Given a pullCounter source, When sut is constructed but not iterated, Then pullCount() is 0 (laziness)', () => {
    // Arrange
    const source = pullCounter();

    // Act — just wire, do not iterate
    const _sut = map((n: number) => n + 1)(source.source);
    void _sut;

    // Assert
    expect(source.pullCount()).toBe(0);
  });

  it('Given a pullCounter source, When consumer pulls 5 items, Then pullCount() is 5', async () => {
    // Arrange
    const source = pullCounter();
    const sut = map((n: number) => n + 1);

    // Act
    const iter = sut(source.source);
    let taken = 0;
    for await (const _ of iter) {
      taken += 1;
      if (taken >= 5) break;
    }

    // Assert
    expect(source.pullCount()).toBe(5);
  });

  it('Given a trackedRange(100) and a consumer that throws after 3 pulls, When the throw exits for-await, Then trackedRange.returnCalled() is true', async () => {
    // Arrange
    const source = trackedRange(100);
    const sut = map((n: number) => n);

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

  it('Given an abortableRange(5, 100), When sut is iterated to completion, Then exactly 5 transformed items are yielded and no error is thrown', async () => {
    // Arrange
    const source = abortableRange(5, 100);
    const sut = map((n: number) => n + 10);

    // Act
    const result = await toArray(sut(source));

    // Assert
    expect(result).toEqual([10, 11, 12, 13, 14]);
  });

  it('Given a type-level scenario "map((n: number) => n.toString()) returns a function AsyncIterable<number> -> AsyncIterable<string>", When type-checked, Then types align', () => {
    // Arrange
    const sut = map((n: number) => n.toString());

    // Assert (type-level)
    expectTypeOf(sut).parameter(0).toEqualTypeOf<AsyncIterable<number>>();
    expectTypeOf(sut).returns.toEqualTypeOf<AsyncIterable<string>>();
  });
});
