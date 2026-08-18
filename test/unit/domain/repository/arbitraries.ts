/**
 * Shared fast-check generators for `isValidHeadContent` property tests.
 * Character sets are built from integer code-point ranges, mirroring
 * `test/unit/repository/arbitraries.ts` — a hex/base64 alphabet written as a
 * string literal trips the `CKV_SECRET_6` scan in `check:security`.
 */
import fc from 'fast-check';

/** A name-safe segment char: `a-z`, `A-Z`, or `0-9`. */
export function arbSegmentChar(): fc.Arbitrary<string> {
  return fc
    .oneof(
      fc.integer({ min: 97, max: 122 }), // a-z
      fc.integer({ min: 65, max: 90 }), // A-Z
      fc.integer({ min: 48, max: 57 }), // 0-9
    )
    .map((code) => String.fromCharCode(code));
}

function arbSegment(): fc.Arbitrary<string> {
  return fc.string({ unit: arbSegmentChar(), minLength: 1, maxLength: 8 });
}

/** A refname beginning `refs/`: one or more name-safe segments joined by `/`. */
export function arbRefsPrefixedRefname(): fc.Arbitrary<string> {
  return fc
    .array(arbSegment(), { minLength: 1, maxLength: 4 })
    .map((segments) => `refs/${segments.join('/')}`);
}

/** A single lowercase hex digit: `0-9` or `a-f`. */
function arbHexChar(): fc.Arbitrary<string> {
  return fc
    .oneof(
      fc.integer({ min: 48, max: 57 }), // 0-9
      fc.integer({ min: 97, max: 102 }), // a-f
    )
    .map((code) => String.fromCharCode(code));
}

function arbHexOfLength(length: number): fc.Arbitrary<string> {
  return fc.string({ unit: arbHexChar(), minLength: length, maxLength: length });
}

/**
 * A `{ length, hex }` pair, where `hex` is exactly `length` lowercase hex
 * digits. Biased toward the two accepted widths (40, 64) so the "iff" both
 * directions of the hash-width property get exercised on every run, while
 * still sampling other lengths to prove the rejection side.
 */
export function arbHexWithLength(): fc.Arbitrary<{
  readonly length: number;
  readonly hex: string;
}> {
  return fc
    .oneof(
      { weight: 2, arbitrary: fc.constantFrom(40, 64) },
      { weight: 1, arbitrary: fc.integer({ min: 0, max: 80 }) },
    )
    .chain((length) => arbHexOfLength(length).map((hex) => ({ length, hex })));
}

/** A single printable-ASCII char: space (0x20) through tilde (0x7e) inclusive. */
export function arbPrintableAsciiChar(): fc.Arbitrary<string> {
  return fc.integer({ min: 0x20, max: 0x7e }).map((code) => String.fromCharCode(code));
}
