import { describe, expect, it } from 'vitest';
import { precedesByArrival } from '../../../../src/domain/commit/priority-queue.js';

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
