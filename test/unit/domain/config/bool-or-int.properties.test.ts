/**
 * Property test for git's bool-or-int grammar: every C-`int` round-trips as
 * an integer (never a boolean), and every case of every boolean word reads
 * as a boolean — the two arms never overlap.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseGitBoolOrInt } from '../../../../src/domain/config/config-ini.js';

const C_INT_MIN = -2_147_483_648;
const C_INT_MAX = 2_147_483_647;

const casedWord = (word: string): fc.Arbitrary<string> =>
  fc
    .array(fc.boolean(), { minLength: word.length, maxLength: word.length })
    .map((upper) => [...word].map((c, i) => (upper[i] ? c.toUpperCase() : c)).join(''));

describe('parseGitBoolOrInt properties', () => {
  describe('Given any C int spelt in decimal', () => {
    describe('When parsed', () => {
      it('Then it round-trips as that integer', () => {
        // Arrange
        const sut = parseGitBoolOrInt;

        // Act & Assert
        fc.assert(
          fc.property(fc.integer({ min: C_INT_MIN, max: C_INT_MAX }), (n) => {
            expect(sut(String(n))).toEqual({ ok: true, value: n, isBool: false });
          }),
        );
      });
    });
  });

  describe('Given any casing of a boolean word', () => {
    describe('When parsed', () => {
      it('Then it reads as the boolean the word names', () => {
        // Arrange
        const sut = parseGitBoolOrInt;
        const words = fc.oneof(
          ...['true', 'yes', 'on'].map((w) => casedWord(w).map((s) => [s, 1] as const)),
          ...['false', 'no', 'off'].map((w) => casedWord(w).map((s) => [s, 0] as const)),
        );

        // Act & Assert
        fc.assert(
          fc.property(words, ([word, value]) => {
            expect(sut(word)).toEqual({ ok: true, value, isBool: true });
          }),
        );
      });
    });
  });
});
