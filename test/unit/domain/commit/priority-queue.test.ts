import { describe, expect, it } from 'vitest';
import { precedes } from '../../../../src/domain/commit/priority-queue.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';

const oid = (char: string): ObjectId => char.repeat(40) as ObjectId;

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
