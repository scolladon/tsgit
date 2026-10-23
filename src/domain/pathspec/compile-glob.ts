// Glob compiler for the gitignore-family dialect: `parseGitignore` (.gitignore
// rules), `parseGitattributes` and `compileSparseRule` (non-cone sparse).
// Supports `*`, `?`, `**`, `**/` under git's WM_PATHNAME star rule:
//
// - `*` matches any run except `/` — i.e. one path segment.
// - A run of two or more stars matches any run including `/` only when it is a
//   whole path component (preceded by the pattern start or `/`, followed by the
//   end or `/`); any other run (`a**b`, `d/**b`) is a single `*`. When
//   followed by `/`, the `/` is absorbed so `**/` spans zero or more whole
//   `<segment>/` runs.
// - `?` matches exactly one non-`/` character.
//
// A pattern compiles to a LINEAR, non-backtracking matcher: it is tokenised
// once, then matched with a backward dynamic program that fills a boolean
// table in `O(tokenCount × pathLength)`. No input — not even an adversarial
// `a*a*…*b` — can make it super-linear. See docs/design/compile-glob-redos.md
// and docs/adr/077-linear-glob-matcher.md.
//
// In this dialect `[…]` and `\` are matched verbatim: with no regex involved,
// every non-glob character is a literal.
//
// See docs/adr/040-extracted-compile-glob.md.

export interface CompileGlobOptions {
  /** When true, the match is anchored at the start of the path. */
  readonly anchored: boolean;
  /**
   * When true, the matcher also accepts any descendant of the pattern: a
   * literal `src` matches `src`, `src/foo`, and `src/a/b`.
   */
  readonly withDirSuffix?: boolean;
}

/** A compiled glob — `test` reports whether a path matches the pattern. */
export interface GlobMatcher {
  test(path: string): boolean;
}

// One scanned unit of a glob pattern.
type GlobToken =
  | { readonly kind: 'literal'; readonly char: string } // one verbatim char
  | { readonly kind: 'single' } //  `?`  — one non-`/` char
  | { readonly kind: 'star' } //    `*`  — a run of non-`/` chars
  | { readonly kind: 'star-star' } // `**` (no trailing `/`) — a run of any char
  | { readonly kind: 'star-slash' }; // `**/` — zero or more `<segment>/` runs

interface ScannedToken {
  readonly token: GlobToken;
  readonly next: number;
}

// `(^|.*/)` — the unanchored prefix — is exactly `(.*/)?`, i.e. one `star-slash`.
const PREFIX_TOKEN: GlobToken = { kind: 'star-slash' };

const STAR = '*';
const SEPARATOR = '/';
const STAR_TOKEN: GlobToken = { kind: 'star' };

const endOfStarRun = (pattern: string, start: number): number => {
  let end = start;
  while (pattern[end] === STAR) end += 1;
  return end;
};

const isWholeComponent = (pattern: string, start: number, end: number): boolean =>
  (start === 0 || pattern[start - 1] === SEPARATOR) &&
  (end === pattern.length || pattern[end] === SEPARATOR);

// git's wildmatch under WM_PATHNAME: the whole star run is one token, and only
// a run of two or more forming a whole path component may cross a `/`.
const scanPathnameStar = (pattern: string, i: number): ScannedToken => {
  const end = endOfStarRun(pattern, i);
  const spansDirectories = end - i > 1 && isWholeComponent(pattern, i, end);
  if (!spansDirectories) return { token: STAR_TOKEN, next: end };
  if (pattern[end] === SEPARATOR) return { token: { kind: 'star-slash' }, next: end + 1 };
  return { token: { kind: 'star-star' }, next: end };
};

const scanToken = (pattern: string, i: number): ScannedToken => {
  const ch = pattern[i] as string;
  if (ch === STAR) return scanPathnameStar(pattern, i);
  if (ch === '?') return { token: { kind: 'single' }, next: i + 1 };
  return { token: { kind: 'literal', char: ch }, next: i + 1 };
};

const tokenize = (pattern: string): GlobToken[] => {
  const tokens: GlobToken[] = [];
  let i = 0;
  while (i < pattern.length) {
    const scanned = scanToken(pattern, i);
    tokens.push(scanned.token);
    i = scanned.next;
  }
  return tokens;
};

// The dynamic-program layers below are `Uint8Array` of 0/1 — `dp[j] === 1`
// means "the tokens processed so far match `path[j..]`". Each `step*` derives
// a new layer from `next`, the layer for the tokens that follow it.

const stepLiteral = (char: string, path: string, next: Uint8Array): Uint8Array => {
  const cur = new Uint8Array(path.length + 1);
  // Stryker disable next-line EqualityOperator: equivalent — `j <= path.length` adds an iteration at `j = path.length` where `path[j]` is `undefined`; `undefined === char` is false, so `cur[path.length]` keeps its correct 0.
  for (let j = 0; j < path.length; j++) {
    if (path[j] === char && next[j + 1] === 1) cur[j] = 1;
  }
  return cur;
};

const stepSingle = (path: string, next: Uint8Array): Uint8Array => {
  const cur = new Uint8Array(path.length + 1);
  // Stryker disable next-line EqualityOperator: equivalent — `j <= path.length` adds an iteration at `j = path.length`; `next[j + 1]` is then out of bounds (`undefined`), failing the `next[j + 1] === 1` operand, so `cur[path.length]` keeps its correct 0.
  for (let j = 0; j < path.length; j++) {
    if (path[j] !== '/' && next[j + 1] === 1) cur[j] = 1;
  }
  return cur;
};

// `*` — match zero or more non-`/` chars: stop here (`next[j]`) or consume
// `path[j]` if it is not a `/` and continue within the same star (`cur[j+1]`).
const stepStar = (path: string, next: Uint8Array): Uint8Array => {
  const cur = new Uint8Array(path.length + 1);
  cur[path.length] = next[path.length] === 1 ? 1 : 0;
  // Stryker disable next-line ArithmeticOperator: equivalent — starting at `path.length + 1` adds two no-op iterations: the out-of-bounds write is dropped by the typed array, and `j = path.length` recomputes `cur[path.length]` to the value just assigned above.
  for (let j = path.length - 1; j >= 0; j--) {
    cur[j] = next[j] === 1 || (path[j] !== '/' && cur[j + 1] === 1) ? 1 : 0;
  }
  return cur;
};

// `**` — match zero or more of ANY char (slashes included). A whole-component
// star run without a trailing `/` can only end the pattern, so the layer it
// precedes is the base layer, which accepts the end of the path: every suffix
// matches.
const stepStarStar = (path: string): Uint8Array => new Uint8Array(path.length + 1).fill(1);

// `**/` ≡ `(.*/)?` — match the empty string (`next[j]`) OR any consumed run
// that ends on a `/`. `seg[j] === 1` is the latter: from `j`, some non-empty
// run ends on a `/` and the following tokens match the remainder.
const stepStarSlash = (path: string, next: Uint8Array): Uint8Array => {
  const seg = new Uint8Array(path.length + 1);
  // Stryker disable next-line ArithmeticOperator: equivalent — starting at `path.length + 1` adds two no-op iterations: the out-of-bounds write is dropped by the typed array, and `j = path.length` recomputes `seg[path.length]` to 0, the value it already holds.
  for (let j = path.length - 1; j >= 0; j--) {
    seg[j] = (path[j] === '/' && next[j + 1] === 1) || seg[j + 1] === 1 ? 1 : 0;
  }
  const cur = new Uint8Array(path.length + 1);
  for (let j = 0; j <= path.length; j++) {
    cur[j] = next[j] === 1 || seg[j] === 1 ? 1 : 0;
  }
  return cur;
};

const stepToken = (token: GlobToken, path: string, next: Uint8Array): Uint8Array => {
  switch (token.kind) {
    case 'literal':
      return stepLiteral(token.char, path, next);
    case 'single':
      return stepSingle(path, next);
    case 'star':
      return stepStar(path, next);
    case 'star-star':
      return stepStarStar(path);
    case 'star-slash':
      return stepStarSlash(path, next);
  }
};

// The base layer: with no tokens left, `path[j..]` must be exhausted — or,
// under `withDirSuffix`, sit exactly on a `/` (the `(/.*)?$` descendant
// accept: the pattern matched a path AND every deeper path beneath it).
const baseLayer = (path: string, withDirSuffix: boolean): Uint8Array => {
  const dp = new Uint8Array(path.length + 1);
  dp[path.length] = 1;
  if (withDirSuffix) {
    // Stryker disable next-line EqualityOperator: equivalent — `j <= path.length` adds an iteration at `j = path.length` where `path[j]` is `undefined`; `undefined === '/'` is false, so `dp[path.length]` keeps the 1 set above.
    for (let j = 0; j < path.length; j++) {
      if (path[j] === '/') dp[j] = 1;
    }
  }
  return dp;
};

const matchTokens = (
  tokens: ReadonlyArray<GlobToken>,
  options: CompileGlobOptions,
  path: string,
): boolean => {
  let dp = baseLayer(path, options.withDirSuffix === true);
  for (let i = tokens.length - 1; i >= 0; i--) {
    dp = stepToken(tokens[i] as GlobToken, path, dp);
  }
  // Unanchored: a leading `(^|.*/)` ≡ `(.*/)?` ≡ one trailing `star-slash`
  // step (it precedes every body token, so it is applied last).
  if (!options.anchored) dp = stepToken(PREFIX_TOKEN, path, dp);
  return dp[0] === 1;
};

export const compileGlob = (pattern: string, options: CompileGlobOptions): GlobMatcher => {
  const tokens = tokenize(pattern);
  return { test: (path: string): boolean => matchTokens(tokens, options, path) };
};
