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

describe('parseApproxidate', () => {
  describe('keyword forms', () => {
    it("Given 'now', When parsing, Then returns the reference instant", () => {
      // Arrange / Act
      const result = parseApproxidate('now', NOW);

      // Assert
      expect(result).toBe(NOW);
    });

    it("Given 'yesterday', When parsing, Then returns 24h before now", () => {
      // Arrange / Act
      const result = parseApproxidate('yesterday', NOW);

      // Assert
      expect(result).toBe(NOW - DAY);
    });

    it('Given surrounding whitespace, When parsing, Then it is trimmed before matching', () => {
      // Arrange / Act
      const result = parseApproxidate('  now  ', NOW);

      // Assert
      expect(result).toBe(NOW);
    });

    it('Given mixed-case keyword, When parsing, Then matching is case-insensitive', () => {
      // Arrange / Act
      const result = parseApproxidate('NOW', NOW);

      // Assert
      expect(result).toBe(NOW);
    });
  });

  describe('ISO absolute forms', () => {
    it('Given an ISO date, When parsing, Then returns local midnight of that day', () => {
      // Arrange
      const expected = Math.floor(new Date(2026, 4, 1, 0, 0, 0).getTime() / 1000);

      // Act
      const result = parseApproxidate('2026-05-01', NOW);

      // Assert
      expect(result).toBe(expected);
    });

    it('Given an ISO datetime, When parsing, Then returns the local instant', () => {
      // Arrange
      const expected = Math.floor(new Date(2026, 4, 1, 12, 30, 0).getTime() / 1000);

      // Act
      const result = parseApproxidate('2026-05-01 12:30:00', NOW);

      // Assert
      expect(result).toBe(expected);
    });

    it('Given an ISO date with month 00, When parsing, Then returns undefined', () => {
      // Arrange / Act — lower month bound.
      const result = parseApproxidate('2026-00-01', NOW);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Given an ISO date with month 13, When parsing, Then returns undefined', () => {
      // Arrange / Act — upper month bound.
      const result = parseApproxidate('2026-13-01', NOW);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Given an ISO date with month 01, When parsing, Then it is accepted', () => {
      // Arrange — January is the first valid month (lower-bound boundary).
      const expected = Math.floor(new Date(2026, 0, 15, 0, 0, 0).getTime() / 1000);

      // Act
      const result = parseApproxidate('2026-01-15', NOW);

      // Assert
      expect(result).toBe(expected);
    });

    it('Given an ISO date with month 12, When parsing, Then it is accepted', () => {
      // Arrange — December is the last valid month.
      const expected = Math.floor(new Date(2026, 11, 1, 0, 0, 0).getTime() / 1000);

      // Act
      const result = parseApproxidate('2026-12-01', NOW);

      // Assert
      expect(result).toBe(expected);
    });

    it('Given an ISO date with day 31 in March, When parsing, Then it is accepted', () => {
      // Arrange — March has 31 days; only February's length is leap-sensitive.
      const expected = Math.floor(new Date(2026, 2, 31, 0, 0, 0).getTime() / 1000);

      // Act
      const result = parseApproxidate('2026-03-31', NOW);

      // Assert
      expect(result).toBe(expected);
    });

    it('Given an ISO date with day 30 in April of a leap year, When parsing, Then it is accepted', () => {
      // Arrange — only February's length depends on the leap year; April keeps
      // its 30 days in 2024.
      const expected = Math.floor(new Date(2024, 3, 30, 0, 0, 0).getTime() / 1000);

      // Act
      const result = parseApproxidate('2024-04-30', NOW);

      // Assert
      expect(result).toBe(expected);
    });

    it('Given an ISO date with day 00, When parsing, Then returns undefined', () => {
      // Arrange / Act — lower day bound.
      const result = parseApproxidate('2026-05-00', NOW);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Given an ISO date with day 31 in a 30-day month, When parsing, Then returns undefined', () => {
      // Arrange / Act — April has 30 days.
      const result = parseApproxidate('2026-04-31', NOW);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Given an ISO date with an over-range day in December, When parsing, Then returns undefined', () => {
      // Arrange / Act — December (month 12) exercises the top of the
      // month-length table; an out-of-range day must still be rejected.
      const result = parseApproxidate('2026-12-99', NOW);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Given an ISO date with day 31 in a 31-day month, When parsing, Then it is accepted', () => {
      // Arrange — May has 31 days; the day's upper bound is month-specific.
      const expected = Math.floor(new Date(2026, 4, 31, 0, 0, 0).getTime() / 1000);

      // Act
      const result = parseApproxidate('2026-05-31', NOW);

      // Assert
      expect(result).toBe(expected);
    });

    it('Given Feb 29 in a leap year, When parsing, Then it is accepted', () => {
      // Arrange — 2024 is divisible by 4 and not by 100.
      const expected = Math.floor(new Date(2024, 1, 29, 0, 0, 0).getTime() / 1000);

      // Act
      const result = parseApproxidate('2024-02-29', NOW);

      // Assert
      expect(result).toBe(expected);
    });

    it('Given Feb 29 in a common year, When parsing, Then returns undefined', () => {
      // Arrange / Act — 2026 is not a leap year.
      const result = parseApproxidate('2026-02-29', NOW);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Given Feb 29 in a year divisible by 100 but not 400, When parsing, Then returns undefined', () => {
      // Arrange / Act — 1900 is not a leap year despite being divisible by 4.
      const result = parseApproxidate('1900-02-29', NOW);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Given Feb 29 in a year divisible by 400, When parsing, Then it is accepted', () => {
      // Arrange — 2000 is a leap year.
      const expected = Math.floor(new Date(2000, 1, 29, 0, 0, 0).getTime() / 1000);

      // Act
      const result = parseApproxidate('2000-02-29', NOW);

      // Assert
      expect(result).toBe(expected);
    });

    it('Given an ISO datetime with hour 24, When parsing, Then returns undefined', () => {
      // Arrange / Act — 23 is the upper hour bound.
      const result = parseApproxidate('2026-05-01 24:00:00', NOW);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Given an ISO datetime with hour 23, When parsing, Then it is accepted', () => {
      // Arrange — boundary: hour 23 is valid.
      const expected = Math.floor(new Date(2026, 4, 1, 23, 0, 0).getTime() / 1000);

      // Act
      const result = parseApproxidate('2026-05-01 23:00:00', NOW);

      // Assert
      expect(result).toBe(expected);
    });

    it('Given an ISO datetime with minute 60, When parsing, Then returns undefined', () => {
      // Arrange / Act — 59 is the upper minute bound.
      const result = parseApproxidate('2026-05-01 12:60:00', NOW);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Given an ISO datetime with minute 59, When parsing, Then it is accepted', () => {
      // Arrange — boundary: minute 59 is valid.
      const expected = Math.floor(new Date(2026, 4, 1, 12, 59, 0).getTime() / 1000);

      // Act
      const result = parseApproxidate('2026-05-01 12:59:00', NOW);

      // Assert
      expect(result).toBe(expected);
    });

    it('Given an ISO datetime with second 60, When parsing, Then returns undefined', () => {
      // Arrange / Act
      const result = parseApproxidate('2026-05-01 12:30:60', NOW);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Given an ISO datetime with second 59, When parsing, Then it is accepted', () => {
      // Arrange — boundary: second 59 is valid.
      const expected = Math.floor(new Date(2026, 4, 1, 12, 30, 59).getTime() / 1000);

      // Act
      const result = parseApproxidate('2026-05-01 12:30:59', NOW);

      // Assert
      expect(result).toBe(expected);
    });

    it('Given an ISO date in year 0099, When parsing, Then the literal year 99 AD is used (not 1999)', () => {
      // Arrange — `new Date(99, …)` coerces to 1999; the literal year must be pinned.
      const expected = new Date(0, 0, 1, 0, 0, 0);
      expected.setFullYear(99);

      // Act
      const result = parseApproxidate('0099-01-01', NOW);

      // Assert
      expect(result).toBe(Math.floor(expected.getTime() / 1000));
    });
  });

  describe('relative dotted forms', () => {
    it("Given '2.days.ago', When parsing, Then returns now minus two days", () => {
      // Arrange / Act
      const result = parseApproxidate('2.days.ago', NOW);

      // Assert
      expect(result).toBe(NOW - 2 * DAY);
    });

    it("Given '90.days' without .ago, When parsing, Then it equals the .ago form", () => {
      // Arrange / Act
      const withSuffix = parseApproxidate('90.days.ago', NOW);
      const without = parseApproxidate('90.days', NOW);

      // Assert
      expect(without).toBe(withSuffix);
    });

    it("Given '3.weeks.ago', When parsing, Then returns now minus three weeks", () => {
      // Arrange / Act
      const result = parseApproxidate('3.weeks.ago', NOW);

      // Assert
      expect(result).toBe(NOW - 3 * WEEK);
    });

    it("Given a singular unit '1.day.ago', When parsing, Then returns now minus one day", () => {
      // Arrange / Act
      const result = parseApproxidate('1.day.ago', NOW);

      // Assert
      expect(result).toBe(NOW - DAY);
    });
  });

  describe('relative spaced forms', () => {
    it("Given '2 days ago', When parsing, Then returns now minus two days", () => {
      // Arrange / Act
      const result = parseApproxidate('2 days ago', NOW);

      // Assert
      expect(result).toBe(NOW - 2 * DAY);
    });

    it("Given '3 weeks ago', When parsing, Then returns now minus three weeks", () => {
      // Arrange / Act
      const result = parseApproxidate('3 weeks ago', NOW);

      // Assert
      expect(result).toBe(NOW - 3 * WEEK);
    });

    it("Given '5 minutes' without ago, When parsing, Then it equals the 'ago' form", () => {
      // Arrange / Act
      const withSuffix = parseApproxidate('5 minutes ago', NOW);
      const without = parseApproxidate('5 minutes', NOW);

      // Assert
      expect(without).toBe(withSuffix);
    });
  });

  describe('every supported unit', () => {
    it("Given '10 seconds ago', When parsing, Then subtracts ten seconds", () => {
      // Arrange
      const sut = parseApproxidate('10 seconds ago', NOW);

      // Assert
      expect(sut).toBe(NOW - 10);
    });

    it("Given '10 minutes ago', When parsing, Then subtracts ten minutes", () => {
      // Arrange
      const sut = parseApproxidate('10 minutes ago', NOW);

      // Assert
      expect(sut).toBe(NOW - 10 * MINUTE);
    });

    it("Given '10 hours ago', When parsing, Then subtracts ten hours", () => {
      // Arrange
      const sut = parseApproxidate('10 hours ago', NOW);

      // Assert
      expect(sut).toBe(NOW - 10 * HOUR);
    });

    it("Given '10 days ago', When parsing, Then subtracts ten days", () => {
      // Arrange
      const sut = parseApproxidate('10 days ago', NOW);

      // Assert
      expect(sut).toBe(NOW - 10 * DAY);
    });

    it("Given '10 weeks ago', When parsing, Then subtracts ten weeks", () => {
      // Arrange
      const sut = parseApproxidate('10 weeks ago', NOW);

      // Assert
      expect(sut).toBe(NOW - 10 * WEEK);
    });

    it("Given '2 months ago', When parsing, Then subtracts two 30-day months", () => {
      // Arrange
      const sut = parseApproxidate('2 months ago', NOW);

      // Assert
      expect(sut).toBe(NOW - 2 * MONTH);
    });

    it("Given '1 year ago', When parsing, Then subtracts a 365-day year", () => {
      // Arrange
      const sut = parseApproxidate('1 year ago', NOW);

      // Assert
      expect(sut).toBe(NOW - YEAR);
    });
  });

  describe('unparseable input', () => {
    it('Given an empty string, When parsing, Then returns undefined', () => {
      // Arrange
      const sut = parseApproxidate('', NOW);

      // Assert
      expect(sut).toBeUndefined();
    });

    it('Given garbage text, When parsing, Then returns undefined', () => {
      // Arrange
      const sut = parseApproxidate('not a date at all', NOW);

      // Assert
      expect(sut).toBeUndefined();
    });

    it('Given an unknown unit, When parsing, Then returns undefined', () => {
      // Arrange
      const sut = parseApproxidate('3 fortnights ago', NOW);

      // Assert
      expect(sut).toBeUndefined();
    });

    it('Given a relative form with a non-numeric count, When parsing, Then returns undefined', () => {
      // Arrange
      const sut = parseApproxidate('many days ago', NOW);

      // Assert
      expect(sut).toBeUndefined();
    });

    it('Given a weekday name (unsupported form), When parsing, Then returns undefined', () => {
      // Arrange
      const sut = parseApproxidate('monday', NOW);

      // Assert
      expect(sut).toBeUndefined();
    });

    it('Given a bare integer, When parsing, Then returns undefined', () => {
      // Arrange
      const sut = parseApproxidate('1779710400', NOW);

      // Assert
      expect(sut).toBeUndefined();
    });
  });
});
