import { describe, expect, it } from 'vitest';

import { parseGitInt } from '../../../../src/application/primitives/config-read.js';

describe('parseGitInt', () => {
  describe('Given decimal values', () => {
    describe('When parsed', () => {
      it.each([
        ['10', 10],
        ['+5', 5],
        ['-7', -7],
        [' 5', 5],
        ['\t5', 5],
        // multiple leading spaces: pins the `+` quantifier on the leading-whitespace
        // trim — a single-char trim would leave " 5", yielding invalid unit.
        ['  5', 5],
        // same `+`-quantifier probe for the tab class.
        ['\t\t5', 5],
      ])('Then `%s` returns ok with value %s', (raw, expected) => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut(raw);

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(expected);
      });
    });
  });

  describe('Given hexadecimal values', () => {
    describe('When parsed', () => {
      it.each([
        ['0x10', 16],
        ['0X10', 16],
        // INT32_MAX in hex.
        ['0x7fffffff', 2147483647],
      ])('Then `%s` returns ok with value %s', (raw, expected) => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut(raw);

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(expected);
      });
    });
  });

  describe('Given unit suffix values', () => {
    describe('When parsed', () => {
      it.each([
        ['1k', 1024],
        ['1K', 1024],
        ['1m', 1048576],
        ['1M', 1048576],
        ['1g', 1073741824],
        ['1G', 1073741824],
        ['2g', 2147483648],
      ])('Then `%s` returns ok with value %s', (raw, expected) => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut(raw);

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(expected);
      });
    });
  });

  describe('Given trailing garbage (invalid unit)', () => {
    describe('When parsed', () => {
      it.each([
        ['5 '], // trailing space
        ['1kb'], // multi-char unit
        ['1.5'], // decimal fraction
        ['1t'], // unsupported t unit
        ['1T'], // unsupported T unit
      ])('Then `%s` returns not-ok with reason invalid unit', (raw) => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut(raw);

        // Assert
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('invalid unit');
      });
    });
  });

  describe('Given no digits (empty / valueless)', () => {
    describe('When parsed', () => {
      it.each([
        [''], // empty string
        [null], // valueless
        ['abc'], // no digits at all
        [' '], // only whitespace
      ])('Then `%s` returns not-ok with reason invalid unit', (raw) => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut(raw);

        // Assert
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('invalid unit');
      });
    });
  });

  describe('Given out-of-range magnitude (pinned against git 2.54.0 --type=int: intmax_t = int64_t range)', () => {
    describe('When parsed', () => {
      it.each([
        ['9223372036854775808'], // INT64_MAX + 1, out of range
        ['-9223372036854775809'], // INT64_MIN - 1, out of range
        ['9999999999999999999999'], // overflows strtoimax
      ])('Then `%s` returns not-ok with reason out of range', (raw) => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut(raw);

        // Assert
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('out of range');
      });
    });

    describe('When parsing "9223372036854775807" (INT64_MAX, valid boundary)', () => {
      it('Then returns ok with the correct number (precision within JS float64)', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('9223372036854775807');

        // Assert — Number(BigInt(INT64_MAX)) is the JS float64 nearest representation
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(Number(BigInt('9223372036854775807')));
      });
    });

    describe('When parsing "-9223372036854775808" (INT64_MIN, valid boundary)', () => {
      it('Then returns ok with the correct number (precision within JS float64)', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('-9223372036854775808');

        // Assert — Number(BigInt(INT64_MIN)) is the JS float64 nearest representation
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(Number(BigInt('-9223372036854775808')));
      });
    });
  });

  describe('Given octal (leading-zero, base-0) values (pinned against git 2.54.0)', () => {
    describe('When parsed', () => {
      it.each([
        ['010', 8], // octal eight
        ['017', 15], // octal fifteen
        ['0', 0], // zero
        ['-010', -8], // negative octal
      ])('Then `%s` returns ok with value %s', (raw, expected) => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut(raw);

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(expected);
      });
    });

    describe('When parsing "08" (8 is not an octal digit)', () => {
      it('Then returns not-ok with reason invalid unit', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('08');

        // Assert — strtoimax reads octal "0", leaving "8" as a non-unit suffix
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('invalid unit');
      });
    });
  });

  describe('Given pathological leading zeros and oversized magnitudes', () => {
    describe('When parsing a long all-zeros run (octal zero, not out of range)', () => {
      it('Then returns ok with value 0 without stalling', () => {
        // Arrange
        const sut = parseGitInt;

        // Act — git reads "0…0" as the value 0; the parser must not treat length as magnitude
        const result = sut('0'.repeat(100000));

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(0);
      });
    });

    describe('When parsing a million-digit number (significant length far past int64)', () => {
      it('Then returns not-ok with reason out of range without stalling', () => {
        // Arrange
        const sut = parseGitInt;

        // Act — capped before BigInt so a hostile config value cannot stall the parser
        const result = sut('9'.repeat(1000000));

        // Assert — git also rejects this magnitude as out of range
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('out of range');
      });
    });
  });
});
