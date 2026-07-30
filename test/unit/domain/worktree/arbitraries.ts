/**
 * Shared fast-check generators for the gitfile/commondir parser property
 * tests. Character sets are built from Unicode code-point ranges (never a
 * literal alphabet string) so no test file contains a high-entropy string
 * literal that trips secret scanners.
 */
import fc from 'fast-check';

const PRINTABLE_ASCII_MIN = 0x20; // space
const PRINTABLE_ASCII_MAX = 0x7e; // '~'

/**
 * A single printable-ASCII character, space through `~`. This range excludes
 * `\r` (0x0d) and `\n` (0x0a) by construction — both are below 0x20.
 */
export function arbPrintableAsciiChar(): fc.Arbitrary<string> {
  return fc
    .integer({ min: PRINTABLE_ASCII_MIN, max: PRINTABLE_ASCII_MAX })
    .map((code) => String.fromCharCode(code));
}

/** A non-empty path-like value with no `\r`/`\n` — the gitfile/commondir path family. */
export function arbPathValue(): fc.Arbitrary<string> {
  return fc.string({ unit: arbPrintableAsciiChar(), minLength: 1, maxLength: 40 });
}

/** Arbitrary printable-ASCII content, including empty — for totality checks. */
export function arbPrintableAsciiContent(): fc.Arbitrary<string> {
  return fc.string({ unit: arbPrintableAsciiChar(), minLength: 0, maxLength: 60 });
}
