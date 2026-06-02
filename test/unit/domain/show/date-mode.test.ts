// `--date=local` reads host-zone components; pin the zone so the example is
// deterministic. Set before any Date is constructed.
process.env.TZ = 'UTC';

import { describe, expect, it } from 'vitest';

import { formatDate, parseDateMode } from '../../../../src/domain/show/date-mode.js';

// 1700000100 = 2023-11-14T22:15:00Z; in +0200 the wall clock is 2023-11-15 00:15.
const TS = 1_700_000_100;
const TZ = '+0200';
const NOW = TS; // unused by the absolute modes

// 1678007223 = 2023-03-05T09:07:03Z; in +0530 the wall clock is 2023-03-05 14:37:03.
const TS_SINGLE = 1_678_007_223;
const TZ_SINGLE = '+0530';

const fmt = (spec: string, ts = TS, tz = TZ): string => {
  const mode = parseDateMode(spec);
  if (mode === undefined) throw new Error(`unexpected unknown mode ${spec}`);
  return formatDate(mode, ts, tz, NOW);
};

describe('Given parseDateMode', () => {
  describe('When a known name or alias is given', () => {
    it('Then it resolves the mode', () => {
      // Arrange + Act + Assert
      expect(parseDateMode('default')).toEqual({ kind: 'default' });
      expect(parseDateMode('normal')).toEqual({ kind: 'default' });
      expect(parseDateMode('iso8601')).toEqual({ kind: 'iso' });
      expect(parseDateMode('iso8601-strict')).toEqual({ kind: 'iso-strict' });
      expect(parseDateMode('rfc2822')).toEqual({ kind: 'rfc' });
    });
  });

  describe('When a format: spec is given', () => {
    it('Then it captures the strftime template verbatim', () => {
      // Arrange + Act + Assert
      expect(parseDateMode('format:%Y/%m')).toEqual({ kind: 'strftime', format: '%Y/%m' });
    });
  });

  describe('When the spec is unknown', () => {
    it('Then it returns undefined', () => {
      // Arrange + Act + Assert
      expect(parseDateMode('nope')).toBeUndefined();
    });
  });
});

describe('Given formatDate over the absolute modes', () => {
  describe('When a two-digit-day timestamp is rendered', () => {
    it('Then each mode matches git', () => {
      // Arrange + Act + Assert
      expect(fmt('default')).toBe('Wed Nov 15 00:15:00 2023 +0200');
      expect(fmt('iso')).toBe('2023-11-15 00:15:00 +0200');
      expect(fmt('iso-strict')).toBe('2023-11-15T00:15:00+02:00');
      expect(fmt('rfc')).toBe('Wed, 15 Nov 2023 00:15:00 +0200');
      expect(fmt('short')).toBe('2023-11-15');
      expect(fmt('raw')).toBe('1700000100 +0200');
      expect(fmt('unix')).toBe('1700000100');
    });
  });

  describe('When a single-digit-day timestamp is rendered', () => {
    it('Then the day is unpadded for default/rfc but padded for iso/short', () => {
      // Arrange + Act + Assert
      expect(fmt('default', TS_SINGLE, TZ_SINGLE)).toBe('Sun Mar 5 14:37:03 2023 +0530');
      expect(fmt('rfc', TS_SINGLE, TZ_SINGLE)).toBe('Sun, 5 Mar 2023 14:37:03 +0530');
      expect(fmt('iso', TS_SINGLE, TZ_SINGLE)).toBe('2023-03-05 14:37:03 +0530');
      expect(fmt('iso-strict', TS_SINGLE, TZ_SINGLE)).toBe('2023-03-05T14:37:03+05:30');
      expect(fmt('short', TS_SINGLE, TZ_SINGLE)).toBe('2023-03-05');
    });
  });

  describe('When the local mode is rendered (host zone = UTC)', () => {
    it('Then the host-zone wall clock is shown without an offset', () => {
      // Arrange + Act + Assert — 1700000100 in UTC is 2023-11-14 22:15:00.
      expect(fmt('local')).toBe('Tue Nov 14 22:15:00 2023');
    });
  });
});

describe('Given formatDate over the now-dependent modes', () => {
  describe('When relative is rendered', () => {
    it('Then it delegates to the relative cascade', () => {
      // Arrange + Act + Assert — now = then + 5 hours.
      expect(formatDate({ kind: 'relative' }, TS, TZ, TS + 5 * 3600)).toBe('5 hours ago');
    });
  });

  describe('When human is rendered', () => {
    it('Then it delegates to the human format', () => {
      // Arrange + Act + Assert — now is the same calendar day, +5 hours later.
      expect(formatDate({ kind: 'human' }, TS, TZ, TS + 5 * 3600)).toBe('5 hours ago');
    });
  });

  describe('When a strftime format is rendered', () => {
    it('Then it delegates to strftime over the own-zone wall clock', () => {
      // Arrange + Act + Assert
      expect(formatDate({ kind: 'strftime', format: '%Y/%m/%d %H:%M' }, TS, TZ, NOW)).toBe(
        '2023/11/15 00:15',
      );
    });
  });
});
