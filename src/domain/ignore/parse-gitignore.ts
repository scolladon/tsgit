import { compileGlob, type GlobMatcher } from '../pathspec/index.js';

export interface IgnoreRule {
  /** Original input pattern (for diagnostics). */
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
  /** Pattern body — negation, trailing `/`, leading `/` and escapes removed. */
  readonly cleanPattern: string;
}

const stripTrailingSpaces = (line: string): string => {
  // Trailing space is significant only when escaped (`\ `).
  let end = line.length;
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — when end===0, charCodeAt(-1) is NaN, so `NaN===0x20` is false and the loop exits regardless of the `end > 0` bound.
  while (end > 0 && line.charCodeAt(end - 1) === 0x20) {
    // Stryker disable next-line ConditionalExpression: the left-operand mutant (`end >= 2` -> true) is equivalent — when `end === 1` the dropped guard lets `line.charCodeAt(-1)` evaluate to `NaN`, and `NaN === 0x5c` is `false`, so the branch is not taken either way. `end >= 2` is a defensive guard the NaN behaviour already makes redundant.
    if (end >= 2 && line.charCodeAt(end - 2) === 0x5c) break; // backslash-space → preserve
    end -= 1;
  }
  return line.slice(0, end);
};

const unescapePattern = (s: string): string => {
  // Replace `\<char>` with `<char>` — preserves the literal char (e.g. `\#`, `\ `).
  return s.replace(/\\(.)/g, '$1');
};

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
    cleanPattern: unescapePattern(stripped),
  };
};

export const parseGitignore = (text: string): IgnoreRuleset => {
  const out: IgnoreRule[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] as string;
    const tokenized = tokenizeIgnoreLine(rawLine);
    if (tokenized === undefined) continue;
    const { negated, anchored, directoryOnly, cleanPattern } = tokenized;
    out.push({
      pattern: unescapePattern(stripTrailingSpaces(rawLine)),
      negated,
      directoryOnly,
      anchored,
      lineNumber: i + 1,
      compiled: compileGlob(cleanPattern, { anchored }),
    });
  }
  return out;
};
