import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { formatGitDate } from '../../../../src/domain/show/git-date.js';
import { arbTimestamp, arbTimezoneOffset } from './arbitraries.js';

const MONTH_INDEX: ReadonlyMap<string, number> = new Map(
  ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map(
    (name, index) => [name, index],
  ),
);

const GRAMMAR =
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([1-9]|[12]\d|3[01]) \d{2}:\d{2}:\d{2} -?\d+ [+-]\d{4}$/;

describe('formatGitDate properties', () => {
  describe('Given an arbitrary timestamp and offset', () => {
    describe('When the date is formatted', () => {
      it('Then it matches the medium-format grammar and ends with the verbatim offset', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbTimestamp(), arbTimezoneOffset(), (timestamp, offset) => {
            const sut = formatGitDate(timestamp, offset);
            expect(sut).toMatch(GRAMMAR);
            expect(sut.endsWith(` ${offset}`)).toBe(true);
          }),
          { numRuns: 200 },
        );
      });
    });

    describe('When the formatted components are decoded back to an instant', () => {
      it('Then they round-trip to the original timestamp', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbTimestamp(), arbTimezoneOffset(), (timestamp, offset) => {
            const sut = formatGitDate(timestamp, offset);
            const [, monthName, day, time, year] = sut.split(' ');
            const [hh, mm, ss] = time!.split(':').map(Number);
            const sign = offset.startsWith('-') ? -1 : 1;
            const offsetSeconds =
              sign * (Number(offset.slice(1, 3)) * 3600 + Number(offset.slice(3, 5)) * 60);
            const wallClock = Date.UTC(
              Number(year),
              MONTH_INDEX.get(monthName!)!,
              Number(day),
              hh!,
              mm!,
              ss!,
            );
            expect(wallClock / 1000 - offsetSeconds).toBe(timestamp);
          }),
          { numRuns: 200 },
        );
      });
    });
  });
});
