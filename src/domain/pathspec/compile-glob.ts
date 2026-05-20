// Glob-to-regex compiler shared between `parseGitignore` (.gitignore
// rules) and `compilePathspec`. Supports `*`, `?`, and
// `**`:
//
// - `*` matches any byte run except `/` — i.e. one path segment.
// - `**` matches any byte run including `/` — any number of segments.
//  When followed by `/`, the `/` is absorbed so a leading `**` plus
//  slash matches both an unprefixed and a deeply-prefixed path.
// - `?` matches exactly one non-`/` byte.
//
// Regex specials (`. + ^ $ { } | [ ] \`) inside the pattern are
// escaped verbatim. Character classes `[abc]` are NOT supported in v1.
//
// See docs/adr/040-extracted-compile-glob.md.

export interface CompileGlobOptions {
  /** When true, the regex is anchored at the start. */
  readonly anchored: boolean;
  /**
   * When true, the compiled regex also matches any descendant of the
   * pattern: a literal `src` matches `src`, `src/foo`, and `src/a/b`.
   * Used by `compilePathspec` for literal-as-directory semantics.
   */
  readonly withDirSuffix?: boolean;
}

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/;

export const compileGlob = (pattern: string, options: CompileGlobOptions): RegExp => {
  let body = '';
  let i = 0;
  while (i < pattern.length) {
    const consumed = consumeToken(pattern, i);
    body += consumed.regex;
    i = consumed.next;
  }
  const prefix = options.anchored ? '^' : '(^|.*/)';
  const suffix = options.withDirSuffix === true ? '(/.*)?$' : '$';
  return new RegExp(`${prefix}${body}${suffix}`);
};

interface ConsumedToken {
  readonly regex: string;
  readonly next: number;
}

const consumeToken = (pattern: string, i: number): ConsumedToken => {
  const ch = pattern[i] as string;
  if (ch === '*') return consumeStar(pattern, i);
  if (ch === '?') return { regex: '[^/]', next: i + 1 };
  return { regex: REGEX_SPECIALS.test(ch) ? `\\${ch}` : ch, next: i + 1 };
};

const consumeStar = (pattern: string, i: number): ConsumedToken => {
  if (pattern[i + 1] !== '*') {
    return { regex: '[^/]*', next: i + 1 };
  }
  const after = i + 2;
  // `**` matches across path segments. Two shapes:
  //  - `**/` consumed-trailing form: matches zero-or-more
  //  SEGMENT/ runs (each ending with `/`). Compiled as `(.*/)?`
  //  so `a/**/c` matches `a/c` AND `a/b/c` but NOT `a/xc`.
  //  - `**` alone (no trailing `/`): matches any character run
  //  including `/`. Compiled as `.*`.
  if (pattern[after] === '/') {
    return { regex: '(.*/)?', next: after + 1 };
  }
  return { regex: '.*', next: after };
};

// True iff `pattern` contains a glob metacharacter (`*` or `?`). Used
// by `compilePathspec` to auto-detect literal vs glob patterns.
// See docs/adr/037-pathspec-auto-detect.md.
//
// `[` and `]` are NOT considered glob metacharacters in v1 because
// `compileGlob` does not support character classes.
export const containsGlob = (pattern: string): boolean =>
  pattern.includes('*') || pattern.includes('?');
