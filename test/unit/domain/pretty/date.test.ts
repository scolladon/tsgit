import { describe, expect, it } from 'vitest';
import { type DateMode, showDate } from '../../../../src/domain/pretty/date.js';

const AUTHOR_TIME = 1700000200;
const AUTHOR_TZ = 5 * 60 + 45;
const COMMITTER_TIME = 1700000300;
const NOW = 1790000000;
const UTC = 0;

describe('showDate', () => {
  describe.each([
    ['normal', AUTHOR_TIME, AUTHOR_TZ, 'normal', 'Wed Nov 15 04:01:40 2023 +0545'],
    ['normal in UTC', COMMITTER_TIME, UTC, 'normal', 'Tue Nov 14 22:18:20 2023 +0000'],
    ['rfc2822', AUTHOR_TIME, AUTHOR_TZ, 'rfc2822', 'Wed, 15 Nov 2023 04:01:40 +0545'],
    ['rfc2822 in UTC', COMMITTER_TIME, UTC, 'rfc2822', 'Tue, 14 Nov 2023 22:18:20 +0000'],
    ['iso8601', AUTHOR_TIME, AUTHOR_TZ, 'iso8601', '2023-11-15 04:01:40 +0545'],
    ['iso8601-strict', AUTHOR_TIME, AUTHOR_TZ, 'iso8601-strict', '2023-11-15T04:01:40+05:45'],
    ['iso8601-strict in UTC', COMMITTER_TIME, UTC, 'iso8601-strict', '2023-11-14T22:18:20Z'],
    [
      'iso8601-strict west of UTC',
      COMMITTER_TIME,
      -(3 * 60 + 30),
      'iso8601-strict',
      '2023-11-14T18:48:20-03:30',
    ],
    ['iso8601 west of UTC', COMMITTER_TIME, -90, 'iso8601', '2023-11-14 20:48:20 -0130'],
    ['short', AUTHOR_TIME, AUTHOR_TZ, 'short', '2023-11-15'],
    [
      'normal single-digit day and fields',
      1704164645,
      UTC,
      'normal',
      'Tue Jan 2 03:04:05 2024 +0000',
    ],
  ])('Given %s, When rendering', (_title, timestamp, tz, mode, expected) => {
    it(`Then it renders ${expected}`, () => {
      // Arrange
      const sut = showDate;

      // Act
      const result = sut(timestamp, tz, mode as DateMode, NOW, UTC);

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe.each([
    ['the same second', 0, '0 seconds ago'],
    ['one second', 1, '1 second ago'],
    ['89 seconds', 89, '89 seconds ago'],
    ['90 seconds', 90, '2 minutes ago'],
    ['1 minute rounding', 150, '3 minutes ago'],
    ['89 minutes', 89 * 60, '89 minutes ago'],
    ['89 minutes 29 seconds', 89 * 60 + 29, '89 minutes ago'],
    ['89 minutes 30 seconds', 89 * 60 + 30, '2 hours ago'],
    ['one hour of minutes', 60 * 60, '60 minutes ago'],
    ['25 hours', 25 * 3600, '25 hours ago'],
    ['35 hours', 35 * 3600, '35 hours ago'],
    ['35 hours 30 minutes', 35 * 3600 + 30 * 60, '2 days ago'],
    ['2 days', 2 * 86400, '2 days ago'],
    ['13 days', 13 * 86400, '13 days ago'],
    ['14 days', 14 * 86400, '2 weeks ago'],
    ['69 days', 69 * 86400, '10 weeks ago'],
    ['70 days', 70 * 86400, '2 months ago'],
    ['364 days', 364 * 86400, '12 months ago'],
    ['365 days', 365 * 86400, '1 year ago'],
    ['400 days', 400 * 86400, '1 year, 1 month ago'],
    ['2 years', 730 * 86400, '2 years ago'],
    ['2 years 11 months', 1065 * 86400, '2 years, 11 months ago'],
    ['1824 days', 1824 * 86400, '5 years ago'],
    ['1825 days', 1825 * 86400, '5 years ago'],
    ['10 years', 3650 * 86400, '10 years ago'],
  ])('Given a time %s in the past, When rendering relative', (_title, ageSeconds, expected) => {
    it(`Then it renders ${expected}`, () => {
      // Arrange
      const sut = showDate;

      // Act
      const result = sut(NOW - ageSeconds, AUTHOR_TZ, 'relative', NOW, UTC);

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe('Given a time after now, When rendering relative', () => {
    it('Then it renders in the future', () => {
      // Arrange
      const sut = showDate;

      // Act
      const result = sut(NOW + 1, UTC, 'relative', NOW, UTC);

      // Assert
      expect(result).toBe('in the future');
    });
  });

  describe('Given human mode at Tue 2026-10-20 03:33:20 UTC', () => {
    const HUMAN_NOW = 1792467200;
    const DAY = 86400;
    const ago = (seconds: number): number => HUMAN_NOW - seconds;

    describe.each([
      ['the same day', ago(2 * 3600), UTC, '2 hours ago'],
      ['the same day in another zone', ago(3600), AUTHOR_TZ, '60 minutes ago'],
      ['a day earlier in the same month', ago(DAY), UTC, 'Mon 03:33'],
      ['four days earlier in the same month, other zone', ago(4 * DAY), -60, 'Fri 02:33 -0100'],
      ['five days earlier in the same month', ago(5 * DAY), UTC, 'Thu Oct 15 03:33'],
      ['an earlier month of the same year', ago(25 * DAY), UTC, 'Fri Sep 25 03:33'],
      ['an earlier year', ago(400 * DAY), UTC, 'Sep 15 2025'],
      ['a time later the same day', HUMAN_NOW + 3600, UTC, 'in the future'],
    ])('When the author time is %s', (_title, timestamp, tz, expected) => {
      it(`Then it renders ${expected}`, () => {
        // Arrange
        const sut = showDate;

        // Act
        const result = sut(timestamp, tz, 'human', HUMAN_NOW, UTC);

        // Assert
        expect(result).toBe(expected);
      });
    });

    describe('When the local zone differs from the author zone on another day', () => {
      it('Then the zone is shown with the weekday', () => {
        // Arrange
        const sut = showDate;

        // Act
        const result = sut(ago(DAY), UTC, 'human', HUMAN_NOW, 120);

        // Assert
        expect(result).toBe('Mon 03:33 +0000');
      });
    });

    describe('When the time falls on the next day in its own zone', () => {
      it('Then the date is shown, as for a future date across zones', () => {
        // Arrange
        const sut = showDate;
        const justAfterLocalMidnight = HUMAN_NOW - 2 * 3600;

        // Act
        const result = sut(justAfterLocalMidnight, UTC, 'human', HUMAN_NOW, -4 * 60);

        // Assert
        expect(result).toBe('Tue Oct 20 01:33');
      });
    });
  });
});
