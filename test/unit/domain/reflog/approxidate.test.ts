import { describe, expect, it } from 'vitest';
import { parseApproxidate } from '../../../../src/domain/reflog/approxidate.js';

// Reference instant: 2026-05-21T12:00:00Z = 1779710400. Tests run under TZ=UTC
// (pinned in vitest.config.ts), so local calendar arithmetic equals UTC here.
const NOW = 1779710400;

const DAY = 86_400;
const HOUR = 3_600;
const MINUTE = 60;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

const YEAR_0099_EXPECTED = (() => {
  // `new Date(99, …)` coerces to 1999; the literal year must be pinned via
  // setFullYear (which also returns the new epoch-ms timestamp).
  const expected = new Date(0, 0, 1, 0, 0, 0);
  expected.setFullYear(99);
  return Math.floor(expected.getTime() / 1000);
})();

describe('parseApproxidate', () => {
  describe('keyword forms', () => {
    describe('Given a keyword date string', () => {
      describe('When parsing', () => {
        it.each([
          { input: 'now', expected: NOW, label: 'returns the reference instant for "now"' },
          {
            input: 'yesterday',
            expected: NOW - DAY,
            label: 'returns 24h before now for "yesterday"',
          },
          {
            input: '  now  ',
            expected: NOW,
            label: 'surrounding whitespace is trimmed before matching',
          },
          { input: 'NOW', expected: NOW, label: 'matching is case-insensitive' },
        ])('Then $label', ({ input, expected }) => {
          // Arrange
          const sut = input;

          // Act
          const result = parseApproxidate(sut, NOW);

          // Assert
          expect(result).toBe(expected);
        });
      });
    });
  });

  describe('ISO absolute forms', () => {
    describe('Given a valid ISO date or datetime string', () => {
      describe('When parsing', () => {
        it.each([
          {
            input: '2026-05-01',
            expected: Math.floor(new Date(2026, 4, 1, 0, 0, 0).getTime() / 1000),
            label: 'an ISO date returns local midnight of that day',
          },
          {
            input: '2026-05-01 12:30:00',
            expected: Math.floor(new Date(2026, 4, 1, 12, 30, 0).getTime() / 1000),
            label: 'an ISO datetime returns the local instant',
          },
          {
            input: '2026-01-15',
            expected: Math.floor(new Date(2026, 0, 15, 0, 0, 0).getTime() / 1000),
            // January is the first valid month (lower-bound boundary).
            label: 'month 01 (lower bound) is accepted',
          },
          {
            input: '2026-12-01',
            expected: Math.floor(new Date(2026, 11, 1, 0, 0, 0).getTime() / 1000),
            // December is the last valid month.
            label: 'month 12 (upper bound) is accepted',
          },
          {
            input: '2026-03-31',
            expected: Math.floor(new Date(2026, 2, 31, 0, 0, 0).getTime() / 1000),
            // March has 31 days; only February's length is leap-sensitive.
            label: 'day 31 in a 31-day month (March) is accepted',
          },
          {
            input: '2024-04-30',
            expected: Math.floor(new Date(2024, 3, 30, 0, 0, 0).getTime() / 1000),
            // only February's length depends on the leap year; April keeps its
            // 30 days in 2024.
            label: 'day 30 in April of a leap year is accepted',
          },
          {
            input: '2026-05-31',
            expected: Math.floor(new Date(2026, 4, 31, 0, 0, 0).getTime() / 1000),
            // May has 31 days; the day's upper bound is month-specific.
            label: 'day 31 in a 31-day month (May) is accepted',
          },
          {
            input: '2024-02-29',
            expected: Math.floor(new Date(2024, 1, 29, 0, 0, 0).getTime() / 1000),
            // 2024 is divisible by 4 and not by 100.
            label: 'Feb 29 in a leap year (divisible by 4) is accepted',
          },
          {
            input: '2000-02-29',
            expected: Math.floor(new Date(2000, 1, 29, 0, 0, 0).getTime() / 1000),
            // 2000 is a leap year.
            label: 'Feb 29 in a year divisible by 400 is accepted',
          },
          {
            input: '2026-05-01 23:00:00',
            expected: Math.floor(new Date(2026, 4, 1, 23, 0, 0).getTime() / 1000),
            label: 'hour 23 (upper bound) is accepted',
          },
          {
            input: '2026-05-01 12:59:00',
            expected: Math.floor(new Date(2026, 4, 1, 12, 59, 0).getTime() / 1000),
            label: 'minute 59 (upper bound) is accepted',
          },
          {
            input: '2026-05-01 12:30:59',
            expected: Math.floor(new Date(2026, 4, 1, 12, 30, 59).getTime() / 1000),
            label: 'second 59 (upper bound) is accepted',
          },
          {
            input: '0099-01-01',
            expected: YEAR_0099_EXPECTED,
            label: 'the literal year 99 AD is used (not 1999)',
          },
        ])('Then $label', ({ input, expected }) => {
          // Arrange
          const sut = input;

          // Act
          const result = parseApproxidate(sut, NOW);

          // Assert
          expect(result).toBe(expected);
        });
      });
    });

    describe('Given an invalid ISO date or datetime string', () => {
      describe('When parsing', () => {
        it.each([
          // lower month bound
          { input: '2026-00-01', label: 'month 00 (below lower bound) is rejected' },
          // upper month bound
          { input: '2026-13-01', label: 'month 13 (above upper bound) is rejected' },
          // lower day bound
          { input: '2026-05-00', label: 'day 00 (below lower bound) is rejected' },
          // April has 30 days
          { input: '2026-04-31', label: 'day 31 in a 30-day month (April) is rejected' },
          // December (month 12) exercises the top of the month-length table; an
          // out-of-range day must still be rejected.
          { input: '2026-12-99', label: 'an out-of-range day in December is rejected' },
          // 2026 is not a leap year
          { input: '2026-02-29', label: 'Feb 29 in a common year is rejected' },
          // 1900 is not a leap year despite being divisible by 4
          {
            input: '1900-02-29',
            label: 'Feb 29 in a year divisible by 100 but not 400 is rejected',
          },
          // 23 is the upper hour bound
          { input: '2026-05-01 24:00:00', label: 'hour 24 (above upper bound) is rejected' },
          // 59 is the upper minute bound
          { input: '2026-05-01 12:60:00', label: 'minute 60 (above upper bound) is rejected' },
          { input: '2026-05-01 12:30:60', label: 'second 60 (above upper bound) is rejected' },
          // the pattern is anchored to the start, so an embedded date behind
          // leading text must not be reached.
          {
            input: 'x2026-05-01',
            label: 'an ISO date preceded by non-date text is rejected (anchored to the start)',
          },
          // the pattern is anchored to the end, so trailing text after an
          // otherwise-valid date must not be ignored.
          {
            input: '2026-05-01x',
            label: 'an ISO date followed by non-date text is rejected (anchored to the end)',
          },
        ])('Then $label', ({ input }) => {
          // Arrange
          const sut = input;

          // Act
          const result = parseApproxidate(sut, NOW);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });
  });

  describe('relative dotted forms', () => {
    describe('Given a relative date string in dotted form', () => {
      describe('When parsing', () => {
        it.each([
          { input: '2.days.ago', expected: NOW - 2 * DAY, label: 'returns now minus two days' },
          {
            input: '3.weeks.ago',
            expected: NOW - 3 * WEEK,
            label: 'returns now minus three weeks',
          },
          {
            input: '1.day.ago',
            expected: NOW - DAY,
            label: 'returns now minus one day (singular unit)',
          },
        ])('Then $label', ({ input, expected }) => {
          // Arrange
          const sut = input;

          // Act
          const result = parseApproxidate(sut, NOW);

          // Assert
          expect(result).toBe(expected);
        });
      });
    });

    describe("Given '90.days' without .ago", () => {
      describe('When parsing', () => {
        it('Then it equals the .ago form', () => {
          // Arrange / Act
          const withSuffix = parseApproxidate('90.days.ago', NOW);
          const without = parseApproxidate('90.days', NOW);

          // Assert
          expect(without).toBe(withSuffix);
        });
      });
    });
  });

  describe('relative spaced forms', () => {
    describe("Given '2 days ago'", () => {
      describe('When parsing', () => {
        it('Then returns now minus two days', () => {
          // Arrange / Act
          const result = parseApproxidate('2 days ago', NOW);

          // Assert
          expect(result).toBe(NOW - 2 * DAY);
        });
      });
    });

    describe("Given '3 weeks ago'", () => {
      describe('When parsing', () => {
        it('Then returns now minus three weeks', () => {
          // Arrange / Act
          const result = parseApproxidate('3 weeks ago', NOW);

          // Assert
          expect(result).toBe(NOW - 3 * WEEK);
        });
      });
    });

    describe("Given '5 minutes' without ago", () => {
      describe('When parsing', () => {
        it("Then it equals the 'ago' form", () => {
          // Arrange / Act
          const withSuffix = parseApproxidate('5 minutes ago', NOW);
          const without = parseApproxidate('5 minutes', NOW);

          // Assert
          expect(without).toBe(withSuffix);
        });
      });
    });

    describe('Given a relative form preceded by non-date text', () => {
      describe('When parsing', () => {
        it('Then returns undefined', () => {
          // Arrange / Act — the pattern is anchored to the start, so a relative
          // form behind leading text must not be reached.
          const result = parseApproxidate('x2 days ago', NOW);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });
  });

  describe('every supported unit', () => {
    describe('Given a relative date string of the form "N <unit> ago"', () => {
      describe('When parsing', () => {
        it.each([
          { input: '10 seconds ago', expected: NOW - 10, label: 'subtracts ten seconds' },
          { input: '10 minutes ago', expected: NOW - 10 * MINUTE, label: 'subtracts ten minutes' },
          { input: '10 hours ago', expected: NOW - 10 * HOUR, label: 'subtracts ten hours' },
          { input: '10 days ago', expected: NOW - 10 * DAY, label: 'subtracts ten days' },
          { input: '10 weeks ago', expected: NOW - 10 * WEEK, label: 'subtracts ten weeks' },
          {
            input: '2 months ago',
            expected: NOW - 2 * MONTH,
            label: 'subtracts two 30-day months',
          },
          { input: '1 year ago', expected: NOW - YEAR, label: 'subtracts a 365-day year' },
        ])('Then $label', ({ input, expected }) => {
          // Arrange
          const sut = parseApproxidate(input, NOW);

          // Assert
          expect(sut).toBe(expected);
        });
      });
    });
  });

  describe('unparseable input', () => {
    describe('Given an unparseable date string', () => {
      describe('When parsing', () => {
        it.each([
          { input: '', label: 'an empty string' },
          { input: 'not a date at all', label: 'garbage text' },
          { input: '3 fortnights ago', label: 'an unknown unit' },
          { input: 'many days ago', label: 'a relative form with a non-numeric count' },
          { input: 'monday', label: 'a weekday name (unsupported form)' },
          { input: '1779710400', label: 'a bare integer' },
        ])('Then returns undefined for $label', ({ input }) => {
          // Arrange
          const sut = parseApproxidate(input, NOW);

          // Assert
          expect(sut).toBeUndefined();
        });
      });
    });
  });
});
