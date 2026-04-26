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

const compilePattern = (pattern: string, anchored: boolean): RegExp => {
  // Convert glob to regex.
  let body = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**` matches zero or more path segments; eat a trailing `/` so
        // `**/foo` matches both `foo` and `a/b/foo`.
        body += '.*';
        i += 2;
        if (pattern[i] === '/') i += 1;
        continue;
      }
      // Single `*` matches anything except `/`
      body += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      body += '[^/]';
      i += 1;
      continue;
    }
    body += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    i += 1;
  }
  // Anchored = match from repo root; not anchored = match anywhere in path
  const prefix = anchored ? '^' : '(^|.*/)';
  return new RegExp(`${prefix}${body}$`);
};

export const parseGitignore = (text: string): IgnoreRuleset => {
  const out: IgnoreRule[] = [];
  for (const rawLine of text.split('\n')) {
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
    const anchored = withoutTrailingSlash.startsWith('/') || withoutTrailingSlash.includes('/');
    const stripped = withoutTrailingSlash.startsWith('/')
      ? withoutTrailingSlash.slice(1)
      : withoutTrailingSlash;
    const cleanPattern = unescapePattern(stripped);
    const compiled = compilePattern(cleanPattern, anchored);
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
