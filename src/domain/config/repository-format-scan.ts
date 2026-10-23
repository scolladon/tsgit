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
function* sectionedEntries(tokens: ReadonlyArray<ConfigToken>): Generator<SectionedEntry> {
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

function* versionEntries(tokens: ReadonlyArray<ConfigToken>): Generator<SectionedEntry> {
  for (const entry of sectionedEntries(tokens)) {
    if (entry.subsection !== undefined) continue;
    if (entry.section === CORE_SECTION && entry.key === VERSION_KEY) yield entry;
  }
}

const firstMalformedVersionLine = (tokens: ReadonlyArray<ConfigToken>): number => {
  for (const entry of versionEntries(tokens)) {
    if (!parseGitInt(entry.value).ok) return entry.line;
  }
  return Number.POSITIVE_INFINITY;
};

/**
 * Whether git's streaming parse reaches the declared `extensions.refStorage`
 * entry before the first `core.repositoryformatversion` entry that is not an
 * integer — the one it reports is the one that comes first by line. With no
 * malformed version there is nothing to order, and either answer reads alike.
 */
export const refStorageReadBeforeMalformedVersion = (
  tokens: ReadonlyArray<ConfigToken>,
): boolean => {
  const declared = lastTopLevelEntry(tokens, EXTENSIONS_SECTION, REFSTORAGE_KEY);
  if (declared === undefined) return false;
  // Stryker disable next-line EqualityOperator: equivalent — two entries never share a line, so `declared.line` never equals a malformed version's line and `<=` answers as `<`.
  return declared.line < firstMalformedVersionLine(tokens);
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
  for (const token of versionEntries(tokens)) {
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
// shape as `OBJECT_FORMAT_VALUES` in read-repository-format.ts (case-sensitive, `resolveEnum` is
// general for both).
export const REF_STORAGE_VALUES = ['files', 'reftable'] as const;
export type RefStorage = (typeof REF_STORAGE_VALUES)[number];

/**
 * The repository-format acceptance verdict — git's `core.repositoryformatversion`
 * / `extensions.*` gate. Absent means accepted. `version` is always the
 * PARSED integer (`1k` carries `1024`, `0777` carries `511`), never the
 * config literal. The port's `RepositoryFormatRefusal` is this type.
 */
export type FormatRefusal =
  | { readonly kind: 'version'; readonly version: number }
  | {
      readonly kind: 'extensions';
      readonly version: number;
      readonly extensions: ReadonlyArray<string>;
    };

// git's format gate: the effective (last-wins) core.repositoryformatversion
// must not exceed this. A named ceiling, never membership in a set — `-1` is
// accepted by `> MAX_REPOSITORY_FORMAT_VERSION` but refused by `{0, 1}`.
const MAX_REPOSITORY_FORMAT_VERSION = 1;

/**
 * One `[extensions]` entry: the reported name (`subsection === undefined ?
 * key : `${subsection}.${key}``, key ALWAYS lower-cased, subsection ALWAYS
 * verbatim), the bare lower-cased key alone (registry lookups use this and
 * only when `subsection` is `undefined`), the raw subsection, the raw
 * value, and the entry's 1-based line.
 */
export interface ExtensionEntry {
  readonly name: string;
  readonly key: string;
  readonly subsection: string | undefined;
  readonly value: string | null;
  readonly line: number;
}

/**
 * Every `[extensions]` entry in `tokens`, subsectioned ones included, in
 * file order, duplicates preserved. `lastTopLevelEntry` cannot serve here:
 * it skips subsections and keeps only the last match for one key. Exported
 * for the property-test sibling — `__resetSectionsCacheForTests` in
 * `config-scoped-read.ts` is the live precedent for a test-only `src` export.
 */
export const enumerateExtensionEntries = (
  tokens: ReadonlyArray<ConfigToken>,
): ReadonlyArray<ExtensionEntry> =>
  [...sectionedEntries(tokens)]
    .filter((entry) => entry.section === EXTENSIONS_SECTION)
    // Subsectioned entries are KEPT here, unlike the two `[core]` readers: git
    // reports `[extensions "X"] bogus` as the offending name `X.bogus`.
    .map(({ key, subsection, value, line }) => ({
      name: subsection === undefined ? key : `${subsection}.${key}`,
      key,
      subsection,
      value,
      line,
    }));

const lowerCasedSet = (names: ReadonlyArray<string>): ReadonlySet<string> =>
  new Set(names.map((name) => name.toLowerCase()));

// git 2.55.0 knows exactly these nine. This describes GIT, not tsgit's
// capabilities — it neither shrinks when tsgit lacks a name nor grows when
// tsgit gains one; only a new git release moves it.
const GIT_KNOWN_EXTENSIONS = lowerCasedSet([
  'noop',
  'noop-v1',
  'worktreeConfig',
  'preciousObjects',
  'partialClone',
  'relativeWorktrees',
  'objectFormat',
  'compatObjectFormat',
  'refStorage',
]);

// The five names git refuses at version 0.
const GIT_V1_ONLY_EXTENSIONS = lowerCasedSet([
  'noop-v1',
  'objectFormat',
  'compatObjectFormat',
  'refStorage',
  'relativeWorktrees',
]);

// A subsectioned spelling of a known name is not known — membership is
// keyed on the bare key only when `subsection` is `undefined`.
const isUnknownExtension = (entry: ExtensionEntry): boolean =>
  entry.subsection !== undefined || !GIT_KNOWN_EXTENSIONS.has(entry.key);

const isV1OnlyExtension = (entry: ExtensionEntry): boolean =>
  entry.subsection === undefined && GIT_V1_ONLY_EXTENSIONS.has(entry.key);

const namesWhere = (
  entries: ReadonlyArray<ExtensionEntry>,
  predicate: (entry: ExtensionEntry) => boolean,
): ReadonlyArray<string> => entries.filter(predicate).map((entry) => entry.name);

/**
 * The extensions arm — version-selected, independent of the version-ceiling
 * arm: `version === 0` refuses v1-only names, `version >= 1` refuses
 * unknown names (in practice `=== 1` here, since a caller only reaches this
 * once the version arm has already returned `undefined` for `version <=
 * MAX_REPOSITORY_FORMAT_VERSION`). A negative version refuses neither.
 */
const extensionsRefusal = (
  version: number,
  entries: ReadonlyArray<ExtensionEntry>,
): FormatRefusal | undefined => {
  if (version === 0) {
    const names = namesWhere(entries, isV1OnlyExtension);
    return names.length > 0 ? { kind: 'extensions', version, extensions: names } : undefined;
  }
  if (version >= 1) {
    const names = namesWhere(entries, isUnknownExtension);
    return names.length > 0 ? { kind: 'extensions', version, extensions: names } : undefined;
  }
  return undefined;
};

/** The carried verdict — the version ceiling wins outright over the extension arms. */
export const formatRefusal = (
  version: number | undefined,
  entries: ReadonlyArray<ExtensionEntry>,
): FormatRefusal | undefined => {
  if (version === undefined) return undefined;
  return versionRefusal(version) ?? extensionsRefusal(version, entries);
};

/** The version arm of the acceptance verdict — refuse strictly above the named ceiling. */
const versionRefusal = (version: number | undefined): FormatRefusal | undefined =>
  version !== undefined && version > MAX_REPOSITORY_FORMAT_VERSION
    ? { kind: 'version', version }
    : undefined;
