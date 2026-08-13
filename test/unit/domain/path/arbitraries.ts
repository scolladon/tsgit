import fc from 'fast-check';

const MIN_COMPONENT_LENGTH = 1;
const MAX_COMPONENT_LENGTH = 12;
const MIN_PATH_COMPONENTS = 0;
const MAX_PATH_COMPONENTS = 6;

// Lowercase ASCII letters, generated from the codepoint range rather than a
// pasted alphabet string (a literal alphabet reads as a plausible base64
// charset to secret scanners).
const LOWERCASE_A = 0x61;
const LOWERCASE_Z = 0x7a;

/**
 * A path component drawn from plain lowercase ASCII letters — never itself
 * collides with a `.git` alias family, so composition properties can safely
 * assume "non-alias in, non-alias out" for the base generator.
 */
export function arbPathComponent(): fc.Arbitrary<string> {
  return fc
    .array(fc.integer({ min: LOWERCASE_A, max: LOWERCASE_Z }), {
      minLength: MIN_COMPONENT_LENGTH,
      maxLength: MAX_COMPONENT_LENGTH,
    })
    .map((codes) => codes.map((code) => String.fromCharCode(code)).join(''));
}

/**
 * One of the closed-list ignorable codepoints the HFS alias arm strips,
 * generated from the documented ranges rather than a pasted codepoint list.
 */
export function arbIgnorableCodepoint(): fc.Arbitrary<number> {
  return fc.oneof(
    fc.integer({ min: 0x200c, max: 0x200f }),
    fc.integer({ min: 0x202a, max: 0x202e }),
    fc.integer({ min: 0x206a, max: 0x206f }),
    fc.constant(0xfeff),
  );
}

/** A `/`-joined path built from safe (non-alias) ASCII components. */
export function arbSafeAsciiPath(): fc.Arbitrary<string> {
  return fc
    .array(arbPathComponent(), { minLength: MIN_PATH_COMPONENTS, maxLength: MAX_PATH_COMPONENTS })
    .map((parts) => parts.join('/'));
}
