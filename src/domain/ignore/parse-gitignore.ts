import { compileGlob, type GlobMatcher } from '../pathspec/index.js';

export interface IgnoreRule {
  /** The line as written, after git's trailing-space trim (escapes kept). */
  readonly pattern: string;
  /** True when the pattern starts with `!`. */
  readonly negated: boolean;
  /** True when the pattern ends with `/`. */
  readonly directoryOnly: boolean;
  /** True when the pattern contains `/` before any `*` (anchored to repo root). */
  readonly anchored: boolean;
  /**
   * 1-based source line number this rule was parsed from. Tracks the SOURCE
   * position (gaps for comment / blank lines), not the rule index. Used by
   * `isIgnored` and other diagnostic tools that report "this path was ignored
   * by line N of <file>".
   */
  readonly lineNumber: number;
  /** Compiled glob matcher for paths against the pattern. */
  readonly compiled: GlobMatcher;
}

export type IgnoreRuleset = ReadonlyArray<IgnoreRule>;

/** A `.gitignore`-syntax line decomposed into its semantic parts. */
export interface TokenizedIgnoreLine {
  /** True when the line started with `!` (negation). */
  readonly negated: boolean;
  /** True when the pattern is anchored to the repo root (contains a `/`). */
  readonly anchored: boolean;
  /** True when the pattern ended with `/` (directory-only). */
  readonly directoryOnly: boolean;
  /** Pattern body — negation, trailing `/` and leading `/` removed; escapes kept for the matcher. */
  readonly cleanPattern: string;
}

const SPACE = ' ';
const BACKSLASH = '\\';

/**
 * Where a line's unescaped trailing spaces start, scanned forwards as git's
 * `trim_trailing_spaces` does: a backslash escapes the next character, and a
 * line ending on a lone backslash is left untrimmed.
 */
const trailingSpaceStart = (line: string): number | undefined => {
  let lastSpace: number | undefined;
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];
    if (char === SPACE) {
      lastSpace ??= at;
      continue;
    }
    if (char === BACKSLASH) at += 1;
    lastSpace = undefined;
  }
  return lastSpace;
};

/** `slice(0, undefined)` keeps the whole line when there is nothing to trim. */
export const stripTrailingSpaces = (line: string): string =>
  line.slice(0, trailingSpaceStart(line));

/**
 * Decompose a single `.gitignore`-syntax line into its semantic parts.
 *
 * Returns `undefined` for comment (`#`) and blank lines — the caller drops
 * them. Shared by `parseGitignore` and the sparse-checkout non-cone parser so
 * the comment/blank/escape/`!`-/`/`-handling lives in exactly one place.
 */
export const tokenizeIgnoreLine = (rawLine: string): TokenizedIgnoreLine | undefined => {
  // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent — the next guard `/^\s*$/.test(rawLine)` also skips the empty string, so removing/altering this fast-path guard cannot change which lines are kept.
  if (rawLine === '') return undefined;
  if (/^\s*$/.test(rawLine)) return undefined;
  // Comments start with `#` (unescaped) at line start.
  if (rawLine.startsWith('#')) return undefined;
  // Whitespace-only lines were filtered out above; stripTrailingSpaces
  // therefore returns a non-empty string for every surviving rawLine.
  const trimmed = stripTrailingSpaces(rawLine);
  const negated = trimmed.startsWith('!');
  const afterNegation = negated ? trimmed.slice(1) : trimmed;
  const directoryOnly = afterNegation.endsWith('/');
  const withoutTrailingSlash = directoryOnly ? afterNegation.slice(0, -1) : afterNegation;
  // Stryker disable next-line MethodExpression: equivalent — any string that startsWith '/' (or endsWith '/') necessarily also includes '/', so the left operand can never change the `||` result; it collapses to `includes('/')`.
  const anchored = withoutTrailingSlash.startsWith('/') || withoutTrailingSlash.includes('/');
  const stripped = withoutTrailingSlash.startsWith('/')
    ? withoutTrailingSlash.slice(1)
    : withoutTrailingSlash;
  return {
    negated,
    anchored,
    directoryOnly,
    cleanPattern: stripped,
  };
};

export const parseGitignore = (
  text: string,
  options: { readonly caseFold?: boolean } = {},
): IgnoreRuleset => {
  const out: IgnoreRule[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] as string;
    const tokenized = tokenizeIgnoreLine(rawLine);
    if (tokenized === undefined) continue;
    const { negated, anchored, directoryOnly, cleanPattern } = tokenized;
    out.push({
      pattern: stripTrailingSpaces(rawLine),
      negated,
      directoryOnly,
      anchored,
      lineNumber: i + 1,
      compiled: compileGlob(cleanPattern, { anchored, caseFold: options.caseFold === true }),
    });
  }
  return out;
};
