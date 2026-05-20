export interface IgnoreRule {
  /** Original input pattern (for diagnostics). */
  readonly pattern: string;
  /** True when the pattern starts with `!`. */
  readonly negated: boolean;
  /** True when the pattern ends with `/`. */
  readonly directoryOnly: boolean;
  /** True when the pattern contains `/` before any `*` (anchored to repo root). */
  readonly anchored: boolean;
  /** Compiled regex matching paths against the pattern. */
  readonly compiled: RegExp;
}

export type IgnoreRuleset = ReadonlyArray<IgnoreRule>;

const stripTrailingSpaces = (line: string): string => {
  // Trailing space is significant only when escaped (`\ `).
  let end = line.length;
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — when end===0, charCodeAt(-1) is NaN, so `NaN===0x20` is false and the loop exits regardless of the `end > 0` bound.
  while (end > 0 && line.charCodeAt(end - 1) === 0x20) {
    if (end >= 2 && line.charCodeAt(end - 2) === 0x5c) break; // backslash-space → preserve
    end -= 1;
  }
  return line.slice(0, end);
};

const unescapePattern = (s: string): string => {
  // Replace `\<char>` with `<char>` — preserves the literal char (e.g. `\#`, `\ `).
  return s.replace(/\\(.)/g, '$1');
};

import { compileGlob } from '../pathspec/index.js';

export const parseGitignore = (text: string): IgnoreRuleset => {
  const out: IgnoreRule[] = [];
  for (const rawLine of text.split('\n')) {
    // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent — the next guard `/^\s*$/.test(rawLine)` also skips the empty string, so removing/altering this fast-path guard cannot change which lines are kept.
    if (rawLine === '') continue;
    if (/^\s*$/.test(rawLine)) continue;
    // Comments start with `#` (unescaped) at line start.
    if (rawLine.startsWith('#')) continue;
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
    const cleanPattern = unescapePattern(stripped);
    const compiled = compileGlob(cleanPattern, { anchored });
    out.push({
      pattern: unescapePattern(trimmed),
      negated,
      directoryOnly,
      anchored,
      compiled,
    });
  }
  return out;
};
