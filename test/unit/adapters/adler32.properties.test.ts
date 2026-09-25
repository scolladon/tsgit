/**
 * Property test for adler32: pins the NMAX-block deferred-modulo loop as
 * bit-identical to the straightforward one-byte-at-a-time RFC 1950 loop it
 * replaces, across arbitrary payloads and the NMAX block-boundary lengths
 * (the worst case for the deferred sums: every byte is 0xff).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { adler32 } from '../../../src/adapters/adler32.js';
import { arbBytes } from './arbitraries.js';

const ADLER_MOD = 65521;
const NMAX = 5552;
const ROUND_TRIP_NUM_RUNS = 200;

/** Today's one-byte-at-a-time RFC 1950 loop, kept here as an independent
 * oracle: a modulo on every byte instead of once per NMAX-sized block. */
function referenceAdler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % ADLER_MOD;
    b = (b + a) % ADLER_MOD;
  }
  return ((b << 16) | a) >>> 0;
}

describe('Given an arbitrary byte payload', () => {
  describe('When adler32 checksums it', () => {
    it('Then the result matches the reference one-byte-at-a-time loop', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbBytes(), (data) => adler32(data) === referenceAdler32(data)),
        { numRuns: ROUND_TRIP_NUM_RUNS },
      );
    });
  });
});

describe('Given an all-0xff payload at a length spanning an NMAX block boundary', () => {
  describe('When adler32 checksums it', () => {
    it.each([
      { length: NMAX - 1, label: 'one byte short of a full block' },
      { length: NMAX, label: 'exactly one full block' },
      { length: NMAX + 1, label: 'one byte into a second block' },
      { length: 2 * NMAX + 1, label: 'two full blocks plus one byte' },
    ])('Then the result matches the reference loop for $label', ({ length }) => {
      // Arrange
      const data = new Uint8Array(length).fill(0xff);

      // Act
      const result = adler32(data);

      // Assert
      expect(result).toBe(referenceAdler32(data));
    });
  });
});
