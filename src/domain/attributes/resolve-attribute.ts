import type { AttributeValue } from './attribute-value.js';
import { expandAttributes, type MacroRegistry } from './macros.js';
import type { AttributeRule } from './parse-gitattributes.js';

/**
 * One attributes file's rules, tagged with the directory it lives in (`''` is
 * the repo root). Like git's attribute stack, a path is resolved over the files
 * of its own directory and its ancestors: an anchored pattern is matched
 * against the path made relative to `basedir` and skips a path outside it, a
 * pattern without a slash against the basename alone.
 */
export interface AttributeSource {
  readonly basedir: string;
  readonly rules: ReadonlyArray<AttributeRule>;
}

const DIRECTORY_MARKER = '/';
const SEPARATOR = '/';

/** A queried path split once, so each source reuses it instead of re-deriving it. */
interface QueriedPath {
  readonly bare: string;
  readonly basename: string;
  readonly isDirectory: boolean;
}

/** A trailing `/` on a queried path marks it as a directory; patterns see it without the marker. */
const queriedPath = (path: string): QueriedPath => {
  const isDirectory = path.endsWith(DIRECTORY_MARKER);
  const bare = isDirectory ? path.slice(0, -DIRECTORY_MARKER.length) : path;
  return { bare, basename: bare.slice(bare.lastIndexOf(SEPARATOR) + 1), isDirectory };
};

/** The path relative to `basedir`, or `undefined` when it is not under it. */
const relativeTo = (path: string, basedir: string): string | undefined => {
  if (basedir === '') return path;
  const under = path.charAt(basedir.length) === SEPARATOR && path.startsWith(basedir);
  return under ? path.slice(basedir.length + SEPARATOR.length) : undefined;
};

/**
 * git's `path_matches`: a pattern without a slash sees the basename only and
 * never compares the source's directory, so its cost does not grow with the
 * directories above the path; an anchored one sees the path relative to its
 * file's directory, and nothing outside it.
 */
const ruleMatches = (rule: AttributeRule, query: QueriedPath, source: AttributeSource): boolean => {
  if (!rule.anchored) return rule.compiled.test(query.basename);
  const relative = relativeTo(query.bare, source.basedir);
  return relative !== undefined && rule.compiled.test(relative);
};

/** The last-matching rule's value for `name` within one source, after macro expansion. */
const resolveInSource = (
  source: AttributeSource,
  query: QueriedPath,
  name: string,
  macros: MacroRegistry,
): AttributeValue | undefined => {
  let found: AttributeValue | undefined;
  for (const rule of source.rules) {
    if (rule.directoryOnly && !query.isDirectory) continue;
    if (!ruleMatches(rule, query, source)) continue;
    const value = expandAttributes(rule.attributes, macros).get(name);
    if (value !== undefined) found = value;
  }
  return found;
};

/**
 * Resolve `name` for `path` over precedence-ordered `sources` (highest first).
 * Within a source the last matching rule wins; across sources the first that
 * assigns the attribute wins. Yields `'unspecified'` when none assign it.
 */
export const resolveAttribute = (
  sources: ReadonlyArray<AttributeSource>,
  path: string,
  name: string,
  macros: MacroRegistry,
): AttributeValue => {
  const query = queriedPath(path);
  for (const source of sources) {
    const value = resolveInSource(source, query, name, macros);
    if (value !== undefined) return value;
  }
  return 'unspecified';
};
