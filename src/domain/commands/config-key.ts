import { configKeyInvalid } from './error.js';

/**
 * A validated git-config key. Branded to prevent string-typed callers from
 * passing a raw, unvalidated string into config primitives. Construct via
 * `parseConfigKey` only.
 */
export type ConfigKey = string & { readonly __brand: 'ConfigKey' };

/**
 * The four canonical git-config scopes. Order in the union is also the read
 * precedence (lowest precedence first): system → global → local → worktree.
 */
export type ConfigScope = 'system' | 'global' | 'local' | 'worktree';

/**
 * Result of parsing a fully-qualified config key like `section.name` or
 * `section.subsection.name`. Section and name are lower-cased per git's
 * case-insensitive rules; subsection is preserved verbatim.
 */
export interface ParsedConfigKey {
  readonly section: string;
  readonly subsection: string | undefined;
  readonly name: string;
}

const isLetter = (ch: string): boolean => /[a-zA-Z]/.test(ch);
const isAlnumDashChar = (ch: string): boolean => /[a-zA-Z0-9-]/.test(ch);

/**
 * Validate a section-or-name identifier: ASCII letters, digits, hyphens; the
 * first character must be a letter. Returns the index of the first offending
 * character, or `undefined` if every character is valid.
 */
const findInvalidIdentifierIndex = (text: string): number | undefined => {
  if (!isLetter(text[0] as string)) return 0;
  for (let i = 1; i < text.length; i += 1) {
    // equivalent-mutant: i<=text.length — text[length] is undefined; /[a-zA-Z0-9-]/.test(undefined) coerces to "undefined" which matches, so the extra iteration never returns an index; result is identical
    if (!isAlnumDashChar(text[i] as string)) return i;
  }
  return undefined;
};

// git accepts any subsection byte except LF ("invalid key (newline)") and NUL
// (argv-impossible). CR, ", \, ] are written escaped or raw by the writer.
const SUBSECTION_FORBIDDEN = /[\n\0]/;

/**
 * Parse a fully-qualified config key. Three grammars accepted:
 *
 *   "section.name"                          → { section, undefined, name }
 *   "section.subsection.with.dots.name"     → { section, "subsection.with.dots", name }
 *   "..name" / ".subsection.name"           → { "", "" | subsection, name }
 *
 * Section and name are lower-cased per git's case-insensitive rules; the
 * subsection is preserved verbatim (case-sensitive). The subsection is the
 * slice between the FIRST and LAST `.` — a subsection containing dots is
 * legal and round-trips through the parser. An empty section is legal only
 * when a subsection is present (the `[ ""]` family); the subsection-less
 * ".name" form stays refused, mirroring git's `key does not contain a
 * section` refusal.
 */
export const parseConfigKey = (raw: string): ParsedConfigKey => {
  const firstDot = raw.indexOf('.');
  if (firstDot === -1) {
    throw configKeyInvalid(raw, 'missing-name');
  }
  const sectionRaw = raw.slice(0, firstDot);
  const lastDot = raw.lastIndexOf('.');
  const nameRaw = raw.slice(lastDot + 1);
  const subsection = firstDot === lastDot ? undefined : raw.slice(firstDot + 1, lastDot);
  if (sectionRaw.length === 0 && subsection === undefined) {
    throw configKeyInvalid(raw, 'empty-section');
  }
  if (nameRaw.length === 0) {
    throw configKeyInvalid(raw, 'missing-name');
  }
  if (sectionRaw.length > 0) {
    // equivalent-mutant: true/>=0 — findInvalidIdentifierIndex('') returns undefined because ''.text[0] is undefined; /[a-zA-Z]/.test(undefined) coerces to "undefined" which matches, so no bad-char index is returned; calling with empty sectionRaw is safe and equivalent
    const sectionBad = findInvalidIdentifierIndex(sectionRaw);
    if (sectionBad !== undefined) {
      throw configKeyInvalid(raw, 'bad-character', sectionBad);
    }
  }
  const nameBad = findInvalidIdentifierIndex(nameRaw);
  if (nameBad !== undefined) {
    throw configKeyInvalid(raw, 'bad-character', lastDot + 1 + nameBad);
  }
  if (subsection !== undefined && SUBSECTION_FORBIDDEN.test(subsection)) {
    const localBad = subsection.search(SUBSECTION_FORBIDDEN);
    throw configKeyInvalid(raw, 'bad-character', firstDot + 1 + localBad);
  }
  return {
    section: sectionRaw.toLowerCase(),
    subsection,
    name: nameRaw.toLowerCase(),
  };
};
