import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type IniSection,
  parseIniSections,
} from '../../../../src/application/primitives/config-read.js';
import { setConfigEntryInText } from '../../../../src/application/primitives/update-config.js';
import { subsectionName } from './arbitraries.js';

const findValue = (
  sections: ReadonlyArray<IniSection>,
  section: string,
  key: string,
): string | null | undefined => {
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

/**
 * Arbitrary for a valid config key: first char alpha, rest alnum or dash,
 * total length 1–16.  Kept local here since this file doesn't share generators
 * with config-read.properties.test.ts (different lens).
 */
const arbConfigKey = (): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.oneof(
        fc.integer({ min: 0x41, max: 0x5a }).map((cp) => String.fromCodePoint(cp)), // A–Z
        fc.integer({ min: 0x61, max: 0x7a }).map((cp) => String.fromCodePoint(cp)), // a–z
      ),
      fc.array(
        fc.oneof(
          fc.integer({ min: 0x41, max: 0x5a }).map((cp) => String.fromCodePoint(cp)),
          fc.integer({ min: 0x61, max: 0x7a }).map((cp) => String.fromCodePoint(cp)),
          fc.integer({ min: 0x30, max: 0x39 }).map((cp) => String.fromCodePoint(cp)),
          fc.constant('-'),
        ),
        { minLength: 0, maxLength: 15 },
      ),
    )
    .map(([first, rest]) => first + rest.join(''));

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

  describe('Given an arbitrary subsection name', () => {
    describe('When the subsection is rendered into config text and re-parsed via parseIniSections', () => {
      it('Then the parsed subsection equals the original input', () => {
        // Arrange + Act + Assert — render-then-parse round-trip: `setConfigEntryInText`
        // is the writer (sut), `parseIniSections` is the reader; the round-trip must
        // recover exactly the original subsection string for every LF/NUL-free input.
        const sut = setConfigEntryInText;
        fc.assert(
          fc.property(subsectionName(), (s) => {
            const text = sut('', 'test', s, 'k', 'v');
            const sections = parseIniSections(text);
            expect(sections).toHaveLength(1);
            const parsed = sections[0];
            expect(parsed?.section).toBe('test');
            expect(parsed?.subsection).toBe(s);
          }),
          { numRuns: 200 },
        );
      });
    });

    describe('When the subsection is rendered into config text', () => {
      it('Then parseIniSections does not throw and returns an array', () => {
        // Arrange + Act + Assert — totality property: the strict quoted-grammar
        // must never reject the writer's output over the full LF/NUL-free domain;
        // a thrown CONFIG_PARSE_ERROR is shrunk and reported independently from
        // the equality failure in the round-trip property above.
        const sut = setConfigEntryInText;
        fc.assert(
          fc.property(subsectionName(), (s) => {
            const text = sut('', 'test', s, 'k', 'v');
            const result = parseIniSections(text);
            expect(Array.isArray(result)).toBe(true);
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given a config text with a valueless entry and an unrelated key', () => {
    describe('When setConfigEntryInText sets the unrelated key', () => {
      it('Then the valueless physical line survives byte-for-byte in the output', () => {
        // Arrange
        const sut = setConfigEntryInText;

        // Act + Assert — fast-check invokes the predicate per sample; each call
        // sets an unrelated key and checks the valueless line is left verbatim.
        fc.assert(
          fc.property(arbConfigKey(), arbConfigKey(), (valuelessKey, otherKey) => {
            fc.pre(valuelessKey.toLowerCase() !== otherKey.toLowerCase());
            const valuelessLine = `\t${valuelessKey}`;
            const inputText = `[a]\n${valuelessLine}\n\texisting = old\n`;
            const result = sut(inputText, 'a', undefined, otherKey, 'new');
            const lines = result.split('\n');
            expect(lines).toContain(valuelessLine);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
