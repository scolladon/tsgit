import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { showDate } from '../../../../src/domain/pretty/date.js';

const NUM_RUNS = 200;
const MAX_TIMESTAMP = 4_000_000_000;
const MIN_OFFSET_MINUTES = -12 * 60;
const MAX_OFFSET_MINUTES = 14 * 60;
const MILLIS_PER_SECOND = 1000;

describe('Given any timestamp and zone, When rendering iso8601-strict', () => {
  it('Then parsing the output yields the same instant', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_TIMESTAMP }),
        fc.integer({ min: MIN_OFFSET_MINUTES, max: MAX_OFFSET_MINUTES }),
        (timestamp, offset) => {
          // Arrange
          const sut = showDate;

          // Act
          const result = sut(timestamp, offset, 'iso8601-strict', 0, 0);

          // Assert
          expect(Date.parse(result)).toBe(timestamp * MILLIS_PER_SECOND);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
