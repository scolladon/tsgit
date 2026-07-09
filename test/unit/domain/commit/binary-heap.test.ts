import { describe, expect, it } from 'vitest';
import { BinaryHeap } from '../../../../src/domain/commit/binary-heap.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';

const oid = (char: string): ObjectId => char.repeat(40) as ObjectId;

interface DatedEntry {
  readonly date: number;
  readonly oid: ObjectId;
  readonly value: string;
}

const entry = (date: number, char: string): DatedEntry => ({
  date,
  oid: oid(char),
  value: char,
});

/** Blame's comparator: newest date first, oid-ascending on equal dates. */
const dateOidLess = (a: DatedEntry, b: DatedEntry): boolean =>
  a.date > b.date || (a.date === b.date && a.oid < b.oid);

interface FifoEntry {
  readonly date: number;
  readonly ins: number;
  readonly value: string;
}

/** Bisect's comparator: newest date first, ascending insertion order on equal dates. */
const dateInsLess = (a: FifoEntry, b: FifoEntry): boolean =>
  a.date > b.date || (a.date === b.date && a.ins < b.ins);

const numericLess = (a: number, b: number): boolean => a < b;

const drain = <T>(heap: BinaryHeap<T>): T[] => {
  const drained: T[] = [];
  let next = heap.pop();
  while (next !== undefined) {
    drained.push(next);
    next = heap.pop();
  }
  return drained;
};

describe('Given an empty heap', () => {
  it('Then size is 0', () => {
    // Arrange
    const sut = new BinaryHeap<number>(numericLess);

    // Act + Assert
    expect(sut.size()).toBe(0);
  });

  it('Then pop is undefined', () => {
    // Arrange
    const sut = new BinaryHeap<number>(numericLess);

    // Act
    const result = sut.pop();

    // Assert
    expect(result).toBeUndefined();
  });

  it('Then entries is empty', () => {
    // Arrange
    const sut = new BinaryHeap<number>(numericLess);

    // Act + Assert
    expect(sut.entries()).toEqual([]);
  });
});

describe('Given a single pushed element, When popped', () => {
  it('Then the element round-trips', () => {
    // Arrange
    const sut = new BinaryHeap<number>(numericLess);

    // Act
    sut.push(42);
    const result = sut.pop();

    // Assert
    expect(result).toBe(42);
  });

  it('Then size tracks the push then the pop', () => {
    // Arrange
    const sut = new BinaryHeap<number>(numericLess);

    // Act + Assert
    sut.push(42);
    expect(sut.size()).toBe(1);
    sut.pop();
    expect(sut.size()).toBe(0);
  });
});

describe('Given elements pushed in ascending order, When drained', () => {
  it('Then they pop in comparator order', () => {
    // Arrange
    const sut = new BinaryHeap<number>(numericLess);

    // Act
    for (const value of [1, 2, 3, 4, 5]) sut.push(value);

    // Assert
    expect(drain(sut)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('Given elements pushed in descending order, When drained', () => {
  it('Then they pop in comparator order', () => {
    // Arrange
    const sut = new BinaryHeap<number>(numericLess);

    // Act
    for (const value of [5, 4, 3, 2, 1]) sut.push(value);

    // Assert
    expect(drain(sut)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('Given elements pushed in shuffled order, When drained', () => {
  it('Then they pop in comparator order', () => {
    // Arrange
    const sut = new BinaryHeap<number>(numericLess);

    // Act
    for (const value of [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5]) sut.push(value);

    // Assert
    expect(drain(sut)).toEqual([1, 1, 2, 3, 3, 4, 5, 5, 5, 6, 9]);
  });
});

describe('Given equal-date entries with an oid tie-break comparator, When drained', () => {
  it('Then ties break by ascending oid', () => {
    // Arrange
    const sut = new BinaryHeap<DatedEntry>(dateOidLess);

    // Act
    sut.push(entry(5, 'c'));
    sut.push(entry(5, 'a'));
    sut.push(entry(5, 'b'));

    // Assert
    expect(drain(sut).map((e) => e.value)).toEqual(['a', 'b', 'c']);
  });
});

describe('Given equal-date entries with a FIFO insertion tie-break comparator, When drained', () => {
  it('Then ties break by ascending insertion order', () => {
    // Arrange
    const sut = new BinaryHeap<FifoEntry>(dateInsLess);

    // Act
    sut.push({ date: 5, ins: 2, value: 'c' });
    sut.push({ date: 5, ins: 0, value: 'a' });
    sut.push({ date: 5, ins: 1, value: 'b' });

    // Assert
    expect(drain(sut).map((e) => e.value)).toEqual(['a', 'b', 'c']);
  });
});

describe('Given a heap with several live elements, When entries is read', () => {
  it('Then it returns every live element as a set', () => {
    // Arrange
    const sut = new BinaryHeap<number>(numericLess);

    // Act
    for (const value of [3, 1, 4, 1, 5]) sut.push(value);

    // Assert — entries() is deliberately unsorted: compare as a sorted set, not an ordered array.
    expect(
      sut
        .entries()
        .slice()
        .sort((a, b) => a - b),
    ).toEqual([1, 1, 3, 4, 5]);
  });

  it('Then it reflects a pop removing exactly one live element', () => {
    // Arrange
    const sut = new BinaryHeap<number>(numericLess);
    for (const value of [3, 1, 4]) sut.push(value);

    // Act
    sut.pop();

    // Assert
    expect(
      sut
        .entries()
        .slice()
        .sort((a, b) => a - b),
    ).toEqual([3, 4]);
  });
});
