/**
 * Shared paren/brace scanner for vitest `it(...)` / `test(...)` blocks.
 *
 * Used by every per-heuristic detector in `scripts/test-pyramid/**`. Strategy
 * mirrors ADR-097's regex/brace approach: locate each top-level test opener,
 * extract the literal title, and slice the body out to the matching close
 * paren. Comments, string literals, and template-literal interpolations
 * inside test bodies can produce false positives — that risk is accepted
 * because the audit is documented as regex-only.
 */

// `skipIf`/`runIf` are conditional skip helpers; `concurrent.skip` chains
// land here via the chain-key scan. Treat any chain segment matching a
// skip modifier as a skip.
const SKIP_MODIFIERS = new Set(['skip', 'todo', 'fails', 'skipIf', 'runIf']);
// `(?<!\.)` excludes method-call sites like `compiled.test(...)` and
// `it.each(...)` chains entered mid-expression; we only want top-level
// vitest test openers.
const OPENER_RE = /(?<!\.)\b(it|test)((?:\.\w+)*)\s*\(/g;

export interface ItBlock {
  readonly line: number;
  readonly title: string;
  readonly body: string;
  readonly isSkipped: boolean;
}

const lineAt = (source: string, idx: number): number => {
  let line = 1;
  for (let i = 0; i < idx; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
};

const isWhitespace = (c: string): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r';

const findMatchingClose = (source: string, openIdx: number): number => {
  if (source[openIdx] !== '(') return -1;
  let depth = 1;
  let inString: string | null = null;
  let i = openIdx + 1;
  while (i < source.length) {
    const c = source[i]!;
    if (inString !== null) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      i += 1;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i + 2);
      // EOF without trailing newline: skip to end-of-input rather than
      // bailing out — the outer `i < source.length` guard will terminate.
      i = nl < 0 ? source.length : nl + 1;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') inString = c;
    else if (c === '(') depth += 1;
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
    const isEach = chainKeys.includes('each');

    const matchEnd = opener + match[0].length;
    const openParen = matchEnd - 1;
    const closeParen = findMatchingClose(source, openParen);
    if (closeParen < 0) continue;

    let titleStart = openParen + 1;
    let bodyEnd = closeParen;
    let consumedEnd = closeParen + 1;

    if (isEach) {
      let next = closeParen + 1;
      while (next < source.length && isWhitespace(source[next]!)) next += 1;
      if (source[next] !== '(') {
        consumed.push([opener, consumedEnd]);
        continue;
      }
      const innerOpen = next;
      const innerClose = findMatchingClose(source, innerOpen);
      if (innerClose < 0) {
        consumed.push([opener, consumedEnd]);
        continue;
      }
      titleStart = innerOpen + 1;
      bodyEnd = innerClose;
      consumedEnd = innerClose + 1;
    }

    const { title, afterIdx } = extractTitle(source, titleStart);
    consumed.push([opener, consumedEnd]);
    if (title === null) continue;

    const body = source.slice(afterIdx, bodyEnd);
    blocks.push({ line: lineAt(source, opener), title, body, isSkipped });
  }
  return blocks;
};
