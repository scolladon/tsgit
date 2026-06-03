import { describe, expect, it } from 'vitest';

import { formatHumanDate } from '../../../../src/domain/show/date-human.js';

// now = 2026-06-02 21:18:00Z (matches the values observed against real git).
const NOW = Math.floor(Date.UTC(2026, 5, 2, 21, 18, 0) / 1000);
const TZ = '+0000';
const human = (secondsAgo: number): string => formatHumanDate(NOW - secondsAgo, TZ, NOW);

describe('Given the human-date format', () => {
  describe('When the commit is on the same calendar day', () => {
    it('Then it falls back to the relative form', () => {
      // Arrange + Act + Assert
      expect(human(5 * 3600)).toBe('5 hours ago');
    });
  });

  describe('When the commit is the previous day, same month, within five days', () => {
    it('Then it shows the weekday and time only', () => {
      // Arrange + Act + Assert
      expect(human(35 * 3600)).toBe('Mon 10:18');
    });
  });

  describe('When the commit is the same year but a different month', () => {
    it('Then it shows weekday, month, day, and time', () => {
      // Arrange + Act + Assert
      expect(human(3 * 86_400)).toBe('Sat May 30 21:18');
    });
  });

  describe('When the commit is in a different year', () => {
    it('Then it shows month, day, and year (no weekday, no time)', () => {
      // Arrange + Act + Assert
      expect(human(200 * 86_400)).toBe('Nov 14 2025');
    });
  });
});
