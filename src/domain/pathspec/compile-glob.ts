// Glob compiler for the gitignore-family dialect: `parseGitignore` (.gitignore
// rules), `parseGitattributes` and `compileSparseRule` (non-cone sparse).
//
// The dialect is git's wildmatch with WM_PATHNAME: `*` matches a run of
// non-`/` bytes, a whole-component `**` crosses `/`, `?` and `[…]` classes
// match one non-`/` byte, and `\` escapes the byte after it. A pattern git
// aborts on (an unterminated `[`, an unknown `[:name:]`, a trailing `\`)
// matches nothing. Matching is byte-wise on the path's bytes, and
// `caseFold` folds ASCII case as git's ignorecase does.
//
// The pattern compiles once to wildmatch tokens, matched by a LINEAR,
// non-backtracking program. Before it runs, git's three fast paths answer
// what they can from the pattern text alone: a pure literal, a leading `*`
// followed by plain text (ENDSWITH), and a literal prefix every match must
// carry. See docs/design/compile-glob-redos.md and docs/adr/077-linear-glob-matcher.md.
//
// See docs/adr/040-extracted-compile-glob.md.

import { LEADING_DIRECTORIES, matchWildmatch, tokenizeWildmatch } from '../glob/wildmatch.js';
import { encode, encodeEscaped } from '../objects/encoding.js';
import { asciiLower } from '../pretty/ascii.js';

export interface CompileGlobOptions {
  /** When true, the match is anchored at the start of the path. */
  readonly anchored: boolean;
  /** Fold ASCII case as git's core.ignorecase does: plain pattern bytes and the path compare case-insensitively; escaped bytes and set members stay exact, as in git. */
  readonly caseFold?: boolean;
}

/** A compiled glob — `test` reports whether a path matches the pattern. */
export interface GlobMatcher {
  test(path: string): boolean;
}

/** `true`/`false` is final; `undefined` leaves the verdict to the wildmatch program. */
type Shortcut = (text: string) => boolean | undefined;

const NEVER: GlobMatcher = { test: () => false };
const UNDECIDED: Shortcut = () => undefined;
const SEPARATOR = '/';
const STAR = '*';
const GLOB_SPECIALS: ReadonlySet<string> = new Set(['*', '?', '[', '\\']);

// git's `simple_length`: how far the pattern is plain text.
const simpleLength = (pattern: string): number => {
  for (let i = 0; i < pattern.length; i++) {
    if (GLOB_SPECIALS.has(pattern[i] as string)) return i;
  }
  return pattern.length;
};

const literalShortcut = (literal: string, anchored: boolean): Shortcut =>
  anchored
    ? (text) => text === literal
    : (text) => text === literal || text.endsWith(SEPARATOR + literal);

const endsWithShortcut =
  (suffix: string): Shortcut =>
  (text) =>
    text.endsWith(suffix);

const prefixShortcut = (prefix: string, anchored: boolean): Shortcut => {
  const inner = SEPARATOR + prefix;
  return anchored
    ? (text) => (text.startsWith(prefix) ? undefined : false)
    : (text) => (text.startsWith(prefix) || text.includes(inner) ? undefined : false);
};

const isEndsWith = (pattern: string, anchored: boolean): boolean =>
  !anchored && pattern[0] === STAR && simpleLength(pattern.slice(1)) === pattern.length - 1;

const shortcutOf = (pattern: string, anchored: boolean, caseFold: boolean): Shortcut => {
  const text = caseFold ? asciiLower(pattern) : pattern;
  const plain = simpleLength(text);
  if (plain === text.length) return literalShortcut(text, anchored);
  if (isEndsWith(text, anchored)) return endsWithShortcut(text.slice(1));
  if (plain > 0) return prefixShortcut(text.slice(0, plain), anchored);
  return UNDECIDED;
};

// A rule set tests one path against every rule: the fold of the last path is
// kept so it is paid once per path, not once per rule. It caches a pure
// function of the path, so it cannot change a verdict.
let lastFold: { readonly path: string; readonly folded: string } | undefined;

const foldOnce = (path: string): string => {
  // Equivalent mutant, deliberately not suppressed — a line-level disable would also silence the detected mutants sharing this line. folding on every call returns the same text as reusing the kept fold of the same path; only the cost differs, which the performance suite gates.
  if (lastFold?.path !== path) lastFold = { path, folded: asciiLower(path) };
  return lastFold.folded;
};

export const compileGlob = (pattern: string, options: CompileGlobOptions): GlobMatcher => {
  const caseFold = options.caseFold === true;
  const tokens = tokenizeWildmatch(encode(pattern), { pathname: true, caseFold });
  if (tokens === undefined) return NEVER;
  const program = options.anchored ? tokens : [LEADING_DIRECTORIES, ...tokens];
  const shortcut = shortcutOf(pattern, options.anchored, caseFold);
  return {
    test: (path) => {
      const text = caseFold ? foldOnce(path) : path;
      return shortcut(text) ?? matchWildmatch(program, encodeEscaped(text));
    },
  };
};
