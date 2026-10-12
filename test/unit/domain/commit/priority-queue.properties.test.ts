import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { precedesByArrival } from '../../../../src/domain/commit/priority-queue.js';

const arrivedArb = fc.record({
  date: fc.integer({ min: 0, max: 4 }),
  arrival: fc.integer({ min: 0, max: 4 }),
});

describe('Given an arbitrary arrival pair, When comparing with precedesByArrival', () => {
  it('Then exactly one direction precedes for any two distinct arrivals, and none for equal ones', () => {
    // Arrange
    fc.assert(
      fc.property(arrivedArb, arrivedArb, (a, b) => {
        // Act
        const result = [precedesByArrival(a, b), precedesByArrival(b, a)];

        // Assert — a strict total order on (date desc, arrival asc).
        const distinct = a.date !== b.date || a.arrival !== b.arrival;
        expect(result.filter(Boolean).length).toBe(distinct ? 1 : 0);
      }),
      { numRuns: 200 },
    );
  });
});
