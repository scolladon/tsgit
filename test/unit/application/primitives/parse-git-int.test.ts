import { describe, expect, it } from 'vitest';

import { parseGitInt } from '../../../../src/application/primitives/config-read.js';

describe('parseGitInt', () => {
  describe('Given decimal values', () => {
    describe('When parsing "10"', () => {
      it('Then returns ok with value 10', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('10');

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(10);
      });
    });

    describe('When parsing "+5"', () => {
      it('Then returns ok with value 5', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('+5');

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(5);
      });
    });

    describe('When parsing "-7"', () => {
      it('Then returns ok with value -7', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('-7');

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(-7);
      });
    });

    describe('When parsing " 5" (leading whitespace)', () => {
      it('Then returns ok with value 5', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut(' 5');

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(5);
      });
    });

    describe('When parsing "\t5" (leading tab)', () => {
      it('Then returns ok with value 5', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('\t5');

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(5);
      });
    });
  });

  describe('Given hexadecimal values', () => {
    describe('When parsing "0x10"', () => {
      it('Then returns ok with value 16', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('0x10');

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(16);
      });
    });

    describe('When parsing "0X10"', () => {
      it('Then returns ok with value 16', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('0X10');

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(16);
      });
    });

    describe('When parsing "0x7fffffff" (INT32_MAX in hex)', () => {
      it('Then returns ok with value 2147483647', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('0x7fffffff');

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(2147483647);
      });
    });
  });

  describe('Given unit suffix values', () => {
    describe('When parsing "1k" (unit k = ×1024)', () => {
      it('Then returns ok with value 1024', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('1k');

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(1024);
      });
    });

    describe('When parsing "1K" (unit K = ×1024, case-insensitive)', () => {
      it('Then returns ok with value 1024', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('1K');

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(1024);
      });
    });

    describe('When parsing "1m" (unit m = ×1024²)', () => {
      it('Then returns ok with value 1048576', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('1m');

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(1048576);
      });
    });

    describe('When parsing "1M" (unit M = ×1024²)', () => {
      it('Then returns ok with value 1048576', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('1M');

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(1048576);
      });
    });

    describe('When parsing "1g" (unit g = ×1024³)', () => {
      it('Then returns ok with value 1073741824', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('1g');

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(1073741824);
      });
    });

    describe('When parsing "1G" (unit G = ×1024³)', () => {
      it('Then returns ok with value 1073741824', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('1G');

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(1073741824);
      });
    });

    describe('When parsing "2g" (= 2×1024³ = 2147483648)', () => {
      it('Then returns ok with value 2147483648', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('2g');

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(2147483648);
      });
    });
  });

  describe('Given trailing garbage (invalid unit)', () => {
    describe('When parsing "5 " (trailing space)', () => {
      it('Then returns not-ok with reason invalid unit', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('5 ');

        // Assert
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('invalid unit');
      });
    });

    describe('When parsing "1kb" (multi-char unit)', () => {
      it('Then returns not-ok with reason invalid unit', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('1kb');

        // Assert
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('invalid unit');
      });
    });

    describe('When parsing "1.5" (decimal fraction)', () => {
      it('Then returns not-ok with reason invalid unit', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('1.5');

        // Assert
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('invalid unit');
      });
    });

    describe('When parsing "1t" (unsupported t unit)', () => {
      it('Then returns not-ok with reason invalid unit', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('1t');

        // Assert
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('invalid unit');
      });
    });

    describe('When parsing "1T" (unsupported T unit)', () => {
      it('Then returns not-ok with reason invalid unit', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('1T');

        // Assert
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('invalid unit');
      });
    });
  });

  describe('Given no digits (empty / valueless)', () => {
    describe('When parsing "" (empty string)', () => {
      it('Then returns not-ok with reason invalid unit', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('');

        // Assert
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('invalid unit');
      });
    });

    describe('When parsing null (valueless)', () => {
      it('Then returns not-ok with reason invalid unit', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut(null);

        // Assert
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('invalid unit');
      });
    });

    describe('When parsing "abc" (no digits at all)', () => {
      it('Then returns not-ok with reason invalid unit', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('abc');

        // Assert
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('invalid unit');
      });
    });

    describe('When parsing " " (only whitespace)', () => {
      it('Then returns not-ok with reason invalid unit', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut(' ');

        // Assert
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('invalid unit');
      });
    });
  });

  describe('Given out-of-range magnitude (pinned against git 2.54.0 --type=int: intmax_t = int64_t range)', () => {
    describe('When parsing "9223372036854775808" (INT64_MAX + 1, out of range)', () => {
      it('Then returns not-ok with reason out of range', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('9223372036854775808');

        // Assert
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('out of range');
      });
    });

    describe('When parsing "-9223372036854775809" (INT64_MIN - 1, out of range)', () => {
      it('Then returns not-ok with reason out of range', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('-9223372036854775809');

        // Assert
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('out of range');
      });
    });

    describe('When parsing "9999999999999999999999" (overflows strtoimax)', () => {
      it('Then returns not-ok with reason out of range', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('9999999999999999999999');

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
    describe('When parsing "010" (octal eight)', () => {
      it('Then returns ok with value 8', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('010');

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(8);
      });
    });

    describe('When parsing "017" (octal fifteen)', () => {
      it('Then returns ok with value 15', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('017');

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(15);
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

    describe('When parsing "0" (zero)', () => {
      it('Then returns ok with value 0', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('0');

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(0);
      });
    });

    describe('When parsing "-010" (negative octal)', () => {
      it('Then returns ok with value -8', () => {
        // Arrange
        const sut = parseGitInt;

        // Act
        const result = sut('-010');

        // Assert
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toBe(-8);
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
