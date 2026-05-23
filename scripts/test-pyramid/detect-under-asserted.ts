/**
 * Under-asserted unit scanner.
 *
 * Walks each unit test file with a small brace/paren-balanced scanner. For
 * every `it(...)` / `test(...)` block (with the exception of `.skip` /
 * `.todo` / `.fails` modifiers), counts the number of assertion calls in the
 * body and emits a finding when the count is below the manifest's threshold.
 *
 * Parser strategy: regex/brace. Comments, string literals, and template-literal
 * interpolations inside test bodies can produce false positives — that risk is
 * accepted because the audit is report-only.
 */
import { classifyTestFile } from './classify-test-file.ts';
import type { PyramidManifest } from './parse-manifest.ts';
import type { SourceFile } from './types.ts';

export interface UnderAssertedFinding {
  readonly path: string;
  readonly line: number;
  readonly title: string;
}

const SKIP_MODIFIERS = new Set(['skip', 'todo', 'fails']);
// `(?<!\.)` excludes method-call sites like `compiled.test(...)` and
// `it.each(...)` chains entered mid-expression; we only want top-level
// vitest test openers.
const OPENER_RE = /(?<!\.)\b(it|test)((?:\.\w+)*)\s*\(/g;
const ASSERTION_RE = /\b(?:expect|assert)\w*(?:<[^<>]*>)?(?:\.\w+)?\s*\(/g;

interface ItBlock {
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
    } else {
      if (c === '"' || c === "'" || c === '`') inString = c;
      else if (c === '(') depth += 1;
      else if (c === ')') {
        depth -= 1;
        if (depth === 0) return i;
      }
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

const scanItBlocks = (source: string): ReadonlyArray<ItBlock> => {
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

const countAssertions = (body: string): number => {
  let count = 0;
  for (const _hit of body.matchAll(ASSERTION_RE)) count += 1;
  return count;
};

export const detectUnderAsserted = (
  manifest: PyramidManifest,
  files: ReadonlyArray<SourceFile>,
): ReadonlyArray<UnderAssertedFinding> => {
  const heuristic = manifest.heuristics.underAssertedUnit;
  const findings: UnderAssertedFinding[] = [];
  for (const file of files) {
    if (classifyTestFile(manifest, file.path) !== heuristic.tier) continue;
    const blocks = scanItBlocks(file.source);
    for (const block of blocks) {
      if (block.isSkipped) continue;
      if (countAssertions(block.body) < heuristic.minAssertionsPerTest) {
        findings.push({ path: file.path, line: block.line, title: block.title });
      }
    }
  }
  findings.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });
  return findings;
};
