import type { GlobMatcher } from './compile-glob.js';
import { compileWildcard, hasGlobSpecial, MATCH_LEVEL, verbatimLevel } from './wildcard.js';

// One entry in a compiled pathspec. The order in the parent `Pathspec`
// array matters: `matchesPathspec` evaluates entries in order and the
// last match wins (mirrors `.gitignore` semantics).
export interface PathspecEntry {
  /** Original raw pattern (including any leading `!`), for diagnostics. */
  readonly pattern: string;
  /** Pattern with the leading `!` (if any) stripped — the part that compiled to `compiled`. */
  readonly body: string;
  /** True when the original pattern started with `!`. */
  readonly negated: boolean;
  /**
   * True when the body (post-`!`) contains none of `* ? [ \`.
   * Literal entries match the exact path AND any descendant — Git's
   * `git add src` semantics where `src` covers everything under it.
   */
  readonly isLiteral: boolean;
  /** Compiled glob matcher. Always tested against the candidate path verbatim. */
  readonly compiled: GlobMatcher;
}

export type Pathspec = ReadonlyArray<PathspecEntry>;

// Compile a list of pathspec patterns. Each pattern may begin with `!`
// to negate; the body is then auto-detected as a literal (no `* ? [ \`)
// or a wildcard.
//
// A body first matches verbatim: the path itself, or a directory above it.
// A wildcard body then matches git's `wildmatch` (flags 0) over the path's
// bytes: `*` and `?` cross `/`, `[...]` is a bracket expression and `\x`
// escapes one byte.
export const compilePathspec = (patterns: ReadonlyArray<string>): Pathspec =>
  patterns.map(compileOne);

/** The whole tree — git's `.` once its `.` components collapse to the empty prefix. */
const WHOLE_TREE: GlobMatcher = { test: () => true };

const compileLiteral = (body: string): GlobMatcher => {
  if (body === '') return WHOLE_TREE;
  return { test: (path) => verbatimLevel(body, path) !== MATCH_LEVEL.NONE };
};

const compileOne = (raw: string): PathspecEntry => {
  const negated = raw.startsWith('!');
  const body = negated ? raw.slice(1) : raw;
  const isLiteral = !hasGlobSpecial(body);
  const compiled = isLiteral ? compileLiteral(body) : compileWildcard(body);
  return { pattern: raw, body, negated, isLiteral, compiled };
};
