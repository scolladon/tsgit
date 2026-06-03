import { describe, expect, it } from 'vitest';

import { strftime } from '../../../../src/domain/show/strftime.js';

// 1700000100 in +0200 → 2023-11-15 00:15:00 (Wednesday).
const TS = 1_700_000_100;
const TZ = '+0200';
const at = (format: string): string => strftime(format, TS, TZ);

describe('Given strftime over the own-zone wall clock', () => {
  describe('When numeric conversions are used', () => {
    it('Then year/month/day/time render zero-padded', () => {
      // Arrange + Act + Assert
      expect(at('%Y/%m/%d %H:%M:%S')).toBe('2023/11/15 00:15:00');
      expect(at('%y')).toBe('23');
    });
  });

  describe('When name conversions are used', () => {
    it('Then weekday and month names render', () => {
      // Arrange + Act + Assert
      expect(at('%a %A %b %B')).toBe('Wed Wednesday Nov November');
    });
  });

  describe('When the 12-hour clock conversions are used', () => {
    it('Then midnight renders as 12 AM', () => {
      // Arrange + Act + Assert
      expect(at('%I %p')).toBe('12 AM');
    });
  });

  describe('When the space-padded day and timezone are used', () => {
    it('Then %e space-pads and %z echoes the offset', () => {
      // Arrange + Act + Assert
      expect(strftime('%e|%z', 1_678_007_223, '+0530')).toBe(' 5|+0530');
    });
  });

  describe('When literals and escapes are used', () => {
    it('Then %% %n %t render their literals', () => {
      // Arrange + Act + Assert
      expect(at('%%%n%t')).toBe('%\n\t');
    });
  });

  describe('When an unknown conversion is used', () => {
    it('Then it is emitted verbatim, never dropped', () => {
      // Arrange + Act + Assert
      expect(at('[%Q]')).toBe('[%Q]');
    });
  });

  describe('When a trailing percent has no conversion char', () => {
    it('Then the dangling percent is emitted verbatim', () => {
      // Arrange + Act + Assert
      expect(at('end%')).toBe('end%');
    });
  });
});
