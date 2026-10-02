import { describe, expect, it } from 'vitest';

import {
  configExpiryCutoff,
  expiryCutoff,
} from '../../../../src/application/primitives/expiry-cutoff.js';
import { TsgitError } from '../../../../src/domain/error.js';

describe('expiryCutoff', () => {
  describe('Given gc.pruneExpire is "never"', () => {
    describe('When resolving the cutoff', () => {
      it('Then the cutoff is negative infinity, so nothing is ever <= it', () => {
        // Arrange
        const sut = expiryCutoff;

        // Act
        const result = sut('never', { now: () => 1_787_755_416_000 });

        // Assert
        expect(result).toBe(Number.NEGATIVE_INFINITY);
        expect(1 > result).toBe(true);
      });
    });
  });

  describe('Given gc.pruneExpire is "never" with surrounding whitespace', () => {
    describe('When resolving the cutoff', () => {
      it('Then it still resolves to negative infinity — the value is trimmed first', () => {
        // Arrange
        const sut = expiryCutoff;

        // Act
        const result = sut('  never  ', { now: () => 1_787_755_416_000 });

        // Assert
        expect(result).toBe(Number.NEGATIVE_INFINITY);
      });
    });
  });

  describe('Given gc.pruneExpire is "now"', () => {
    describe('When resolving the cutoff', () => {
      it('Then the cutoff is positive infinity — git expires even future-dated state', () => {
        // Arrange — git maps `now` (and `all`) to the maximum time, not the
        // clock: an mtime a year ahead still falls before the cutoff.
        const sut = expiryCutoff;

        // Act
        const result = sut('now', { now: () => 1_787_755_416_000 });

        // Assert
        expect(result).toBe(Number.POSITIVE_INFINITY);
      });
    });
  });

  describe('Given gc.pruneExpire is "false"', () => {
    describe('When resolving the cutoff', () => {
      it('Then it resolves to negative infinity — the git synonym for never', () => {
        // Arrange
        const sut = expiryCutoff;

        // Act
        const result = sut('false', { now: () => 1_787_755_416_000 });

        // Assert
        expect(result).toBe(Number.NEGATIVE_INFINITY);
      });
    });
  });

  describe('Given gc.pruneExpire is "all"', () => {
    describe('When resolving the cutoff', () => {
      it('Then the cutoff is positive infinity', () => {
        // Arrange
        const sut = expiryCutoff;

        // Act
        const result = sut('all', { now: () => 1_787_755_416_000 });

        // Assert
        expect(result).toBe(Number.POSITIVE_INFINITY);
      });
    });
  });

  describe('Given gc.pruneExpire is "FALSE" in uppercase', () => {
    describe('When resolving the cutoff', () => {
      it('Then it refuses — the false/all keywords are exact-match, as in git', () => {
        // Arrange
        const sut = expiryCutoff;

        // Act
        let caught: unknown;
        try {
          sut('FALSE', { now: () => 1_787_755_416_000 });
        } catch (err) {
          caught = err;
        }

        // Assert — no config-file token here, so no located fields either.
        const data = (caught as TsgitError).data;
        expect(data).toEqual({ code: 'CONFIG_BAD_DATE_VALUE', value: 'FALSE' });
        expect('key' in data).toBe(false);
      });
    });
  });

  describe('Given gc.pruneExpire is an @<epoch> literal', () => {
    describe('When resolving the cutoff', () => {
      it('Then the cutoff equals the epoch verbatim, independent of the clock', () => {
        // Arrange
        const sut = expiryCutoff;

        // Act
        const result = sut('@1700000000', { now: () => 0 });

        // Assert
        expect(result).toBe(1_700_000_000);
      });
    });
  });

  describe('Given gc.pruneExpire is an ISO-8601 date', () => {
    describe('When resolving the cutoff', () => {
      it('Then the cutoff equals local midnight of that day', () => {
        // Arrange
        const sut = expiryCutoff;
        const expected = Math.floor(new Date(2026, 0, 1, 0, 0, 0).getTime() / 1000);

        // Act
        const result = sut('2026-01-01', { now: () => 1_787_755_416_000 });

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given gc.pruneExpire is "2.weeks.ago"', () => {
    describe('When resolving the cutoff', () => {
      it('Then the cutoff is two weeks before the clock reading', () => {
        // Arrange
        const sut = expiryCutoff;
        const nowMs = 1_787_755_416_000;
        const nowSeconds = Math.floor(nowMs / 1000);
        const twoWeeksSeconds = 2 * 7 * 86_400;

        // Act
        const result = sut('2.weeks.ago', { now: () => nowMs });

        // Assert
        expect(result).toBe(nowSeconds - twoWeeksSeconds);
      });
    });
  });

  describe('Given gc.pruneExpire is an unsupported expression', () => {
    describe('When resolving the cutoff', () => {
      it('Then it refuses, carrying the offending value in .data', () => {
        // Arrange
        const sut = expiryCutoff;

        // Act
        let caught: unknown;
        try {
          sut('3 fortnights ago', { now: () => 0 });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('CONFIG_BAD_DATE_VALUE');
        if (data.code === 'CONFIG_BAD_DATE_VALUE') {
          expect(data.value).toBe('3 fortnights ago');
          expect('key' in data).toBe(false);
        }
      });
    });
  });

  describe('Given the clock is a millisecond clock', () => {
    describe('When resolving a relative-form cutoff', () => {
      it('Then the returned cutoff is in seconds, not milliseconds', () => {
        // Arrange
        const sut = expiryCutoff;
        const nowMs = 1_787_755_416_789; // deliberately not a whole second
        const nowSeconds = Math.floor(nowMs / 1000);

        // Act — a relative form: `now` itself maps to +Infinity by grammar.
        const result = sut('0.seconds.ago', { now: () => nowMs });

        // Assert
        expect(result).toBe(nowSeconds);
        expect(result).not.toBe(nowMs);
      });
    });
  });

  describe('Given no clock override', () => {
    describe('When resolving a relative-form cutoff', () => {
      it('Then it falls back to Date.now, converted to seconds', () => {
        // Arrange
        const sut = expiryCutoff;
        const before = Math.floor(Date.now() / 1000);

        // Act
        const result = sut('0.seconds.ago');

        // Assert
        const after = Math.floor(Date.now() / 1000);
        expect(result).toBeGreaterThanOrEqual(before);
        expect(result).toBeLessThanOrEqual(after);
      });
    });
  });
});

const CONFIG_NOW_MS = 1_787_755_416_000;
const CONFIG_NOW_SECONDS = CONFIG_NOW_MS / 1000;
const DAY_SECONDS = 86_400;

const refusalOf = (raw: string): unknown => {
  try {
    configExpiryCutoff(raw, { now: () => CONFIG_NOW_MS });
  } catch (err) {
    return err;
  }
  return undefined;
};

describe('configExpiryCutoff', () => {
  describe('Given the value "now"', () => {
    describe('When resolving the cutoff', () => {
      it('Then the cutoff is positive infinity', () => {
        // Arrange
        const sut = configExpiryCutoff;

        // Act
        const result = sut('now', { now: () => CONFIG_NOW_MS });

        // Assert
        expect(result).toBe(Number.POSITIVE_INFINITY);
      });
    });
  });

  describe('Given the value "never" in any case or padding', () => {
    describe('When resolving the cutoff', () => {
      it('Then the cutoff is negative infinity', () => {
        // Arrange
        const sut = configExpiryCutoff;

        // Act
        const result = ['never', 'NEVER', '  never'].map((raw) =>
          sut(raw, { now: () => CONFIG_NOW_MS }),
        );

        // Assert
        expect(result).toEqual([
          Number.NEGATIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
        ]);
      });
    });
  });

  describe('Given a relative date in the past', () => {
    describe('When resolving the cutoff', () => {
      it('Then the cutoff is that moment in seconds', () => {
        // Arrange
        const sut = configExpiryCutoff;

        // Act
        const result = sut('1.day.ago', { now: () => CONFIG_NOW_MS });

        // Assert
        expect(result).toBe(CONFIG_NOW_SECONDS - DAY_SECONDS);
      });
    });
  });

  describe('Given a value that resolves to the present itself', () => {
    describe('When resolving the cutoff', () => {
      it('Then it refuses as git does for any expiry not strictly in the past', () => {
        // Arrange
        const sut = refusalOf;

        // Act
        const result = sut(`@${CONFIG_NOW_SECONDS}`);

        // Assert
        expect((result as TsgitError).data).toEqual({
          code: 'CONFIG_BAD_DATE_VALUE',
          value: `@${CONFIG_NOW_SECONDS}`,
        });
      });
    });
  });

  describe('Given a date in the future', () => {
    describe('When resolving the cutoff', () => {
      it('Then it refuses', () => {
        // Arrange
        const sut = refusalOf;

        // Act
        const result = sut('2099-01-01');

        // Assert
        expect((result as TsgitError).data).toEqual({
          code: 'CONFIG_BAD_DATE_VALUE',
          value: '2099-01-01',
        });
      });
    });
  });

  describe('Given the reflog-only keywords "all" and "false"', () => {
    describe('When resolving the cutoff', () => {
      it('Then each refuses as git does for a config expiry', () => {
        // Arrange
        const sut = refusalOf;

        // Act
        const result = ['all', 'false'].map((raw) => (sut(raw) as TsgitError).data);

        // Assert
        expect(result).toEqual([
          { code: 'CONFIG_BAD_DATE_VALUE', value: 'all' },
          { code: 'CONFIG_BAD_DATE_VALUE', value: 'false' },
        ]);
      });
    });
  });

  describe('Given an unparseable value', () => {
    describe('When resolving the cutoff', () => {
      it('Then it refuses', () => {
        // Arrange
        const sut = refusalOf;

        // Act
        const result = sut('bogus');

        // Assert
        expect((result as TsgitError).data).toEqual({
          code: 'CONFIG_BAD_DATE_VALUE',
          value: 'bogus',
        });
      });
    });
  });

  describe('Given no clock override', () => {
    describe('When resolving a relative date', () => {
      it('Then it falls back to Date.now, converted to seconds', () => {
        // Arrange
        const sut = configExpiryCutoff;
        const before = Math.floor(Date.now() / 1000);

        // Act
        const result = sut('1.day.ago');

        // Assert
        const after = Math.floor(Date.now() / 1000);
        expect(result).toBeGreaterThanOrEqual(before - DAY_SECONDS);
        expect(result).toBeLessThanOrEqual(after - DAY_SECONDS);
      });
    });
  });
});
