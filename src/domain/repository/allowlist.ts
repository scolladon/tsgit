const WILDCARD_ALL = '*';
const WILDCARD_SUFFIX = '/*';

// Strips one trailing '/', but never turns the root '/' into ''.
const stripTrailingSlash = (value: string): string =>
  value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;

// entry ends in '/*': match iff repositoryPath is strictly below the prefix
// (never the prefix itself), at any depth.
//
// The boundary is computed once rather than by re-appending a separator,
// because the prefix may already end in one. Two entries reach that state and
// both must keep working: the root prefix '/*' strips to '/', and a doubled
// separator ('/srv//*') strips to '/srv/'. Re-appending would test for '//'
// and match nothing — git accepts both (measured on 2.55.0), so an inert
// entry here would silently disagree with the documented grammar.
// The length test is what keeps "strictly below" true at the root: a boundary
// that is itself just '/' is a prefix of every absolute path INCLUDING '/',
// so `startsWith` alone would let '/*' match the root, where '/srv/*' rightly
// refuses '/srv'. For every deeper boundary the test is implied and inert.
const isBelowPrefix = (repositoryPath: string, entry: string): boolean => {
  const prefix = stripTrailingSlash(entry.slice(0, -1));
  const boundary = prefix.endsWith('/') ? prefix : `${prefix}/`;
  const path = stripTrailingSlash(repositoryPath);
  return path.startsWith(boundary) && path.length > boundary.length;
};

const matchesEntry = (repositoryPath: string, entry: string): boolean =>
  entry === WILDCARD_ALL ||
  (entry.endsWith(WILDCARD_SUFFIX)
    ? isBelowPrefix(repositoryPath, entry)
    : stripTrailingSlash(entry) === stripTrailingSlash(repositoryPath));

/**
 * Pure predicate: does `repositoryPath` match one of the `entries` in a
 * trusted-directory allowlist? No I/O, no canonicalisation — entries and the
 * path are compared exactly as given. Not an fnmatch: only `'*'` (matches
 * everything) and a trailing `/*` (matches everything strictly below the
 * prefix) are special; `'*'` elsewhere in an entry is a literal character.
 */
export const isAllowlisted = (repositoryPath: string, entries: ReadonlyArray<string>): boolean =>
  entries.some((entry) => matchesEntry(repositoryPath, entry));
