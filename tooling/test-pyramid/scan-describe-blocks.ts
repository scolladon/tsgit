/**
 * Sibling scanner for vitest `describe(...)` blocks.
 *
 * Mirrors `scanItBlocks` (paren/brace walker, same skip modifiers,
 * same `each`-aware title position logic). Emits the open/close
 * offsets so callers can join `it()` records to their describe
 * ancestors via source-offset containment (see ADR-118 and
 * detect-bad-title.ts).
 */

const SKIP_MODIFIERS = new Set(['skip', 'todo', 'fails']);
// Modifier chain segments that wrap the title in a SECOND `(…)` call:
//   describe.each([…])('title', body)
//   describe.skipIf(cond)('title', body)
//   describe.runIf(cond)('title', body)
// See ADR-120 for the `isSkipped` choice on skipIf/runIf.
const TWO_STAGE_MODIFIERS = new Set(['each', 'skipIf', 'runIf']);
const OPENER_RE = /(?<!\.)\bdescribe((?:\.\w+)*)\s*\(/g;

export interface DescribeBlock {
  readonly line: number;
  readonly title: string;
  readonly openIdx: number;
  readonly closeIdx: number;
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

export const scanDescribeBlocks = (source: string): ReadonlyArray<DescribeBlock> => {
  const blocks: DescribeBlock[] = [];
  // No "consumed/skipped" range tracking: OPENER_RE requires `describe`
  // before the `(`, and the body of a describe contains arrow-function `(`
  // and arbitrary call-site `(` — none preceded by `describe`. Nested
  // describes inside an outer body (including inside the body of a
  // `describe.each(...)('title', () => {…})`) must be captured.

  for (const match of source.matchAll(OPENER_RE)) {
    const opener = match.index ?? -1;
    if (opener < 0) continue;
    const chain = match[1] ?? '';
    const chainKeys = chain.split('.').filter((seg) => seg.length > 0);
    const isSkipped = chainKeys.some((seg) => SKIP_MODIFIERS.has(seg));
    const isTwoStage = chainKeys.some((seg) => TWO_STAGE_MODIFIERS.has(seg));

    const matchEnd = opener + match[0].length;
    const openParen = matchEnd - 1;
    const closeParen = findMatchingClose(source, openParen);
    if (closeParen < 0) continue;

    let titleStart = openParen + 1;
    let bodyEnd = closeParen;

    if (isTwoStage) {
      let next = closeParen + 1;
      while (next < source.length && isWhitespace(source[next]!)) next += 1;
      if (source[next] !== '(') continue;
      const innerOpen = next;
      const innerClose = findMatchingClose(source, innerOpen);
      if (innerClose < 0) continue;
      titleStart = innerOpen + 1;
      bodyEnd = innerClose;
    }

    const { title } = extractTitle(source, titleStart);
    if (title === null) continue;

    blocks.push({
      line: lineAt(source, opener),
      title,
      openIdx: opener,
      closeIdx: bodyEnd,
      isSkipped,
    });
  }
  return blocks;
};
