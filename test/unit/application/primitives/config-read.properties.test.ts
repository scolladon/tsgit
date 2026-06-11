import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseIniSections } from '../../../../src/application/primitives/config-read.js';
import { TsgitError } from '../../../../src/domain/error.js';

/** Arbitrary for a single alpha character (A–Z or a–z). */
const arbAlpha = (): fc.Arbitrary<string> =>
  fc.oneof(
    fc.integer({ min: 0x41, max: 0x5a }).map((cp) => String.fromCodePoint(cp)), // A–Z
    fc.integer({ min: 0x61, max: 0x7a }).map((cp) => String.fromCodePoint(cp)), // a–z
  );

/** Arbitrary for a single alnum-or-dash character (valid key body char). */
const arbKeyBodyChar = (): fc.Arbitrary<string> =>
  fc.oneof(
    arbAlpha(),
    fc.integer({ min: 0x30, max: 0x39 }).map((cp) => String.fromCodePoint(cp)), // 0–9
    fc.constant('-'),
  );

/**
 * Arbitrary for a valid config key: first char alpha, rest alnum or dash,
 * total length 1–31 (mirrors VALUELESS_KEY_RE first-capture group).
 */
const arbValidKey = (): fc.Arbitrary<string> =>
  fc
    .tuple(arbAlpha(), fc.array(arbKeyBodyChar(), { minLength: 0, maxLength: 30 }))
    .map(([first, rest]) => first + rest.join(''));

/**
 * Chars that the valueless-key grammar refuses when appended after the key
 * (inside the same line, before the implicit newline).
 */
const JUNK_CHARS = ['!', '_', '.', '+', '~', '@', '?', '$', '%', '^', '&', '*', '(', ')'];

const arbJunkChar = (): fc.Arbitrary<string> => fc.constantFrom(...JUNK_CHARS);

describe('config-read valueless key grammar properties', () => {
  describe('Given an arbitrary valid key', () => {
    describe('When parseIniSections parses [s]\\n\\t<key>\\n', () => {
      it('Then exactly one entry { key, value: null } is recorded (grammar totality)', () => {
        // Arrange
        const sut = parseIniSections;

        // Act + Assert — fast-check invokes the predicate per sample;
        // each call wraps an arbitrary key in a section, parses, and
        // asserts exactly one valueless entry is recorded.
        fc.assert(
          fc.property(arbValidKey(), (key) => {
            const text = `[s]\n\t${key}\n`;
            const sections = sut(text);
            expect(sections).toHaveLength(1);
            const entries = sections[0]?.entries;
            expect(entries).toHaveLength(1);
            expect(entries?.[0]).toEqual({ key, value: null });
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary valid key with a junk character appended', () => {
    describe('When parseIniSections parses [s]\\n<key><junk>\\n', () => {
      it('Then CONFIG_PARSE_ERROR is thrown with .data.line === 2 (negative grammar)', () => {
        // Arrange
        const sut = parseIniSections;

        // Act + Assert — fast-check invokes the predicate per sample;
        // each call builds a junk line, attempts a parse, and asserts the error.
        fc.assert(
          fc.property(arbValidKey(), arbJunkChar(), (key, junk) => {
            const text = `[s]\n${key}${junk}\n`;
            try {
              sut(text);
              return false;
            } catch (err) {
              if (!(err instanceof TsgitError)) throw err;
              expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
              expect(err.data).toMatchObject({ line: 2 });
              return true;
            }
          }),
          { numRuns: 50 },
        );
      });
    });
  });
});
