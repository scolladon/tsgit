/**
 * Shared fast-check generators for path property tests: name-safe segment
 * characters and segments built from them.
 */
import fc from 'fast-check';

export function arbSegmentChar(): fc.Arbitrary<string> {
  return fc
    .oneof(
      fc.integer({ min: 97, max: 122 }), // a-z
      fc.integer({ min: 65, max: 90 }), // A-Z
      fc.integer({ min: 48, max: 57 }), // 0-9
    )
    .map((code) => String.fromCharCode(code));
}

export function arbSegment(): fc.Arbitrary<string> {
  return fc.string({ unit: arbSegmentChar(), minLength: 1, maxLength: 8 });
}
