import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  parseGitBoolean,
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
        // Arrange + Act + Assert — fast-check invokes the predicate per sample;
        // each call wraps an arbitrary key in a section, parses, and
        // asserts exactly one valueless entry is recorded.
        fc.assert(
          fc.property(arbValidKey(), (key) => {
            const text = `[s]\n\t${key}\n`;
            const sections = parseIniSections(text);
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
        // Arrange + Act + Assert — fast-check invokes the predicate per sample;
        // each call builds a junk line, attempts a parse, and asserts the error.
        fc.assert(
          fc.property(arbValidKey(), arbJunkChar(), (key, junk) => {
            const text = `[s]\n${key}${junk}\n`;
            try {
              parseIniSections(text);
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
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            arbSafeHeaderIdentity(),
            arbConfigKey(),
            arbSafeValue(),
            ({ section, subsection }, key, value) => {
              const header = headerText(section, subsection);
              const valued = parseIniSections(`${header} ${key} = ${value}\n`);
              expect(valued).toHaveLength(1);
              expect(valued[0]).toEqual({
                section,
                subsection,
                entries: [{ key, value }],
              });
              const valueless = parseIniSections(`${header} ${key}\n`);
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
              const result = parseIniSections(`[a]\n\t${raw}\n`);
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
            const once = parseIniSections(input);
            const twice = parseIniSections(rerender(once));
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
        const arbBracketedLine = fc
          .array(arbSectionNameChar(), { minLength: 0, maxLength: 8 })
          .map((chars) => `[${chars.join('')}]`);

        // Act + Assert — for every sample, the disjunction must hold: a header
        // parse is the accept arm; otherwise parseIniSections must throw, so the
        // grammar is total and no bracketed line silently drops to section-absent.
        fc.assert(
          fc.property(arbBracketedLine, (line) => {
            if (scanHeaderPrefix(line).parse.kind === 'header') return;
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

// git's boolean path narrows to a C `int`; these mirror the production
// GIT_BOOL_INT_MIN/MAX constants without importing them (module-private).
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

/** Unit factors accepted by git's boolean/integer grammar (k/K/m/M/g/G = ×1024^n). */
const UNIT_FACTORS: ReadonlyArray<{ readonly suffix: string; readonly factor: number }> = [
  { suffix: '', factor: 1 },
  { suffix: 'k', factor: 1024 },
  { suffix: 'K', factor: 1024 },
  { suffix: 'm', factor: 1024 * 1024 },
  { suffix: 'M', factor: 1024 * 1024 },
  { suffix: 'g', factor: 1024 * 1024 * 1024 },
  { suffix: 'G', factor: 1024 * 1024 * 1024 },
];

/** Unit factors whose corresponding base magnitude (`n / factor`) is an exact integer. */
const factorsDividing = (
  n: number,
): ReadonlyArray<{ readonly suffix: string; readonly factor: number }> =>
  UNIT_FACTORS.filter((u) => n % u.factor === 0);

/** Render an unsigned magnitude in the given radix, matching git's accepted literal forms. */
const renderMagnitude = (magnitude: number, radix: 'decimal' | 'octal' | 'hex'): string => {
  if (radix === 'decimal') return magnitude.toString(10);
  if (radix === 'octal') return `0${magnitude.toString(8)}`;
  return `0x${magnitude.toString(16)}`;
};

/**
 * An integer `n` in git's boolean int32 range, rendered as a literal git's grammar accepts:
 * decimal/octal/hex, an optional `+` on non-negative values, and an optional unit factor that
 * evenly divides `n` (so the rendering's magnitude, scaled, reproduces `n` exactly).
 */
const arbBooleanIntegerRendering = (): fc.Arbitrary<{
  readonly text: string;
  readonly n: number;
}> =>
  fc.integer({ min: INT32_MIN, max: INT32_MAX }).chain((n) =>
    fc
      .tuple(
        fc.constantFrom(...factorsDividing(n)),
        fc.constantFrom<'decimal' | 'octal' | 'hex'>('decimal', 'octal', 'hex'),
        fc.boolean(),
      )
      .map(([unit, radix, explicitPlus]) => {
        const base = n / unit.factor;
        const digits = renderMagnitude(Math.abs(base), radix);
        const sign = n < 0 ? '-' : explicitPlus ? '+' : '';
        return { text: `${sign}${digits}${unit.suffix}`, n };
      }),
  );

describe('config-read boolean grammar properties', () => {
  describe('Given an arbitrary ASCII string without NUL (and null)', () => {
    describe('When parseGitBoolean classifies it', () => {
      it('Then it returns a result and never throws', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(
            fc.option(
              fc.string({
                unit: fc.integer({ min: 1, max: 0x7f }).map((cp) => String.fromCodePoint(cp)),
              }),
              { nil: null },
            ),
            (value) => {
              const result = parseGitBoolean(value);
              // Falsifiable shape invariant, not a tautology: an accepting
              // parse must carry a real boolean payload, a refusing parse
              // must carry none.
              if (result.ok) {
                expect(typeof result.value).toBe('boolean');
              } else {
                expect(Object.keys(result)).toEqual(['ok']);
              }
            },
          ),
          { numRuns: 100 },
        );
      });
    });
  });

  describe(
    'Given an arbitrary integer in [-2147483648, 2147483647] rendered in decimal, octal or ' +
      'hex, with an optional sign and an optional in-range unit factor',
    () => {
      describe('When parseGitBoolean parses the rendering', () => {
        it('Then it is ok and its value is n !== 0', () => {
          // Arrange + Act + Assert — the oracle is arithmetic (n !== 0), not a
          // re-implementation of the parse.
          fc.assert(
            fc.property(arbBooleanIntegerRendering(), ({ text, n }) => {
              const result = parseGitBoolean(text);
              expect(result).toEqual({ ok: true, value: n !== 0 });
            }),
            { numRuns: 100 },
          );
        });
      });
    },
  );
});
