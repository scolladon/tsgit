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

    it('Given an ISO date with an impossible month, When parsing, Then returns undefined', () => {
      // Arrange / Act
      const result = parseApproxidate('2026-13-01', NOW);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Given an ISO date with an impossible day, When parsing, Then returns undefined', () => {
      // Arrange / Act
      const result = parseApproxidate('2026-02-30', NOW);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Given an ISO datetime with an impossible hour, When parsing, Then returns undefined', () => {
      // Arrange / Act
      const result = parseApproxidate('2026-05-01 25:00:00', NOW);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Given an ISO datetime with an impossible minute, When parsing, Then returns undefined', () => {
      // Arrange / Act
      const result = parseApproxidate('2026-05-01 12:60:00', NOW);

      // Assert
      expect(result).toBeUndefined();
    });

    it('Given an ISO datetime with an impossible second, When parsing, Then returns undefined', () => {
      // Arrange / Act
      const result = parseApproxidate('2026-05-01 12:30:60', NOW);

      // Assert
      expect(result).toBeUndefined();
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
      expect(parseApproxidate('10 seconds ago', NOW)).toBe(NOW - 10);
    });

    it("Given '10 minutes ago', When parsing, Then subtracts ten minutes", () => {
      expect(parseApproxidate('10 minutes ago', NOW)).toBe(NOW - 10 * MINUTE);
    });

    it("Given '10 hours ago', When parsing, Then subtracts ten hours", () => {
      expect(parseApproxidate('10 hours ago', NOW)).toBe(NOW - 10 * HOUR);
    });

    it("Given '10 days ago', When parsing, Then subtracts ten days", () => {
      expect(parseApproxidate('10 days ago', NOW)).toBe(NOW - 10 * DAY);
    });

    it("Given '10 weeks ago', When parsing, Then subtracts ten weeks", () => {
      expect(parseApproxidate('10 weeks ago', NOW)).toBe(NOW - 10 * WEEK);
    });

    it("Given '2 months ago', When parsing, Then subtracts two 30-day months", () => {
      expect(parseApproxidate('2 months ago', NOW)).toBe(NOW - 2 * MONTH);
    });

    it("Given '1 year ago', When parsing, Then subtracts a 365-day year", () => {
      expect(parseApproxidate('1 year ago', NOW)).toBe(NOW - YEAR);
    });
  });

  describe('unparseable input', () => {
    it('Given an empty string, When parsing, Then returns undefined', () => {
      expect(parseApproxidate('', NOW)).toBeUndefined();
    });

    it('Given garbage text, When parsing, Then returns undefined', () => {
      expect(parseApproxidate('not a date at all', NOW)).toBeUndefined();
    });

    it('Given an unknown unit, When parsing, Then returns undefined', () => {
      expect(parseApproxidate('3 fortnights ago', NOW)).toBeUndefined();
    });

    it('Given a relative form with a non-numeric count, When parsing, Then returns undefined', () => {
      expect(parseApproxidate('many days ago', NOW)).toBeUndefined();
    });

    it('Given a weekday name (unsupported form), When parsing, Then returns undefined', () => {
      expect(parseApproxidate('monday', NOW)).toBeUndefined();
    });

    it('Given a bare integer, When parsing, Then returns undefined', () => {
      expect(parseApproxidate('1779710400', NOW)).toBeUndefined();
    });
  });
});
