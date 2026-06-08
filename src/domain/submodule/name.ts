const DRIVE_LETTER_PREFIX = /^[A-Za-z]:/;
const CONTROL_CHAR_MAX = 0x1f;
const DEL_CHAR = 0x7f;

const hasControlChar = (name: string): boolean => {
  // Stryker disable next-line EqualityOperator: equivalent — at `i === name.length` `charCodeAt(i)` returns `NaN`, which fails both `c <= 0x1f` and `c === 0x7f`, so the extra iteration is a no-op.
  for (let i = 0; i < name.length; i += 1) {
    const c = name.charCodeAt(i);
    if (c <= CONTROL_CHAR_MAX) return true;
    if (c === DEL_CHAR) return true;
  }
  return false;
};

/**
 * Reject submodule names that could escape the repository when joined into
 * `${gitDir}/modules/<name>` or carry bytes the FS layer mishandles: empty,
 * `.`/`..`, any `.`/`..`/empty path segment, backslash, absolute (POSIX-style
 * or drive-prefixed), leading `-`, NUL or other control characters. Mirrors
 * git's `submodule-config` name validation (CVE-2018-17456 lineage) plus the
 * NUL guard `submodule-config.c` carries for path-safety on FS calls.
 *
 * Returns `true` for known-unsafe names. A `false` return does NOT mean
 * "trusted" — callers must still apply containment via the bounded FS.
 */
export const isUnsafeSubmoduleName = (name: string): boolean => {
  // `name === ''` and `name.startsWith('/')` are subsumed by the segment loop
  // below: `''.split('/')` is `['']` (empty segment) and `'/x'.split('/')` is
  // `['', 'x']` (leading empty segment) — both trigger the empty-segment rule.
  if (name.startsWith('-')) return true;
  if (name.includes('\\')) return true;
  if (hasControlChar(name)) return true;
  if (DRIVE_LETTER_PREFIX.test(name)) return true;
  for (const segment of name.split('/')) {
    if (segment === '') return true;
    if (segment === '.') return true;
    if (segment === '..') return true;
  }
  return false;
};
