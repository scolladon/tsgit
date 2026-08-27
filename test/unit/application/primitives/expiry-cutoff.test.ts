import { describe, expect, it } from 'vitest';

import { expiryCutoff } from '../../../../src/application/primitives/expiry-cutoff.js';
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

  describe('Given gc.pruneExpire is "now"', () => {
    describe('When resolving the cutoff', () => {
      it('Then the cutoff equals the clock reading in seconds', () => {
        // Arrange
        const sut = expiryCutoff;

        // Act
        const result = sut('now', { now: () => 1_787_755_416_000 });

        // Assert
        expect(result).toBe(1_787_755_416);
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

        // Act
        const result = sut('now', { now: () => nowMs });

        // Assert
        expect(result).toBe(nowSeconds);
        expect(result).not.toBe(nowMs);
      });
    });
  });

  describe('Given no clock override', () => {
    describe('When resolving "now"', () => {
      it('Then it falls back to Date.now, converted to seconds', () => {
        // Arrange
        const sut = expiryCutoff;
        const before = Math.floor(Date.now() / 1000);

        // Act
        const result = sut('now');

        // Assert
        const after = Math.floor(Date.now() / 1000);
        expect(result).toBeGreaterThanOrEqual(before);
        expect(result).toBeLessThanOrEqual(after);
      });
    });
  });
});
