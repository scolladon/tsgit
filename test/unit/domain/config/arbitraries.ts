/**
 * Shared fast-check generators for the config-grammar property tests:
 * printable-ASCII characters (plus TAB and LF, the whitespace the grammar
 * folds) built from integer code-point ranges.
 */
import fc from 'fast-check';

export function arbConfigTextChar(): fc.Arbitrary<string> {
  return fc
    .oneof(
      fc.integer({ min: 32, max: 126 }), // printable ASCII
      fc.constant(9), // TAB
      fc.constant(10), // LF
    )
    .map((code) => String.fromCharCode(code));
}
