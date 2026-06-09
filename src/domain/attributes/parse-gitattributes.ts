import { compileGlob, type GlobMatcher } from '../pathspec/index.js';
import type { AttributeValue } from './attribute-value.js';

/** A single `.gitattributes` pattern line and the attributes it assigns. */
export interface AttributeRule {
  /** Pattern as written (post-unquote, pre-anchor-strip) — the round-trip source form. */
  readonly pattern: string;
  /** True when the pattern is anchored to the file's directory (leading or interior `/`). */
  readonly anchored: boolean;
  /** True when the pattern ends with `/` (directory-only). */
  readonly directoryOnly: boolean;
  /** 1-based source line number (tracks comment / blank gaps). */
  readonly lineNumber: number;
  /** Compiled glob, matched against a path relative to the source's basedir. */
  readonly compiled: GlobMatcher;
  /** Attribute assignments, last-token-wins within the line. */
  readonly attributes: ReadonlyMap<string, AttributeValue>;
}

/** A `[attr]<name> <tokens...>` macro definition. */
export interface MacroDef {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, AttributeValue>;
}

export interface ParsedAttributes {
  readonly rules: ReadonlyArray<AttributeRule>;
  readonly macros: ReadonlyArray<MacroDef>;
}

const MACRO_PREFIX = '[attr]';

const unescapeQuotedChar = (ch: string): string => {
  if (ch === 't') return '\t';
  if (ch === 'n') return '\n';
  if (ch === 'r') return '\r';
  return ch; // `\\`, `\"`, and any other escape collapse to the literal char.
};

/** Parse a leading `"…"` C-quoted token; returns its value and the index past the close. */
const parseQuoted = (line: string): { readonly value: string; readonly end: number } => {
  let value = '';
  let i = 1;
  while (i < line.length) {
    const ch = line[i] as string;
    if (ch === '\\') {
      const next = line[i + 1];
      if (next === undefined) break;
      value += unescapeQuotedChar(next);
      i += 2;
      continue;
    }
    if (ch === '"') {
      i += 1;
      break;
    }
    value += ch;
    i += 1;
  }
  return { value, end: i };
};

/** Split the pattern (possibly `"…"`-quoted) off the front, returning it + the remainder. */
const readPattern = (line: string): { readonly pattern: string; readonly rest: string } => {
  if (line.startsWith('"')) {
    const { value, end } = parseQuoted(line);
    return { pattern: value, rest: line.slice(end) };
  }
  const ws = line.search(/\s/);
  if (ws === -1) return { pattern: line, rest: '' };
  return { pattern: line.slice(0, ws), rest: line.slice(ws) };
};

const splitWhitespace = (s: string): ReadonlyArray<string> =>
  s.split(/\s+/).filter((t) => t !== '');

const parseAttributeToken = (
  token: string,
): { readonly name: string; readonly value: AttributeValue } | undefined => {
  if (token.startsWith('-')) {
    const name = token.slice(1);
    return name === '' ? undefined : { name, value: false };
  }
  if (token.startsWith('!')) {
    const name = token.slice(1);
    return name === '' ? undefined : { name, value: 'unspecified' };
  }
  const eq = token.indexOf('=');
  if (eq !== -1) {
    const name = token.slice(0, eq);
    return name === '' ? undefined : { name, value: { set: token.slice(eq + 1) } };
  }
  return { name: token, value: true };
};

const parseAttributeTokens = (tokens: ReadonlyArray<string>): Map<string, AttributeValue> => {
  const attributes = new Map<string, AttributeValue>();
  for (const token of tokens) {
    const parsed = parseAttributeToken(token);
    if (parsed === undefined) continue;
    attributes.set(parsed.name, parsed.value); // last token wins
  }
  return attributes;
};

/** Decompose a pattern into anchor / directory-only flags and the compiled glob body. */
const derivePattern = (
  pattern: string,
): { readonly anchored: boolean; readonly directoryOnly: boolean; readonly body: string } => {
  const directoryOnly = pattern.endsWith('/');
  const afterSlash = directoryOnly ? pattern.slice(0, -1) : pattern;
  const anchored = afterSlash.includes('/');
  const body = afterSlash.startsWith('/') ? afterSlash.slice(1) : afterSlash;
  return { anchored, directoryOnly, body };
};

const buildRule = (pattern: string, rest: string, lineNumber: number): AttributeRule => {
  const { anchored, directoryOnly, body } = derivePattern(pattern);
  return {
    pattern,
    anchored,
    directoryOnly,
    lineNumber,
    compiled: compileGlob(body, { anchored }),
    attributes: parseAttributeTokens(splitWhitespace(rest)),
  };
};

const buildMacro = (rest: string): MacroDef | undefined => {
  const tokens = splitWhitespace(rest);
  const [name, ...attrTokens] = tokens;
  if (name === undefined) return undefined;
  return { name, attributes: parseAttributeTokens(attrTokens) };
};

/** Parse `.gitattributes` text into pattern rules + macro definitions. */
export const parseGitattributes = (text: string): ParsedAttributes => {
  const rules: AttributeRule[] = [];
  const macros: MacroDef[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] as string).trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith(MACRO_PREFIX)) {
      const macro = buildMacro(line.slice(MACRO_PREFIX.length));
      if (macro !== undefined) macros.push(macro);
      continue;
    }
    const { pattern, rest } = readPattern(line);
    rules.push(buildRule(pattern, rest, i + 1));
  }
  return { rules, macros };
};
