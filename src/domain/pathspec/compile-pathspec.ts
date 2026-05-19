import { compileGlob, containsGlob } from './compile-glob.js';

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
   * True when the body (post-`!`) contains no glob metacharacters.
   * Literal entries match the exact path AND any descendant — Git's
   * `git add src` semantics where `src` covers everything under it.
   */
  readonly isLiteral: boolean;
  /** Compiled regex. Always tested against the candidate path verbatim. */
  readonly compiled: RegExp;
}

export type Pathspec = ReadonlyArray<PathspecEntry>;

// Compile a list of pathspec patterns. Each pattern may begin with `!`
// to negate; the body is then auto-detected as a literal (no glob
// characters) or a glob.
//
// Literals are anchored at the start AND match descendants — `src`
// becomes the regex `^src(/.*)?$`.
//
// Globs are anchored only when the pattern contains a `/` before any
// glob character (mirrors `.gitignore`'s anchoring rule).
//
// See docs/adr/037-pathspec-auto-detect.md (detection) and
// docs/adr/038-pathspec-exclusion.md (negation).
export const compilePathspec = (patterns: ReadonlyArray<string>): Pathspec =>
  patterns.map(compileOne);

const compileOne = (raw: string): PathspecEntry => {
  const negated = raw.startsWith('!');
  const body = negated ? raw.slice(1) : raw;
  const isLiteral = !containsGlob(body);
  if (isLiteral) {
    return {
      pattern: raw,
      body,
      negated,
      isLiteral: true,
      compiled: compileGlob(body, { anchored: true, withDirSuffix: true }),
    };
  }
  return {
    pattern: raw,
    body,
    negated,
    isLiteral: false,
    compiled: compileGlob(body, { anchored: body.includes('/') }),
  };
};
