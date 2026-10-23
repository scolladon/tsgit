import {
  configBadNumericValue,
  configInvalidEnumValue,
  configMissingValue,
} from '../commands/error.js';
import type { ConfigToken } from './config-ini.js';
import { parseGitInt } from './config-ini.js';

export const CORE_SECTION = 'core';
export const EXTENSIONS_SECTION = 'extensions';
const VERSION_KEY = 'repositoryformatversion';
export const REFSTORAGE_KEY = 'refstorage';

// The lowest `core.repositoryformatversion` at which an `extensions.*` entry
// is honoured rather than ignored (version 0) or absent-and-inert.
const MIN_EXTENSION_VERSION = 1;

/** One scalar key's raw value, as last seen in file order (git's last-wins resolution). */
export interface ScannedEntry {
  readonly value: string | null;
  readonly line: number;
}

/** One `[section "subsection"] key = value` entry, with its header resolved. */
interface SectionedEntry {
  /** Lower-cased section name. */
  readonly section: string;
  /** Subsection verbatim, or `undefined` for a top-level `[section]`. */
  readonly subsection: string | undefined;
  /** Lower-cased key. */
  readonly key: string;
  readonly value: string | null;
  /** 1-based, matching git's config line numbers and `ScannedEntry.line`. */
  readonly line: number;
}

/**
 * Walks the token stream once, pairing every `entry` with the header in force.
 *
 * The three readers below want different slices of the same walk — last
 * top-level value, every `[extensions]` entry including subsectioned ones, and
 * a streaming pass over `[core]`. Written out three times, the header-tracking
 * preamble is identical and the FILTERS are what differ, which is precisely
 * where a later edit to one copy silently misses the others: one of them
 * deliberately keeps subsectioned entries and two deliberately drop them.
 * Expressing each as its own filter over one generator makes that difference
 * the visible part.
 */
export function* sectionedEntries(tokens: ReadonlyArray<ConfigToken>): Generator<SectionedEntry> {
  // Stryker disable next-line StringLiteral: equivalent — the tokenizer emits `entry` tokens even for lines before any header, and every consumer compares this against a non-empty section literal ('core' or 'extensions'), so a mutated initial value is never observable.
  let section = '';
  let subsection: string | undefined;
  for (const token of tokens) {
    if (token.kind === 'header') {
      section = token.section.toLowerCase();
      subsection = token.subsection;
      continue;
    }
    if (token.kind !== 'entry') continue;
    yield {
      section,
      subsection,
      key: token.key.toLowerCase(),
      value: token.value,
      // `startLine` is the 0-based index into the tokenizer's line split;
      // git's config line numbers are 1-based.
      line: token.startLine + 1,
    };
  }
}

/**
 * Scans `tokens` for the LAST top-level (no subsection) entry under
 * `[section] key`, case-insensitively on both — git's scalar-value
 * resolution is last-occurrence-wins within one file.
 */
export const lastTopLevelEntry = (
  tokens: ReadonlyArray<ConfigToken>,
  section: string,
  key: string,
): ScannedEntry | undefined => {
  let found: ScannedEntry | undefined;
  for (const entry of sectionedEntries(tokens)) {
    if (entry.subsection !== undefined) continue;
    if (entry.section !== section || entry.key !== key) continue;
    found = { value: entry.value, line: entry.line };
  }
  return found;
};

/**
 * `core.repositoryformatversion`'s two-model resolution, streamed over
 * `tokens` in file order (case-insensitive on section and key, top-level
 * only — mirrors `lastTopLevelEntry`'s section/subsection tracking). EVERY
 * occurrence is parsed with `parseGitInt`: the FIRST malformed one throws
 * `CONFIG_BAD_NUMERIC_VALUE` immediately (a later valid line never rescues
 * an earlier malformed one — git observes each line once through its
 * streaming `git_default_config` callback); a well-formed occurrence keeps
 * only its own PARSED value, overwriting any earlier one, so the accepted
 * set is decided by the LAST well-formed occurrence. `undefined` when the
 * key never appears. This mirrors `core.maxTreeDepth`'s resolution split
 * (`repo-state.ts`) with the two halves — streaming-throw, last-wins —
 * swapped onto one key.
 */
export const resolveFormatVersion = (
  tokens: ReadonlyArray<ConfigToken>,
  source: string,
): number | undefined => {
  let version: number | undefined;
  for (const token of sectionedEntries(tokens)) {
    if (token.subsection !== undefined) continue;
    if (token.section !== CORE_SECTION || token.key !== VERSION_KEY) continue;
    const parsed = parseGitInt(token.value);
    // A valueless entry is git's internal NULL, reported by git as value ''.
    if (!parsed.ok) {
      throw configBadNumericValue(
        `${CORE_SECTION}.${VERSION_KEY}`,
        source,
        token.value ?? '',
        parsed.reason,
      );
    }
    version = parsed.value;
  }
  return version;
};

/** Narrows `value` to a member of `allowed`, compared case-SENSITIVELY. */
const isAllowedValue = <T extends string>(value: string, allowed: ReadonlyArray<T>): value is T =>
  (allowed as ReadonlyArray<string>).includes(value);

/**
 * A string-typed config key's value must be one of `allowed`'s literals —
 * the shared shape behind `extensions.objectFormat` and (identically)
 * `extensions.refStorage`. Comparison is case-SENSITIVE, unlike `key`
 * itself, which git lower-cases for its error messages (measured: git 2.55.0
 * refuses `SHA256` even though the repository was created with
 * `--object-format=sha256`). Absent resolves to `fallback`; a valueless
 * entry throws `CONFIG_MISSING_VALUE` (git's internal NULL); any other
 * out-of-grammar value — including the empty string, a DIFFERENT condition
 * from valueless — throws `CONFIG_INVALID_ENUM_VALUE`.
 */
export const resolveEnum = <T extends string>(
  entry: ScannedEntry | undefined,
  source: string,
  key: string,
  allowed: ReadonlyArray<T>,
  fallback: T,
): T => {
  if (entry === undefined) return fallback;
  if (entry.value === null) throw configMissingValue(key, source, entry.line);
  if (!isAllowedValue(entry.value, allowed)) {
    throw configInvalidEnumValue(key, source, entry.value, entry.line);
  }
  return entry.value;
};

/**
 * Whether a declared `extensions.*` value is acted on at all. git honours the
 * section only from `core.repositoryformatversion` 1 up: an ABSENT version key
 * leaves every extension inert (measured — the repository reads as SHA-1 even
 * with `extensions.objectFormat = sha256` present), and version 0 refuses the
 * v1-only names outright rather than honouring them.
 */
export const honoursExtensions = (version: number | undefined): boolean =>
  version !== undefined && version >= MIN_EXTENSION_VERSION;

// git 2.55.0's legal `extensions.refStorage` literals — the same grammar
// shape as `OBJECT_FORMAT_VALUES` above (case-sensitive, `resolveEnum` is
// general for both).
export const REF_STORAGE_VALUES = ['files', 'reftable'] as const;
export type RefStorage = (typeof REF_STORAGE_VALUES)[number];
