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

const MIN_NTFS_SUFFIX_DIGITS = 1;
const MAX_NTFS_SUFFIX_DIGITS = 20;

/**
 * A path component with a shape structurally adjacent to a `.git` alias —
 * leading dot, tilde+digits, trailing dot/space, an embedded backslash, or
 * an exact alias literal — mixed with plain non-alias components. Composition
 * properties drawing from this (rather than plain lowercase ASCII) actually
 * exercise `isDotGitAlias`'s alias branch instead of vacuously passing
 * through components that can never match it.
 */
export function arbAliasAdjacentComponent(): fc.Arbitrary<string> {
  return fc.oneof(
    arbPathComponent(),
    arbPathComponent().map((part) => `.${part}`),
    fc
      .tuple(
        arbPathComponent(),
        fc.integer({ min: MIN_NTFS_SUFFIX_DIGITS, max: MAX_NTFS_SUFFIX_DIGITS }),
      )
      .map(([part, digits]) => `${part}~${digits}`),
    arbPathComponent().map((part) => `${part}.`),
    arbPathComponent().map((part) => `${part} `),
    fc.tuple(arbPathComponent(), arbPathComponent()).map(([left, right]) => `${left}\\${right}`),
    fc.constantFrom('.git', 'git~1', '.git:x', '.GIT'),
  );
}

/**
 * A string with a codepoint from the closed HFS ignorable set spliced in at
 * a random position. Plain `fc.string()` (fast-check's default grapheme-ascii
 * charset) never draws one of these codepoints, so totality properties over
 * bare `fc.string()` alone never exercise the ignorable-codepoint strip arm.
 */
export function arbStringWithIgnorableCodepoint(): fc.Arbitrary<string> {
  return fc
    .tuple(fc.string(), arbIgnorableCodepoint(), fc.nat())
    .map(([base, codepoint, offset]) => {
      const insertion = String.fromCodePoint(codepoint);
      const index = offset % (base.length + 1);
      return `${base.slice(0, index)}${insertion}${base.slice(index)}`;
    });
}

const ALIAS_LITERALS = ['.git', 'git~1', '.git:x', '.GIT'] as const;

/**
 * A `.git`-alias-family literal cut at a random interior index into two
 * fragments. Neither fragment is itself an alias, but their backslash-free
 * concatenation reconstructs the literal exactly — the precise shape a
 * mutant that drops the backslash separator (instead of splitting on it)
 * would mis-detect as an alias. Composing this with an explicit backslash
 * must stay accepted; without one of these pairs, a composition property
 * built only from unrelated random components essentially never lands on a
 * concatenation that happens to equal an alias literal.
 */
function arbAliasSplitPair(): fc.Arbitrary<readonly [string, string]> {
  return fc
    .constantFrom(...ALIAS_LITERALS)
    .chain((alias) =>
      fc.integer({ min: 1, max: alias.length - 1 }).map((cut) => [alias, cut] as const),
    )
    .map(([alias, cut]) => [alias.slice(0, cut), alias.slice(cut)] as const);
}

/**
 * A pair of components for the backslash-composition property: usually two
 * independent alias-adjacent components, occasionally a deliberately-split
 * alias-literal pair — so the property both filters via `fc.pre` (some draws
 * are, or reconstitute, a real alias) and can fail if the backslash split
 * regresses to a naive concatenation.
 */
export function arbComponentPair(): fc.Arbitrary<readonly [string, string]> {
  return fc.oneof(
    fc.tuple(arbAliasAdjacentComponent(), arbAliasAdjacentComponent()),
    arbAliasSplitPair(),
  );
}
