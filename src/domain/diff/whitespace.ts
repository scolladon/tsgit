import { bytesEqual } from '../objects/encoding.js';

export type WhitespaceMode = 'all' | 'change' | 'at-eol' | 'none';

export interface LineKey {
  readonly mode: WhitespaceMode;
  readonly ignoreCrAtEol: boolean;
}

const SPACE = 0x20;
const TAB = 0x09;
const CR = 0x0d;
const LF = 0x0a;

function isWs(b: number): boolean {
  return b === SPACE || b === TAB;
}

// Find the index of the LF terminator, or bytes.length if unterminated
function lfIndex(bytes: Uint8Array): number {
  const last = bytes.length - 1;
  // equivalent-mutant: `last >= 0` -> `true` — the guard is only false when bytes is empty (last === -1), and then bytes[-1] is undefined !== LF, so the condition is false either way and bytes.length (0) is returned.
  return last >= 0 && bytes[last] === LF ? last : bytes.length;
}

// Drop all space/tab bytes from content (before terminator). Preserves the LF.
function dropAllWs(bytes: Uint8Array): Uint8Array {
  const end = lfIndex(bytes);
  const out: number[] = [];
  for (let i = 0; i < end; i++) {
    const b = bytes[i] as number;
    if (!isWs(b)) out.push(b);
  }
  if (end < bytes.length) out.push(LF);
  return new Uint8Array(out);
}

// Collapse each run of space/tab to a single space; drop trailing run.
// Leading run is kept as a single space (so presence is preserved, amount is not).
function collapseRuns(bytes: Uint8Array): Uint8Array {
  const end = lfIndex(bytes);
  const out: number[] = [];
  let inWs = false;
  for (let i = 0; i < end; i++) {
    const b = bytes[i] as number;
    if (isWs(b)) {
      if (!inWs) {
        out.push(SPACE);
        inWs = true;
      }
    } else {
      inWs = false;
      out.push(b);
    }
  }
  // drop trailing space that was added for the trailing ws run
  // equivalent-mutant: `out.length > 0` -> `true`/`>= 0` — the length guard only short-circuits when out is empty, and then out[-1] is undefined !== SPACE, so the second conjunct is false and the pop is skipped regardless.
  if (out.length > 0 && out[out.length - 1] === SPACE) {
    out.pop();
  }
  if (end < bytes.length) out.push(LF);
  return new Uint8Array(out);
}

// Drop the trailing whitespace run (before terminator or end of unterminated content).
function dropTrailingWs(bytes: Uint8Array): Uint8Array {
  const end = lfIndex(bytes);
  let wsStart = end;
  // equivalent-mutant: `wsStart > 0` -> `true`/`>= 0` — the guard only stops the scan at wsStart === 0, and there bytes[-1] is undefined so isWs(undefined) is false and the loop stops at the same point regardless.
  while (wsStart > 0 && isWs(bytes[wsStart - 1] as number)) {
    wsStart--;
  }
  // equivalent-mutant: this guard (and its `end !== bytes.length` / `&& true` variants) only chooses whether to return the original `bytes` object or fall through to build a byte-identical copy; both yield value-equal output.
  if (wsStart === end && end === bytes.length) return bytes; // nothing to drop
  const out = new Uint8Array(wsStart + (end < bytes.length ? 1 : 0));
  out.set(bytes.subarray(0, wsStart));
  // equivalent-mutant: `end < bytes.length` -> `true`/`<=` — when unterminated, out has length wsStart, so out[wsStart] is an out-of-bounds typed-array write (a silent no-op); when terminated the byte must be written. Both reduce to the original behaviour.
  if (end < bytes.length) out[wsStart] = LF;
  return out;
}

// Drop a trailing CR immediately before the LF (or at end of unterminated content).
function dropTrailingCr(bytes: Uint8Array): Uint8Array {
  const end = lfIndex(bytes);
  // The CR must be immediately before the terminator (or at end of unterminated)
  const crPos = end - 1;
  // equivalent-mutant: `crPos < 0` -> `false` — when crPos < 0 (empty content) bytes[-1] is undefined !== CR, so the second disjunct is true and bytes is still returned unchanged.
  if (crPos < 0 || bytes[crPos] !== CR) return bytes;
  const out = new Uint8Array(bytes.length - 1);
  out.set(bytes.subarray(0, crPos));
  // equivalent-mutant: `end < bytes.length` -> `true`/`<=` — when unterminated, crPos === bytes.length - 1 === out.length, so out[crPos] is an out-of-bounds typed-array write (a silent no-op); when terminated the byte must be written. Both reduce to the original behaviour.
  if (end < bytes.length) out[crPos] = LF;
  return out;
}

// The CR cross-mode rule: trailing CR is droppable under all/change/at-eol modes
// AND under ignoreCrAtEol. Apply CR drop before the mode-specific transform.
function applyCrRule(bytes: Uint8Array, key: LineKey): Uint8Array {
  if (key.ignoreCrAtEol || key.mode === 'all' || key.mode === 'change' || key.mode === 'at-eol') {
    return dropTrailingCr(bytes);
  }
  return bytes;
}

export function normalizeLine(bytes: Uint8Array, key: LineKey): Uint8Array {
  const afterCr = applyCrRule(bytes, key);
  switch (key.mode) {
    case 'all':
      return dropAllWs(afterCr);
    case 'change':
      return collapseRuns(afterCr);
    case 'at-eol':
      return dropTrailingWs(afterCr);
    case 'none':
      return afterCr;
  }
}

export function linesEqualUnder(a: Uint8Array, b: Uint8Array, key: LineKey): boolean {
  return bytesEqual(normalizeLine(a, key), normalizeLine(b, key));
}

export function resolveLineKey(fields: {
  readonly ignoreWhitespace?: 'all' | 'change' | 'at-eol';
  readonly ignoreCrAtEol?: boolean;
  readonly ignoreBlankLines?: boolean;
}): LineKey {
  return {
    mode: fields.ignoreWhitespace ?? 'none',
    ignoreCrAtEol: fields.ignoreCrAtEol ?? false,
  };
}

/** The inert line key: no normalization (exact byte comparison). */
export const NONE_KEY: LineKey = { mode: 'none', ignoreCrAtEol: false };

/**
 * A line is blank when its content (excluding a trailing LF) is empty after
 * normalization under the active key — so a spaces-only line counts as blank
 * only under a whitespace mode, not under ignore-blank-lines alone.
 */
export function isBlankLine(line: Uint8Array, key: LineKey): boolean {
  return lfIndex(normalizeLine(line, key)) === 0;
}

export function lineKeyIsActive(key: LineKey): boolean {
  return key.mode !== 'none' || key.ignoreCrAtEol;
}
