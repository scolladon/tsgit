const WILDCARD_ALL = '*';
const WILDCARD_SUFFIX = '/*';

// Strips one trailing '/', but never turns the root '/' into ''.
const stripTrailingSlash = (value: string): string =>
  value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;

// entry ends in '/*': match iff repositoryPath is strictly below the prefix
// (never the prefix itself), at any depth.
const isBelowPrefix = (repositoryPath: string, entry: string): boolean => {
  const prefix = stripTrailingSlash(entry.slice(0, -1));
  return stripTrailingSlash(repositoryPath).startsWith(`${prefix}/`);
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
