import { describe, expect, it } from 'vitest';
import { toArray } from '../../../src/operators/to-array.js';
import { throwingAt } from './fixtures.js';

async function* range(n: number): AsyncIterable<number> {
  for (let i = 0; i < n; i += 1) {
    yield i;
  }
}

async function* empty(): AsyncIterable<never> {}

describe('toArray', () => {
  it('Given an empty source, When sut is awaited, Then [] is returned', async () => {
    // Arrange
    const source = empty();

    // Act
    const sut = await toArray(source);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a source yielding [0,1,2], When sut is awaited, Then [0,1,2] is returned', async () => {
    // Arrange — build expectation manually via for-await (floor test)
    const source = range(3);
    const expected: number[] = [];
    for await (const v of range(3)) {
      expected.push(v);
    }

    // Act
    const sut = await toArray(source);

    // Assert
    expect(sut).toEqual(expected);
  });

  it('Given a source that throws mid-iteration, When sut is awaited, Then the promise rejects and no partial array is observable', async () => {
    // Arrange
    const source = throwingAt(3, 10);

    // Act / Assert
    await expect(toArray(source)).rejects.toThrow(/threw at item 3/);
  });

  it('Given a source of 5 items and limit = 3, When sut is awaited, Then RangeError matches /exceeded limit of 3/', async () => {
    // Arrange
    const source = range(5);

    // Act / Assert
    try {
      await toArray(source, 3);
      // Assert
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
      expect((error as Error).message).toMatch(/exceeded limit of 3/);
    }
  });

  it('Given a source of 3 items and limit = 3 (>= boundary), When sut is awaited, Then [0,1,2] is returned', async () => {
    // Arrange
    const source = range(3);

    // Act
    const sut = await toArray(source, 3);

    // Assert
    expect(sut).toEqual([0, 1, 2]);
  });

  it('Given a source of 3 items and limit = 4, When sut is awaited, Then [0,1,2] is returned (no error)', async () => {
    // Arrange
    const source = range(3);

    // Act
    const sut = await toArray(source, 4);

    // Assert
    expect(sut).toEqual([0, 1, 2]);
  });

  it('Given an empty source and limit = 0, When sut is awaited, Then [] is returned', async () => {
    // Arrange
    const source = empty();

    // Act
    const sut = await toArray(source, 0);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a one-item source and limit = 0, When sut is awaited, Then RangeError /exceeded limit of 0/', async () => {
    // Arrange
    const source = range(1);

    // Act / Assert
    try {
      await toArray(source, 0);
      // Assert
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
      expect((error as Error).message).toMatch(/exceeded limit of 0/);
    }
  });

  it('Given limit = -1, When sut is awaited, Then RangeError /non-negative/', async () => {
    // Arrange
    const source = empty();

    // Act / Assert
    try {
      await toArray(source, -1);
      // Assert
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
      expect((error as Error).message).toMatch(/non-negative/);
    }
  });

  it('Given limit = NaN, When sut is awaited, Then RangeError /non-negative/', async () => {
    // Arrange
    const source = empty();

    // Act / Assert
    try {
      await toArray(source, Number.NaN);
      // Assert
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
      expect((error as Error).message).toMatch(/non-negative/);
    }
  });
});
