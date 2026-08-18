/**
 * Pure grammar check for `HEAD` file content: text in, verdict out, no I/O.
 * Content is valid iff its LEADING 40 characters are hex of either case — git
 * parses a detached HEAD by consuming exactly one object id's worth of hex
 * and ignoring everything after it, so `<40hex>\n`, a 64-hex SHA-256 id
 * (whose first 40 characters are themselves hex), and even `<40hex>garbage`
 * all qualify — OR it begins `ref:` followed by optional ASCII whitespace
 * and a token beginning `refs/` (a symbolic ref; the refname past the
 * prefix is never format-checked here — `refs/heads/../evil` is accepted,
 * exactly as the referenced ref would be validated, or not, when it is
 * actually resolved). The whitespace class is deliberately ASCII-only
 * (C `isspace`): Unicode spaces such as NBSP do NOT separate the prefix
 * from the refname, so `ref: refs/...` is invalid — a directory real
 * git climbs past must never qualify here, or a planted tree could shadow
 * an enclosing repository.
 *
 * One deliberate divergence from real git: git also accepts a `HEAD` that is
 * a *symlink* whose link text begins `refs/`, even when the symlink target
 * does not exist. This module only ever sees the string a caller already
 * read back (following any symlink), so a dangling `HEAD` symlink can never
 * reach it — the caller's read already failed and it never calls in. A
 * `HEAD` symlink to an existing, valid target still comes through here as
 * ordinary content and is accepted.
 */

// A leading object id: git consumes the hex prefix and ignores the
// remainder, so the shorter SHA-1 width is the only anchor needed — a
// SHA-256 id passes through its own first 40 hex characters. Both cases
// qualify: git's hex table accepts A-F (an uppercase detached HEAD is a
// git directory, measured), even though git itself always writes lowercase.
const LEADING_OID_RE = /^[0-9a-fA-F]{40}/;

// `ref:` + optional ASCII whitespace (C `isspace`, never Unicode) + `refs/`.
// `refs/` contains no whitespace, so "the first whitespace-delimited token
// begins refs/" and "the remainder after skipping whitespace begins refs/"
// are the same predicate.
const SYMBOLIC_REF_RE = /^ref:[ \t\n\v\f\r]*refs\//;

export const isValidHeadContent = (content: string): boolean =>
  LEADING_OID_RE.test(content) || SYMBOLIC_REF_RE.test(content);
