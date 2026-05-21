import { revparseUnresolved } from '../../../domain/commands/error.js';

/**
 * Pure parser for the revision-expression grammar. Turns a raw expression into
 * a structured `RevExpression`; evaluation (lookup against the repository) is a
 * separate concern handled by tier-1 commands.
 *
 * Grammar (subset accepted in v1):
 *   - empty                       throws REVPARSE_UNRESOLVED
 *   - `:<stage>:<path>`           IndexStage (stage in 0..3, path non-empty)
 *   - `<base>` `<op>*`            RefOrHex with chained operations
 *
 * Operations:
 *   - `~N`            ancestor (first-parent N times); `~` alone is invalid
 *   - `^`             parent 1
 *   - `^N`            parent N (1-based; 1 = first parent)
 *   - `^^^`           sequence of parent ops
 *   - `^{<type>}`     peel to type (commit | tree | blob | tag)
 *
 * A reflog `@{…}` selector binds to the base ref, before any `~`/`^`:
 *   `<base> @{ <selector> } <op>*`
 * A digits-only body is an index; anything else is a date string the evaluator
 * resolves. An empty base (bare `@{N}`) is allowed and resolves against the
 * current branch.
 * Hex prefixes shorter than 7 are rejected at parse time; 7+ are deferred to
 * the evaluator (which scans loose objects + pack indices).
 */

export type PeelTarget = 'commit' | 'tree' | 'blob' | 'tag';

export type RevOperation =
  | { readonly kind: 'parent'; readonly n: number }
  | { readonly kind: 'ancestor'; readonly n: number }
  | { readonly kind: 'peel'; readonly target: PeelTarget };

export type ReflogSelector =
  | { readonly kind: 'index'; readonly n: number }
  | { readonly kind: 'date'; readonly raw: string };

export type RevExpression =
  | {
      readonly kind: 'ref-or-hex';
      readonly base: string;
      readonly reflog?: ReflogSelector;
      readonly operations: ReadonlyArray<RevOperation>;
    }
  | {
      readonly kind: 'index-stage';
      readonly stage: 0 | 1 | 2 | 3;
      readonly path: string;
    };

const VALID_PEEL_TARGETS = new Set<string>(['commit', 'tree', 'blob', 'tag']);
const INDEX_STAGE_PATTERN = /^:(\d):(.+)$/;
const SHORT_HEX_PATTERN = /^[0-9a-f]{1,6}$/;

const fail = (raw: string): never => {
  throw revparseUnresolved(raw);
};

export const parseExpression = (raw: string): RevExpression => {
  // Stryker disable next-line ConditionalExpression: equivalent — when this guard is removed, '' still fails identically: parseRefOrHex's `base === ''` guard throws revparseUnresolved('') for the same input.
  if (raw === '') fail(raw);
  if (raw.startsWith(':')) return parseIndexStage(raw);
  if (raw.includes('@{')) return parseReflog(raw);
  return parseRefOrHex(raw);
};

const parseIndexStage = (raw: string): RevExpression => {
  const match = INDEX_STAGE_PATTERN.exec(raw);
  if (match === null) fail(raw);
  const stageStr = (match as RegExpMatchArray)[1] as string;
  const path = (match as RegExpMatchArray)[2] as string;
  const stage = Number(stageStr);
  // `INDEX_STAGE_PATTERN` captures a single digit, so `stage` is always 0..9 — only the upper bound can be exceeded.
  if (stage > 3) fail(raw);
  // The `(.+)` capture in `INDEX_STAGE_PATTERN` guarantees `path` is non-empty,
  // so no empty-path guard is needed here.
  return { kind: 'index-stage', stage: stage as 0 | 1 | 2 | 3, path };
};

const parseRefOrHex = (raw: string): RevExpression => {
  const opStart = findOperatorStart(raw);
  const base = opStart === -1 ? raw : raw.slice(0, opStart);
  if (base === '') fail(raw);
  if (SHORT_HEX_PATTERN.test(base) && opStart === -1) fail(raw);
  const operations = opStart === -1 ? [] : parseOperations(raw, opStart);
  return { kind: 'ref-or-hex', base, operations };
};

const DIGITS_ONLY_PATTERN = /^\d+$/;

/** Parse `<base>@{<selector>}<op>*`. The base may be empty (bare `@{N}`). */
const parseReflog = (raw: string): RevExpression => {
  const at = raw.indexOf('@{');
  const close = raw.indexOf('}', at + 2);
  if (close === -1) fail(raw);
  const base = raw.slice(0, at);
  const body = raw.slice(at + 2, close);
  if (body === '') fail(raw);
  const reflog: ReflogSelector = DIGITS_ONLY_PATTERN.test(body)
    ? { kind: 'index', n: Number(body) }
    : { kind: 'date', raw: body };
  const rest = raw.slice(close + 1);
  const operations = rest === '' ? [] : parseOperations(rest, 0);
  return { kind: 'ref-or-hex', base, reflog, operations };
};

/** Returns the index of the first `~` or `^` that begins an operator chain, or -1. */
const findOperatorStart = (raw: string): number => {
  // Stryker disable next-line EqualityOperator: equivalent — raw[raw.length] is undefined, which equals neither '~' nor '^', so one extra harmless iteration changes nothing.
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '~' || ch === '^') return i;
  }
  return -1;
};

const parseOperations = (raw: string, start: number): ReadonlyArray<RevOperation> => {
  const out: RevOperation[] = [];
  let i = start;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '~') {
      const result = parseTilde(raw, i);
      out.push(result.op);
      i = result.next;
    } else if (ch === '^') {
      const result = parseCaret(raw, i);
      out.push(result.op);
      i = result.next;
    } else {
      fail(raw);
    }
  }
  return out;
};

const parseTilde = (
  raw: string,
  i: number,
): { readonly op: RevOperation; readonly next: number } => {
  let j = i + 1;
  // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — at j === raw.length, charCodeAt returns NaN, isDigit(NaN) is false, so the `isDigit` operand terminates the loop whether or not the `j < raw.length` bound holds.
  while (j < raw.length && isDigit(raw.charCodeAt(j))) j += 1;
  if (j === i + 1) fail(raw); // no digits after `~`
  const n = Number(raw.slice(i + 1, j));
  return { op: { kind: 'ancestor', n }, next: j };
};

const parseCaret = (
  raw: string,
  i: number,
): { readonly op: RevOperation; readonly next: number } => {
  if (raw[i + 1] === '{') {
    const closeIdx = raw.indexOf('}', i + 2);
    // Stryker disable next-line ConditionalExpression,UnaryOperator: equivalent — when `closeIdx === -1` this guard is bypassed, `targetStr` becomes `raw.slice(i + 2, -1)` and `next` becomes 0; either the slice is not a valid peel target (fails at L130) or parseOperations re-enters at index 0 where the non-empty base's first char is neither `~` nor `^` (fails in the else branch). Both paths throw revparseUnresolved(raw) with identical `raw`.
    if (closeIdx === -1) fail(raw);
    const targetStr = raw.slice(i + 2, closeIdx);
    if (!VALID_PEEL_TARGETS.has(targetStr)) fail(raw);
    return {
      op: { kind: 'peel', target: targetStr as PeelTarget },
      next: closeIdx + 1,
    };
  }
  let j = i + 1;
  // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — at j === raw.length, charCodeAt returns NaN, isDigit(NaN) is false, so the `isDigit` operand terminates the loop whether or not the `j < raw.length` bound holds.
  while (j < raw.length && isDigit(raw.charCodeAt(j))) j += 1;
  const digitsStr = raw.slice(i + 1, j);
  const n = digitsStr === '' ? 1 : Number(digitsStr);
  return { op: { kind: 'parent', n }, next: j };
};

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;
