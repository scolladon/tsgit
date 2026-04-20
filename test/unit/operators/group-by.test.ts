import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { groupBy } from '../../../src/operators/group-by.js';
import { fromArray, throwingPredicate, trackedRange } from './fixtures.js';

describe('groupBy', () => {
  it('Given an empty source, When awaited, Then an empty Map is returned', async () => {
    // Arrange
    const sut = groupBy((n: number) => n);

    // Act
    const result = await sut(fromArray<number>([]));

    // Assert
    expect(result.size).toBe(0);
  });

  it('Given a source [1] keyed by identity, When awaited, Then result has one entry { 1 → [1] }', async () => {
    // Arrange
    const sut = groupBy((n: number) => n);

    // Act
    const result = await sut(fromArray([1]));

    // Assert
    expect(result.size).toBe(1);
    expect(result.get(1)).toEqual([1]);
  });

  it('Given a source [1, 1] keyed by identity, When awaited, Then result has one entry { 1 → [1, 1] }', async () => {
    // Arrange
    const sut = groupBy((n: number) => n);

    // Act
    const result = await sut(fromArray([1, 1]));

    // Assert
    expect(result.size).toBe(1);
    expect(result.get(1)).toEqual([1, 1]);
  });

  it('Given a source [1,2,3] keyed by identity, When awaited, Then three entries of size 1 each', async () => {
    // Arrange
    const sut = groupBy((n: number) => n);

    // Act
    const result = await sut(fromArray([1, 2, 3]));

    // Assert
    expect(result.size).toBe(3);
    expect(result.get(1)).toEqual([1]);
    expect(result.get(2)).toEqual([2]);
    expect(result.get(3)).toEqual([3]);
  });

  it('Given a source [a,b,a,b,a] keyed by identity, When awaited, Then two entries a → [a,a,a], b → [b,b] in first-occurrence order', async () => {
    // Arrange
    const sut = groupBy((v: string) => v);

    // Act
    const result = await sut(fromArray(['a', 'b', 'a', 'b', 'a']));

    // Assert
    expect([...result.keys()]).toEqual(['a', 'b']);
    expect(result.get('a')).toEqual(['a', 'a', 'a']);
    expect(result.get('b')).toEqual(['b', 'b']);
  });

  it('Given a source [x, y] keyed to someConst, When awaited, Then [...result.keys()] equals [someConst]', async () => {
    // Arrange
    const someConst = 'K';
    const sut = groupBy(() => someConst);

    // Act
    const result = await sut(fromArray(['x', 'y']));

    // Assert
    expect([...result.keys()]).toEqual([someConst]);
  });

  it('Given a source [NaN, NaN] keyed by identity, When awaited, Then result.get(NaN) has length 2 (SameValueZero)', async () => {
    // Arrange
    const sut = groupBy((n: number) => n);

    // Act
    const result = await sut(fromArray([Number.NaN, Number.NaN]));

    // Assert
    expect(result.get(Number.NaN)?.length).toBe(2);
  });

  it('Given two items keyed to distinct fresh {} literals, When awaited, Then two entries of size 1 each', async () => {
    // Arrange
    const items = [1, 2];
    const sut = groupBy(() => ({}));

    // Act
    const result = await sut(fromArray(items));

    // Assert
    expect(result.size).toBe(2);
    for (const values of result.values()) {
      expect(values).toHaveLength(1);
    }
  });

  it('Given two items keyed to the same frozen object, When awaited, Then one entry of size 2', async () => {
    // Arrange
    const key = Object.freeze({ id: 1 });
    const sut = groupBy(() => key);

    // Act
    const result = await sut(fromArray([1, 2]));

    // Assert
    expect(result.size).toBe(1);
    expect(result.get(key)).toHaveLength(2);
  });

  it('Given a throwingPredicate as keyFn that throws on item k, When awaited, Then promise rejects AND source returnCalled() is true', async () => {
    // Arrange
    const source = trackedRange(10);
    const boom = new Error('key-boom');
    const keyFn = throwingPredicate<number>((n) => n === 2, boom);
    const sut = groupBy(keyFn);

    // Act / Assert
    await expect(sut(source.source)).rejects.toBe(boom);
    expect(source.returnCalled()).toBe(true);
  });

  it('Given a source of 5 items and limit = 3, When awaited, Then RangeError /exceeded limit of 3/', async () => {
    // Arrange
    const sut = groupBy((n: number) => n, 3);

    // Act / Assert
    try {
      await sut(fromArray([1, 2, 3, 4, 5]));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
      expect((error as Error).message).toMatch(/exceeded limit of 3/);
    }
  });

  it('Given groupBy(k, -1), When factory invoked, Then RangeError synchronously at construction time', () => {
    // Act / Assert
    try {
      groupBy((n: number) => n, -1);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
      expect((error as Error).message).toMatch(/non-negative/);
    }
  });

  it('Given groupBy(k, 0) at factory time, When called, Then it does not throw (0 is a valid limit)', () => {
    // Act
    const sut = groupBy((n: number) => n, 0);

    // Assert — factory is constructable; 0 is a valid limit value
    expect(typeof sut).toBe('function');
  });

  it('Given groupBy(k, 0) on a one-item source, When awaited, Then RangeError /exceeded limit of 0/', async () => {
    // Arrange
    const sut = groupBy((n: number) => n, 0);

    // Act / Assert
    try {
      await sut(fromArray([1]));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
      expect((error as Error).message).toMatch(/exceeded limit of 0/);
    }
  });

  it('Given groupBy(k, NaN), When factory invoked, Then RangeError', () => {
    // Act / Assert
    try {
      groupBy((n: number) => n, Number.NaN);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
      expect((error as Error).message).toMatch(/non-negative/);
    }
  });

  it('Property: Array.from(result.values()).flat() is a permutation of toArray(source) for any source and keyFn', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer(), { maxLength: 30 }), async (input) => {
        const sut = groupBy((n: number) => n % 3);
        const result = await sut(fromArray(input));
        const flattened = [...result.values()].flat();
        const sortedIn = [...input].sort((a, b) => a - b);
        const sortedOut = [...flattened].sort((a, b) => a - b);
        return flattened.length === input.length && sortedIn.every((v, i) => v === sortedOut[i]);
      }),
      { numRuns: 50 },
    );
  });
});
