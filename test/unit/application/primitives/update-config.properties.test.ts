import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type IniSection,
  parseIniSections,
} from '../../../../src/application/primitives/config-read.js';
import { setConfigEntryInText } from '../../../../src/application/primitives/update-config.js';

const findValue = (
  sections: ReadonlyArray<IniSection>,
  section: string,
  key: string,
): string | undefined => {
  for (const sec of sections) {
    if (sec.section.toLowerCase() !== section) continue;
    for (const entry of sec.entries) {
      if (entry.key.toLowerCase() === key) return entry.value;
    }
  }
  return undefined;
};

/**
 * Characters that exercise every grammar branch of the writer and reader:
 * quote triggers (CR, leading/trailing space, `;`, `#`), unconditional escape
 * targets (`\`, `"`, LF, TAB), and raw control bytes (C0, DEL).
 */
const SPECIAL_CHARS = [
  '\r', // CR — quote trigger, written raw inside quotes
  '\t', // TAB — always escaped to `\t`
  '\n', // LF — always escaped to `\n`
  '"', // double-quote — always escaped to `\"`
  '\\', // backslash — always escaped to `\\` (first)
  ';', // comment trigger — quote trigger
  '#', // comment trigger — quote trigger
  ' ', // space — quote trigger at leading/trailing edges
  '\x01', // C0 control — passed through raw
  '\x7f', // DEL — passed through raw
];

/**
 * Single-character arbitrary biased toward grammar-exercising special chars
 * plus ordinary printable ASCII so shrunk counterexamples stay readable.
 */
const arbNulFreeUnit = (): fc.Arbitrary<string> =>
  fc.oneof(
    fc.constantFrom(...SPECIAL_CHARS),
    fc.integer({ min: 0x20, max: 0x7e }).map((cp) => String.fromCodePoint(cp)),
  );

/**
 * Generator over the full NUL-free string domain (up to 1024 chars).
 * Combines a full-unicode binary-unit generator (NUL stripped) with a
 * specials-biased generator so shrunk counterexamples stay readable and
 * grammar branch coverage is high.
 */
const arbNulFreeValue = (): fc.Arbitrary<string> => {
  // Wide: full unicode with NUL stripped.
  const wide = fc.string({ unit: 'binary', maxLength: 1024 }).map((s) => s.replace(/\0/g, ''));

  // Biased: strings built from grammar-exercising specials + printable ASCII.
  const biased = fc.string({ unit: arbNulFreeUnit(), maxLength: 1024 });

  return fc.oneof(wide, biased);
};

describe('update-config writer properties', () => {
  describe('Given an arbitrary NUL-free value', () => {
    describe('When the value is rendered into config text and re-parsed via parseIniSections', () => {
      it('Then the parsed value equals the original input', () => {
        // Arrange + Act + Assert — round-trip is `write → parse`; the parser
        // decodes git's quoted-value grammar itself.
        fc.assert(
          fc.property(arbNulFreeValue(), (value) => {
            const text = setConfigEntryInText('', 'user', undefined, 'name', value);
            const parsed = parseIniSections(text);
            const result = findValue(parsed, 'user', 'name');
            expect(result).toBe(value);
          }),
          { numRuns: 200 },
        );
      });
    });

    describe('When the value is rendered into config text', () => {
      it('Then parseIniSections does not throw and returns exactly one entry', () => {
        // Arrange + Act + Assert — totality property: a thrown CONFIG_PARSE_ERROR
        // is distinguishable from a value mismatch (separate property so
        // fast-check shrinks the throw path independently from the equality path).
        fc.assert(
          fc.property(arbNulFreeValue(), (value) => {
            const text = setConfigEntryInText('', 'user', undefined, 'name', value);
            const sections = parseIniSections(text);
            expect(sections).toHaveLength(1);
            const entries = sections[0]?.entries;
            expect(entries).toHaveLength(1);
          }),
          { numRuns: 200 },
        );
      });
    });
  });
});
