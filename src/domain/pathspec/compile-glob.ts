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

import {
  LEADING_DIRECTORIES,
  matchWildmatch,
  tokenizeWildmatch,
  type WildmatchToken,
} from '../glob/wildmatch.js';
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

interface Remembered<V> {
  readonly key: string;
  readonly value: V;
}

// A rule set tests one path against every rule, and attribute rules alternate
// between a path and its basename: the last two results of a pure function of
// the path are kept, so its work is paid once per path, not once per rule.
// Reusing a kept result returns what computing it again would, so no branch
// below can change a verdict: recomputing on every call differs only in cost,
// which the performance suite gates.
const remembering = <V>(compute: (key: string) => V): ((key: string) => V) => {
  let newer: Remembered<V> | undefined;
  let older: Remembered<V> | undefined;
  return (key) => {
    if (newer?.key === key) return newer.value;
    const hit = older;
    older = newer;
    newer = hit?.key === key ? hit : { key, value: compute(key) };
    return newer.value;
  };
};

const foldOnce = remembering(asciiLower);
const encodeOnce = remembering(encodeEscaped);

type FixedToken = Extract<WildmatchToken, { readonly kind: 'byte' | 'set' }>;

const isFixed = (token: WildmatchToken): token is FixedToken =>
  token.kind === 'byte' || token.kind === 'set';

// The tokens after the last star each consume exactly one byte, and a match
// must reach the end of the path: they name its last bytes.
const fixedTailOf = (tokens: ReadonlyArray<WildmatchToken>): ReadonlyArray<FixedToken> => {
  const reversed: FixedToken[] = [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i] as WildmatchToken;
    if (!isFixed(token)) break;
    reversed.push(token);
  }
  return reversed.reverse();
};

const admits = (token: FixedToken, byte: number): boolean =>
  token.kind === 'byte' ? token.value === byte : token.table[byte] === 1;

/** False when the path's last bytes cannot be the pattern's fixed tail: no table fill can match it. */
const endsWithTail = (tail: ReadonlyArray<FixedToken>, bytes: Uint8Array): boolean => {
  // A path shorter than the tail is read before its first byte: that is
  // `undefined`, which no token admits.
  const start = bytes.length - tail.length;
  return tail.every((token, offset) => admits(token, bytes[start + offset] as number));
};

export const compileGlob = (pattern: string, options: CompileGlobOptions): GlobMatcher => {
  const caseFold = options.caseFold === true;
  const tokens = tokenizeWildmatch(encode(pattern), { pathname: true, caseFold });
  if (tokens === undefined) return NEVER;
  const program = options.anchored ? tokens : [LEADING_DIRECTORIES, ...tokens];
  const shortcut = shortcutOf(pattern, options.anchored, caseFold);
  const tail = fixedTailOf(tokens);
  const matchBytes = (bytes: Uint8Array): boolean =>
    endsWithTail(tail, bytes) && matchWildmatch(program, bytes);
  return {
    test: (path) => {
      const text = caseFold ? foldOnce(path) : path;
      return shortcut(text) ?? matchBytes(encodeOnce(text));
    },
  };
};
