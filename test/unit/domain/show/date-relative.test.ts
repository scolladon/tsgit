import { describe, expect, it } from 'vitest';

import { formatRelativeDate } from '../../../../src/domain/show/date-relative.js';

// Inject `now` so the cascade is deterministic. `then` is fixed at 0 and `now`
// is the elapsed-second count for each band boundary.
const ago = (seconds: number): string => formatRelativeDate(0, seconds);

describe('Given the relative-date cascade', () => {
  describe('When the diff is within the seconds band', () => {
    it('Then it renders seconds, singular at one', () => {
      // Arrange + Act + Assert
      expect(ago(1)).toBe('1 second ago');
      expect(ago(10)).toBe('10 seconds ago');
      expect(ago(89)).toBe('89 seconds ago');
    });
  });

  describe('When the diff crosses into minutes', () => {
    it('Then 90 seconds rounds to 2 minutes', () => {
      // Arrange + Act + Assert
      expect(ago(90)).toBe('2 minutes ago');
    });
  });

  describe('When the diff is in the hours band', () => {
    it('Then it renders rounded hours', () => {
      // Arrange + Act + Assert
      expect(ago(5 * 3600)).toBe('5 hours ago');
      expect(ago(35 * 3600)).toBe('35 hours ago');
    });
  });

  describe('When the diff is in the days band', () => {
    it('Then it renders days (the band opens at two — 36h is the first day bucket)', () => {
      // Arrange + Act + Assert
      expect(ago(36 * 3600)).toBe('2 days ago');
      expect(ago(3 * 86_400)).toBe('3 days ago');
    });
  });

  describe('When the diff is in the weeks band', () => {
    it('Then it renders rounded weeks', () => {
      // Arrange + Act + Assert
      expect(ago(20 * 86_400)).toBe('3 weeks ago');
      expect(ago(60 * 86_400)).toBe('9 weeks ago');
    });
  });

  describe('When the diff is in the months band', () => {
    it('Then it renders rounded months', () => {
      // Arrange + Act + Assert
      expect(ago(90 * 86_400)).toBe('3 months ago');
      expect(ago(200 * 86_400)).toBe('7 months ago');
    });
  });

  describe('When the diff is in the 1–5 year band', () => {
    it('Then it renders years with a trailing month count when non-zero', () => {
      // Arrange + Act + Assert
      expect(ago(400 * 86_400)).toBe('1 year, 1 month ago');
      expect(ago(1000 * 86_400)).toBe('2 years, 9 months ago');
    });

    it('Then a whole-year diff drops the month clause', () => {
      // Arrange + Act + Assert
      expect(ago(365 * 86_400)).toBe('1 year ago');
    });
  });

  describe('When the diff is five or more years', () => {
    it('Then it renders rounded years', () => {
      // Arrange + Act + Assert
      expect(ago(2000 * 86_400)).toBe('5 years ago');
    });
  });

  describe('When the date is in the future', () => {
    it('Then it renders the future marker', () => {
      // Arrange + Act + Assert
      expect(formatRelativeDate(100, 50)).toBe('in the future');
    });
  });
});
