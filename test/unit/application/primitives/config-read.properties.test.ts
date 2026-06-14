import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  parseIniSections,
  scanHeaderPrefix,
} from '../../../../src/application/primitives/config-read.js';
import { TsgitError } from '../../../../src/domain/error.js';
import { arbConfigKey, arbHeaderIdentity } from './arbitraries.js';

/**
 * A grammar-safe config value: 1–12 printable ASCII chars with no characters
 * that would trigger quoting or comment parsing, so the round-trip stays exact.
 */
const arbSafeValue = (): fc.Arbitrary<string> =>
  fc.string({
    unit: fc.integer({ min: 0x21, max: 0x7e }).map((cp) => {
      const ch = String.fromCodePoint(cp);
      return ch === '\\' || ch === '"' || ch === '#' || ch === ';' || ch === '=' ? 'x' : ch;
    }),
    minLength: 1,
    maxLength: 12,
  });

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

/** Header text for an identity whose subsection (when present) is quote-safe. */
const headerText = (section: string, subsection: string | undefined): string => {
  if (subsection === undefined) return `[${section}]`;
  return `[${section} "${subsection}"]`;
};

/**
 * Header identities restricted to quote/backslash-free subsections so a literal
 * `[s "sub"]` round-trips without re-deriving git's subsection escaping.
 */
const arbSafeHeaderIdentity = (): ReturnType<typeof arbHeaderIdentity> =>
  arbHeaderIdentity().filter(
    ({ subsection }) => subsection === undefined || !/["\\\]\r\n#;]/.test(subsection),
  );

describe('config-read same-line and orphan grammar properties', () => {
  describe('Given an arbitrary header identity, a valid key, and a safe value', () => {
    describe('When parseIniSections parses the header with a same-line entry', () => {
      it('Then the section records the key/value (round-trip), and the no-`=` form records null', () => {
        // Arrange
        const sut = parseIniSections;

        // Act + Assert
        fc.assert(
          fc.property(
            arbSafeHeaderIdentity(),
            arbConfigKey(),
            arbSafeValue(),
            ({ section, subsection }, key, value) => {
              const header = headerText(section, subsection);
              const valued = sut(`${header} ${key} = ${value}\n`);
              expect(valued).toHaveLength(1);
              expect(valued[0]).toEqual({
                section,
                subsection,
                entries: [{ key, value }],
              });
              const valueless = sut(`${header} ${key}\n`);
              expect(valueless).toHaveLength(1);
              expect(valueless[0]).toEqual({
                section,
                subsection,
                entries: [{ key, value: null }],
              });
            },
          ),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary key built across the alpha/alnum-dash boundary', () => {
    describe('When parseIniSections scans it under a header', () => {
      it('Then it either records the key or throws exactly CONFIG_PARSE_ERROR (totality)', () => {
        // Arrange — partition over first-char-alpha vs the alnum-dash body set,
        // mixed with junk so both the accept and reject arms are exercised.
        const sut = parseIniSections;
        const arbKeyChar = fc
          .integer({ min: 0x21, max: 0x7e })
          .map((cp) => String.fromCodePoint(cp));
        const arbScannedLine = fc
          .array(arbKeyChar, { minLength: 1, maxLength: 8 })
          .map((cs) => cs.join(''));

        // Act + Assert
        fc.assert(
          fc.property(arbScannedLine, (raw) => {
            try {
              const result = sut(`[a]\n\t${raw}\n`);
              // `raw` may itself be a valid header (e.g. `[b]`), yielding a
              // second indented section; totality only requires well-shaped
              // entries across every section, never a fixed section count.
              for (const section of result) {
                for (const entry of section.entries) {
                  expect(typeof entry.key).toBe('string');
                  expect(entry.value === null || typeof entry.value === 'string').toBe(true);
                }
              }
            } catch (err) {
              if (!(err instanceof TsgitError)) throw err;
              expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
            }
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a parsed same-line or orphan file re-rendered to canonical form', () => {
    describe('When parseIniSections re-parses the rendering', () => {
      it('Then the section structure is stable (idempotence)', () => {
        // Arrange — a small renderer that emits the canonical `[s]\n\tkey = v`
        // (or bare orphan) shape, then proves re-parsing is a fixpoint.
        const sut = parseIniSections;
        const rerender = (sections: ReturnType<typeof parseIniSections>): string =>
          sections
            .map((s) => {
              const body = s.entries
                .map((e) => (e.value === null ? `\t${e.key}\n` : `\t${e.key} = ${e.value}\n`))
                .join('');
              if (s.section === '' && s.subsection === undefined) {
                return s.entries
                  .map((e) => (e.value === null ? `${e.key}\n` : `${e.key} = ${e.value}\n`))
                  .join('');
              }
              const header =
                s.subsection === undefined ? `[${s.section}]` : `[${s.section} "${s.subsection}"]`;
              return `${header}\n${body}`;
            })
            .join('');

        const arbInput = fc.oneof(
          // same-line valued
          fc
            .tuple(arbSafeHeaderIdentity(), arbConfigKey(), arbSafeValue())
            .map(
              ([{ section, subsection }, k, v]) =>
                `${headerText(section, subsection)} ${k} = ${v}\n`,
            ),
          // bare orphan
          fc.tuple(arbConfigKey(), arbSafeValue()).map(([k, v]) => `${k} = ${v}\n`),
        );

        // Act + Assert
        fc.assert(
          fc.property(arbInput, (input) => {
            const once = sut(input);
            const twice = sut(rerender(once));
            expect(twice).toEqual(once);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});

/**
 * Section-name characters spanning the accept grammar (letters/digits/`.`/`-`)
 * and the reject grammar (`_`/space) so a bracketed line lands on either arm.
 */
const arbSectionNameChar = (): fc.Arbitrary<string> =>
  fc.oneof(
    arbAlpha(),
    fc.integer({ min: 0x30, max: 0x39 }).map((cp) => String.fromCodePoint(cp)), // 0–9
    fc.constantFrom('.', '-', '_', ' '),
  );

describe('config-read section-name totality property', () => {
  describe('Given an arbitrary bracketed ASCII-no-NUL line `[<chars>]`', () => {
    describe('When scanHeaderPrefix and parseIniSections classify it', () => {
      it('Then it is recognised as a header OR refused with CONFIG_PARSE_ERROR, never silently section-absent', () => {
        // Arrange
        const sut = scanHeaderPrefix;
        const arbBracketedLine = fc
          .array(arbSectionNameChar(), { minLength: 0, maxLength: 8 })
          .map((chars) => `[${chars.join('')}]`);

        // Act + Assert — for every sample, the disjunction must hold: a header
        // parse is the accept arm; otherwise parseIniSections must throw, so the
        // grammar is total and no bracketed line silently drops to section-absent.
        fc.assert(
          fc.property(arbBracketedLine, (line) => {
            if (sut(line).parse.kind === 'header') return;
            try {
              parseIniSections(`${line}\n`);
              return false;
            } catch (err) {
              if (!(err instanceof TsgitError)) throw err;
              expect(err.data.code).toBe('CONFIG_PARSE_ERROR');
              return true;
            }
          }),
          { numRuns: 50 },
        );
      });
    });
  });
});
