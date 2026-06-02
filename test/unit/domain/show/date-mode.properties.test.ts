import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { formatDate } from '../../../../src/domain/show/date-mode.js';
import { formatRelativeDate } from '../../../../src/domain/show/date-relative.js';
import { arbTimestamp, arbTimezoneOffset } from './arbitraries.js';

const ISO_STRICT = /^(-?\d+)-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/;

const RELATIVE_GRAMMAR =
  /^(in the future|\d+ seconds? ago|\d+ minutes? ago|\d+ hours? ago|\d+ days? ago|\d+ weeks? ago|\d+ months? ago|\d+ years? ago|\d+ years?, \d+ months? ago)$/;

describe('Given an arbitrary timestamp and offset', () => {
  describe('When iso-strict is formatted', () => {
    it('Then it matches the grammar and round-trips to the original instant', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbTimestamp(), arbTimezoneOffset(), (timestamp, offset) => {
          const sut = formatDate({ kind: 'iso-strict' }, timestamp, offset, 0);
          const m = ISO_STRICT.exec(sut);
          expect(m).not.toBeNull();
          const [, year, mon, day, hh, mm, ss, off] = m as RegExpMatchArray;
          const offsetStr = off as string;
          const sign = offsetStr.startsWith('-') ? -1 : 1;
          const offsetSeconds =
            offsetStr === 'Z'
              ? 0
              : sign * (Number(offsetStr.slice(1, 3)) * 3600 + Number(offsetStr.slice(4, 6)) * 60);
          const wallClock = Date.UTC(
            Number(year),
            Number(mon) - 1,
            Number(day),
            Number(hh),
            Number(mm),
            Number(ss),
          );
          expect(wallClock / 1000 - offsetSeconds).toBe(timestamp);
        }),
        { numRuns: 200 },
      );
    });
  });
});

describe('Given an arbitrary (then, now) pair', () => {
  describe('When the relative date is formatted', () => {
    it('Then it always matches the relative grammar and is "ago" iff now >= then', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbTimestamp(), arbTimestamp(), (then, now) => {
          const sut = formatRelativeDate(then, now);
          expect(sut).toMatch(RELATIVE_GRAMMAR);
          expect(sut === 'in the future').toBe(now < then);
        }),
        { numRuns: 100 },
      );
    });
  });
});
