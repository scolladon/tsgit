import { describe, expect, it } from 'vitest';

import { configExpiryCutoff } from '../../../../src/application/primitives/expiry-cutoff.js';
import type { TsgitError } from '../../../../src/domain/error.js';

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
