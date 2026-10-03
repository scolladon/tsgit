import { describe, expect, it } from 'vitest';
import { precedes, precedesByArrival } from '../../../../src/domain/commit/priority-queue.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';

const oid = (char: string): ObjectId => char.repeat(40) as ObjectId;

describe('Given two entries with different commit dates, When ordering them', () => {
  it('Then the newer date precedes the older', () => {
    // Arrange & Act + Assert
    expect(precedes({ date: 30, oid: oid('a') }, { date: 10, oid: oid('a') })).toBe(true);
    expect(precedes({ date: 10, oid: oid('a') }, { date: 30, oid: oid('a') })).toBe(false);
    // Older entry with the smaller oid must still not precede the newer: the date
    // comparison dominates the oid tie-break (the tie-break only applies on equal dates).
    expect(precedes({ date: 10, oid: oid('a') }, { date: 30, oid: oid('b') })).toBe(false);
  });
});

describe('Given two entries with equal commit dates, When ordering them', () => {
  it('Then the smaller oid precedes the larger', () => {
    // Arrange & Act + Assert
    expect(precedes({ date: 5, oid: oid('a') }, { date: 5, oid: oid('b') })).toBe(true);
    expect(precedes({ date: 5, oid: oid('b') }, { date: 5, oid: oid('a') })).toBe(false);
  });
});

describe('Given two fully equal entries, When ordering them', () => {
  it('Then neither precedes the other', () => {
    // Arrange & Act
    const result = precedes({ date: 5, oid: oid('a') }, { date: 5, oid: oid('a') });

    // Assert
    expect(result).toBe(false);
  });
});

describe('Given two arrivals with different commit dates, When ordering them by arrival', () => {
  it('Then the newer date precedes the older whatever arrived first', () => {
    // Arrange
    const older = { date: 10, arrival: 0 };
    const newer = { date: 30, arrival: 1 };

    // Act
    const result = [precedesByArrival(newer, older), precedesByArrival(older, newer)];

    // Assert
    expect(result).toEqual([true, false]);
  });
});

describe('Given two arrivals with equal commit dates, When ordering them by arrival', () => {
  it('Then the earlier arrival precedes the later', () => {
    // Arrange
    const earlier = { date: 5, arrival: 3 };
    const later = { date: 5, arrival: 4 };

    // Act
    const result = [precedesByArrival(earlier, later), precedesByArrival(later, earlier)];

    // Assert
    expect(result).toEqual([true, false]);
  });
});
