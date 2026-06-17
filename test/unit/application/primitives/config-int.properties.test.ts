import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseGitInt } from '../../../../src/application/primitives/config-read.js';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const INT64_MAX = BigInt('9223372036854775807');
const INT64_MIN = BigInt('-9223372036854775808');

/** Valid unit suffixes (k/K/m/M/g/G) with their ×1024^n multiplier. */
const UNIT_MULTIPLIERS = [
  { suffix: 'k', multiplier: BigInt(1024) },
  { suffix: 'K', multiplier: BigInt(1024) },
  { suffix: 'm', multiplier: BigInt(1024) * BigInt(1024) },
  { suffix: 'M', multiplier: BigInt(1024) * BigInt(1024) },
  { suffix: 'g', multiplier: BigInt(1024) * BigInt(1024) * BigInt(1024) },
  { suffix: 'G', multiplier: BigInt(1024) * BigInt(1024) * BigInt(1024) },
] as const;

/**
 * Arbitrary over plain decimal integers in the int64 range (no unit suffix).
 * Returns { raw: string, value: number } where raw is the decimal string.
 */
const arbPlainDecimalInRange = (): fc.Arbitrary<{ readonly raw: string; readonly value: number }> =>
  fc
    .bigInt({ min: INT64_MIN, max: INT64_MAX })
    .map((n) => ({ raw: n.toString(), value: Number(n) }));

/**
 * Arbitrary over integers with a valid unit suffix, where the pre-scaled value
 * fits in the int64 range after multiplication.
 *
 * Picks a suffix entry, then picks a base integer such that base × multiplier ≤ INT64_MAX.
 */
const arbUnitSuffixedInRange = (): fc.Arbitrary<{
  readonly raw: string;
  readonly value: number;
}> =>
  fc.constantFrom(...UNIT_MULTIPLIERS).chain(({ suffix, multiplier }) => {
    const maxBase = INT64_MAX / multiplier;
    const minBase = INT64_MIN / multiplier;
    return fc
      .bigInt({ min: minBase, max: maxBase })
      .map((base) => ({ raw: `${base}${suffix}`, value: Number(base * multiplier) }));
  });

/**
 * Arbitrary over a faithful git int string that maps to a number:
 * - plain decimal (with or without leading +/-)
 * - k/K/m/M/g/G suffixed (within int64 range after scaling)
 */
const arbInRangeGitIntString = (): fc.Arbitrary<{
  readonly raw: string;
  readonly value: number;
}> => fc.oneof(arbPlainDecimalInRange(), arbUnitSuffixedInRange());

/**
 * Arbitrary over ASCII strings (printable ASCII + control chars, no constraint on grammar).
 * Used for the totality property: any string must produce a GitIntResult.
 */
const arbAsciiString = (): fc.Arbitrary<string> =>
  fc.string({ unit: fc.integer({ min: 0, max: 127 }).map((cp) => String.fromCodePoint(cp)) });

/**
 * Arbitrary over strings that should yield `reason: 'invalid unit'`:
 * strings with trailing non-unit bytes, multi-char units, or no digits.
 *
 * Three families, each guaranteed to fail:
 * 1. integer + non-unit non-digit suffix char (the trailing char prevents parse)
 * 2. integer + valid unit + another alphabetic char (multi-char unit)
 * 3. pure lowercase alpha string (no digits consumed)
 */
const arbTrailingGarbageString = (): fc.Arbitrary<string> =>
  fc.oneof(
    // Integer followed by a non-unit, non-digit, non-sign trailing char (definitely garbage)
    fc
      .tuple(
        fc.bigInt({ min: INT64_MIN, max: INT64_MAX }).map((n) => n.toString()),
        // Lower-alpha chars excluding k/K/m/M/g/G — these are not units and not digits
        fc.constantFrom(
          'a',
          'b',
          'c',
          'd',
          'e',
          'f',
          'h',
          'i',
          'j',
          'l',
          'n',
          'o',
          'p',
          'q',
          'r',
          's',
        ),
      )
      .map(([n, suffix]) => `${n}${suffix}`),
    // Multi-char unit: valid single unit followed by another lowercase alpha char
    fc
      .tuple(
        fc.bigInt({ min: INT64_MIN, max: INT64_MAX }).map((n) => n.toString()),
        fc.constantFrom('k', 'K', 'm', 'M', 'g', 'G'),
        fc.constantFrom('a', 'b', 'c', 'd', 'e'),
      )
      .map(([n, unit, extra]) => `${n}${unit}${extra}`),
    // No digits at all: pure lowercase alpha string
    fc.string({
      unit: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'h', 'i', 'j', 'l', 'n', 'o', 'p'),
      minLength: 1,
      maxLength: 8,
    }),
  );

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('parseGitInt — property tests', () => {
  describe('Given an arbitrary ASCII string', () => {
    describe('When parseGitInt is called', () => {
      it('Then it never throws and never returns NaN (totality)', () => {
        // Arrange
        const sut = parseGitInt;

        // Act + Assert
        fc.assert(
          fc.property(arbAsciiString(), (raw) => {
            const result = sut(raw);
            if (result.ok) {
              expect(Number.isFinite(result.value)).toBe(true);
            } else {
              expect(['invalid unit', 'out of range']).toContain(result.reason);
            }
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given an arbitrary in-range git int string', () => {
    describe('When parseGitInt is called', () => {
      it('Then it returns ok with the correct numeric value (decode round-trip)', () => {
        // Arrange
        const sut = parseGitInt;

        // Act + Assert
        fc.assert(
          fc.property(arbInRangeGitIntString(), ({ raw, value }) => {
            const result = sut(raw);
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.value).toBe(value);
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary string with trailing non-unit / multi-char unit / no digits', () => {
    describe('When parseGitInt is called', () => {
      it('Then it returns not-ok with reason invalid unit (negative grammar)', () => {
        // Arrange
        const sut = parseGitInt;

        // Act + Assert
        fc.assert(
          fc.property(arbTrailingGarbageString(), (raw) => {
            const result = sut(raw);
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.reason).toBe('invalid unit');
          }),
          { numRuns: 50 },
        );
      });
    });
  });
});
