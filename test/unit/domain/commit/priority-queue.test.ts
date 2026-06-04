import { describe, expect, it } from 'vitest';
import {
  enqueue,
  precedes,
  type QueueEntry,
} from '../../../../src/domain/commit/priority-queue.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';

const oid = (char: string): ObjectId => char.repeat(40) as ObjectId;

const item = (date: number, char: string): QueueEntry<string> => ({
  oid: oid(char),
  date,
  value: char,
});

const drain = (queue: QueueEntry<string>[]): ReadonlyArray<string> => queue.map((e) => e.value);

describe('Given two entries with different commit dates, When ordering them', () => {
  it('Then the newer date precedes the older', () => {
    // Arrange
    const sut = precedes;

    // Act + Assert
    expect(sut({ date: 30, oid: oid('a') }, { date: 10, oid: oid('a') })).toBe(true);
    expect(sut({ date: 10, oid: oid('a') }, { date: 30, oid: oid('a') })).toBe(false);
    // Older entry with the smaller oid must still not precede the newer: the date
    // comparison dominates the oid tie-break (the tie-break only applies on equal dates).
    expect(sut({ date: 10, oid: oid('a') }, { date: 30, oid: oid('b') })).toBe(false);
  });
});

describe('Given two entries with equal commit dates, When ordering them', () => {
  it('Then the smaller oid precedes the larger', () => {
    // Arrange
    const sut = precedes;

    // Act + Assert
    expect(sut({ date: 5, oid: oid('a') }, { date: 5, oid: oid('b') })).toBe(true);
    expect(sut({ date: 5, oid: oid('b') }, { date: 5, oid: oid('a') })).toBe(false);
  });
});

describe('Given two fully equal entries, When ordering them', () => {
  it('Then neither precedes the other', () => {
    // Arrange
    const sut = precedes;

    // Act
    const result = sut({ date: 5, oid: oid('a') }, { date: 5, oid: oid('a') });

    // Assert
    expect(result).toBe(false);
  });
});

describe('Given entries inserted out of date order, When enqueuing each', () => {
  it('Then the queue holds them newest-date-first', () => {
    // Arrange
    const sut = enqueue;
    const queue: QueueEntry<string>[] = [];

    // Act
    sut(queue, item(10, 'a'));
    sut(queue, item(30, 'b'));
    sut(queue, item(20, 'c'));

    // Assert
    expect(drain(queue)).toEqual(['b', 'c', 'a']);
  });
});

describe('Given equal-date entries inserted largest-oid-first, When enqueuing', () => {
  it('Then ties break by ascending oid', () => {
    // Arrange
    const sut = enqueue;
    const queue: QueueEntry<string>[] = [];

    // Act
    sut(queue, item(5, 'c'));
    sut(queue, item(5, 'a'));
    sut(queue, item(5, 'b'));

    // Assert
    expect(drain(queue)).toEqual(['a', 'b', 'c']);
  });
});

describe('Given a sorted queue, When enqueuing an entry that belongs in the middle', () => {
  it('Then it lands at the correct position', () => {
    // Arrange
    const sut = enqueue;
    const queue: QueueEntry<string>[] = [item(30, 'a'), item(10, 'c')];

    // Act
    sut(queue, item(20, 'b'));

    // Assert
    expect(drain(queue)).toEqual(['a', 'b', 'c']);
  });
});

describe('Given an empty queue, When enqueuing one entry', () => {
  it('Then it holds the single entry', () => {
    // Arrange
    const sut = enqueue;
    const queue: QueueEntry<string>[] = [];

    // Act
    sut(queue, item(7, 'a'));

    // Assert
    expect(drain(queue)).toEqual(['a']);
  });
});
