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
    if (!isAlnumDashChar(text[i] as string)) return i;
  }
  return undefined;
};

const SUBSECTION_FORBIDDEN = /[\n\r\0"\\\]]/;

/**
 * Parse a fully-qualified config key. Two grammars accepted:
 *
 *   "section.name"                          → { section, undefined, name }
 *   "section.subsection.with.dots.name"     → { section, "subsection.with.dots", name }
 *
 * Section and name are lower-cased per git's case-insensitive rules; the
 * subsection is preserved verbatim (case-sensitive). The subsection is the
 * slice between the FIRST and LAST `.` — a subsection containing dots is
 * legal and round-trips through the parser.
 */
export const parseConfigKey = (raw: string): ParsedConfigKey => {
  const firstDot = raw.indexOf('.');
  if (firstDot === -1) {
    throw configKeyInvalid(raw, 'missing-name');
  }
  const sectionRaw = raw.slice(0, firstDot);
  if (sectionRaw.length === 0) {
    throw configKeyInvalid(raw, 'empty-section');
  }
  const lastDot = raw.lastIndexOf('.');
  const nameRaw = raw.slice(lastDot + 1);
  if (nameRaw.length === 0) {
    throw configKeyInvalid(raw, 'missing-name');
  }
  const sectionBad = findInvalidIdentifierIndex(sectionRaw);
  if (sectionBad !== undefined) {
    throw configKeyInvalid(raw, 'bad-character', sectionBad);
  }
  const nameBad = findInvalidIdentifierIndex(nameRaw);
  if (nameBad !== undefined) {
    throw configKeyInvalid(raw, 'bad-character', lastDot + 1 + nameBad);
  }
  const subsection = firstDot === lastDot ? undefined : raw.slice(firstDot + 1, lastDot);
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
