/**
 * Shared paren/brace scanner for vitest `it(...)` / `test(...)` blocks.
 *
 * Used by every per-heuristic detector in `tooling/test-pyramid/**`. Strategy
 * mirrors ADR-097's regex/brace approach: locate each top-level test opener,
 * extract the literal title, and slice the body out to the matching close
 * paren. Comments, string literals, and template-literal interpolations
 * inside test bodies can produce false positives — that risk is accepted
 * because the audit is documented as regex-only.
 */

// Modifier chain segments whose presence marks a test as skipped.
const SKIP_MODIFIERS = new Set(['skip', 'todo', 'fails']);
// Modifier chain segments that wrap the title in a SECOND `(…)` call:
//   it.each([…])('title', body)
//   it.skipIf(cond)('title', body)
//   it.runIf(cond)('title', body)
// The first parens hold an array / condition; the title sits in the next
// parens. `isSkipped` semantics for skipIf/runIf are defined in ADR-120:
// the static scanner cannot evaluate the condition, so these blocks emit
// `isSkipped: false` (like `each`) unless an explicit `skip`/`todo`/`fails`
// is also chained.
const TWO_STAGE_MODIFIERS = new Set(['each', 'skipIf', 'runIf']);
// `(?<!\.)` excludes method-call sites like `compiled.test(...)` and
// `it.each(...)` chains entered mid-expression; we only want top-level
// vitest test openers.
const OPENER_RE = /(?<!\.)\b(it|test)((?:\.\w+)*)\s*\(/g;

export interface ItBlock {
  readonly line: number;
  readonly title: string;
  readonly body: string;
  readonly isSkipped: boolean;
  // Offset of the opener within `source` (e.g. start of `it` / `test`).
  // Used by detect-bad-title to join `it()` records to their describe
  // ancestors via source-offset containment (ADR-118).
  readonly openIdx: number;
}

const lineAt = (source: string, idx: number): number => {
  let line = 1;
  for (let i = 0; i < idx; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
};

const isWhitespace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

// A `/` opens a /regex/ literal (rather than being division) when the last
// significant character before it implies "start of an expression" — an
// operator, opening bracket, or separator. Division (`a / b`) is always
// preceded by an identifier/number/`)`/`]`, none of which are in this set.
const REGEX_CONTEXT_RE = /[(,=:;!&|?{[+\-*%<>~^]/;

// Keywords whose trailing token also implies "start of an expression" —
// `return /re/`, `typeof /re/`, `case /re/:`, … A regex literal directly
// following one of these (rather than an operator/bracket) was previously
// mis-scanned as division, which can desync findMatchingClose on an escaped
// character inside the regex and silently drop an enclosing block.
const REGEX_CONTEXT_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'void',
  'delete',
  'instanceof',
  'yield',
]);

const isIdentChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);

// The identifier run ending exactly at `endExclusive` (exclusive), or `null`
// if the character immediately before it is not an identifier character.
const wordEndingAt = (source: string, endExclusive: number): string | null => {
  let start = endExclusive;
  while (start > 0 && isIdentChar(source[start - 1]!)) start -= 1;
  return start === endExclusive ? null : source.slice(start, endExclusive);
};

const isRegexContext = (source: string, slashIdx: number): boolean => {
  let j = slashIdx - 1;
  while (j >= 0 && isWhitespace(source[j]!)) j -= 1;
  if (j < 0) return true;
  if (REGEX_CONTEXT_RE.test(source[j]!)) return true;
  const word = wordEndingAt(source, j + 1);
  return word !== null && REGEX_CONTEXT_KEYWORDS.has(word);
};

// Skips a /regex/flags literal as an atomic unit. Quotes and parens inside
// it (including inside a [...] character class, where `/` is not special)
// must not affect the caller's paren-depth or string-tracking state —
// without this, e.g. `/name '([^']+)'/` desyncs the scanner: the first `'`
// looks like a string open, the second like its close, and the group's `)`
// then decrements depth for a paren that was never really counted.
const skipRegexLiteral = (source: string, slashIdx: number): number => {
  let i = slashIdx + 1;
  let inClass = false;
  while (i < source.length) {
    const c = source[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '\n') return -1;
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      i += 1;
      break;
    }
    i += 1;
  }
  while (i < source.length && /[a-z]/i.test(source[i]!)) i += 1;
  return i;
};

// Skips a "..."/'...'/`...` string literal from its opening quote to just
// past its closing quote (backslash escapes the next character). Unterminated
// input is consumed to EOF — the caller's length guard then ends the scan.
const skipStringLiteral = (source: string, quoteIdx: number): number => {
  const quote = source[quoteIdx];
  let i = quoteIdx + 1;
  while (i < source.length) {
    const c = source[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i += 1;
  }
  return source.length;
};

// EOF without trailing newline: skip to end-of-input rather than bailing
// out — the caller's length guard will terminate the scan.
const skipLineComment = (source: string, slashIdx: number): number => {
  const nl = source.indexOf('\n', slashIdx + 2);
  return nl < 0 ? source.length : nl + 1;
};

const skipBlockComment = (source: string, slashIdx: number): number => {
  const end = source.indexOf('*/', slashIdx + 2);
  return end < 0 ? -1 : end + 2;
};

type TokenSkip =
  | { readonly kind: 'skip'; readonly next: number }
  | { readonly kind: 'abort' }
  | { readonly kind: 'none' };

// Recognizes and skips a string literal, line comment, block comment, or
// regex literal starting at `i`. Returns `none` when `i` starts none of
// these — the caller falls through to plain paren/char handling.
const skipSpecialToken = (source: string, i: number): TokenSkip => {
  const c = source[i]!;
  if (c === '"' || c === "'" || c === '`') {
    return { kind: 'skip', next: skipStringLiteral(source, i) };
  }
  if (c === '/' && source[i + 1] === '/') {
    return { kind: 'skip', next: skipLineComment(source, i) };
  }
  if (c === '/' && source[i + 1] === '*') {
    const after = skipBlockComment(source, i);
    return after < 0 ? { kind: 'abort' } : { kind: 'skip', next: after };
  }
  if (c === '/' && isRegexContext(source, i)) {
    const after = skipRegexLiteral(source, i);
    return after < 0 ? { kind: 'abort' } : { kind: 'skip', next: after };
  }
  return { kind: 'none' };
};

const findMatchingClose = (source: string, openIdx: number): number => {
  if (source[openIdx] !== '(') return -1;
  let depth = 1;
  let i = openIdx + 1;
  while (i < source.length) {
    const token = skipSpecialToken(source, i);
    if (token.kind === 'abort') return -1;
    if (token.kind === 'skip') {
      i = token.next;
      continue;
    }
    const c = source[i]!;
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
};

interface TitleSpan {
  readonly title: string | null;
  readonly afterIdx: number;
}

const extractTitle = (source: string, fromIdx: number): TitleSpan => {
  let i = fromIdx;
  while (i < source.length && isWhitespace(source[i]!)) i += 1;
  const quote = source[i];
  if (quote !== '"' && quote !== "'" && quote !== '`') {
    return { title: null, afterIdx: i };
  }
  i += 1;
  const start = i;
  while (i < source.length) {
    const c = source[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) {
      return { title: source.slice(start, i), afterIdx: i + 1 };
    }
    i += 1;
  }
  return { title: null, afterIdx: i };
};

interface OpenerSpan {
  readonly titleStart: number;
  readonly bodyEnd: number;
  readonly consumedEnd: number;
}

// Resolves the title/body span for a two-stage opener like
// `it.each([…])('title', body)` — the inner call immediately following the
// outer call's matching close. Returns `null` if that inner call is missing
// or never closes (dropped silently, per ADR-097).
const resolveTwoStageSpan = (source: string, closeParen: number): OpenerSpan | null => {
  let next = closeParen + 1;
  while (next < source.length && isWhitespace(source[next]!)) next += 1;
  if (source[next] !== '(') return null;
  const innerClose = findMatchingClose(source, next);
  if (innerClose < 0) return null;
  return { titleStart: next + 1, bodyEnd: innerClose, consumedEnd: innerClose + 1 };
};

export const scanItBlocks = (source: string): ReadonlyArray<ItBlock> => {
  const blocks: ItBlock[] = [];
  const consumed: Array<readonly [number, number]> = [];
  const isInsideConsumed = (idx: number): boolean =>
    consumed.some(([start, end]) => idx >= start && idx < end);

  for (const match of source.matchAll(OPENER_RE)) {
    const opener = match.index ?? -1;
    if (opener < 0 || isInsideConsumed(opener)) continue;
    const chain = match[2] ?? '';
    const chainKeys = chain.split('.').filter((seg) => seg.length > 0);
    const isSkipped = chainKeys.some((seg) => SKIP_MODIFIERS.has(seg));
    const isTwoStage = chainKeys.some((seg) => TWO_STAGE_MODIFIERS.has(seg));

    const matchEnd = opener + match[0].length;
    const openParen = matchEnd - 1;
    const closeParen = findMatchingClose(source, openParen);
    if (closeParen < 0) continue;

    const singleStageSpan: OpenerSpan = {
      titleStart: openParen + 1,
      bodyEnd: closeParen,
      consumedEnd: closeParen + 1,
    };
    const span = isTwoStage ? resolveTwoStageSpan(source, closeParen) : singleStageSpan;
    if (span === null) {
      consumed.push([opener, closeParen + 1]);
      continue;
    }

    const { title, afterIdx } = extractTitle(source, span.titleStart);
    consumed.push([opener, span.consumedEnd]);
    if (title === null) continue;

    const body = source.slice(afterIdx, span.bodyEnd);
    blocks.push({ line: lineAt(source, opener), title, body, isSkipped, openIdx: opener });
  }
  return blocks;
};
