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
  while (wsStart > 0 && isWs(bytes[wsStart - 1] as number)) {
    wsStart--;
  }
  if (wsStart === end && end === bytes.length) return bytes; // nothing to drop
  const out = new Uint8Array(wsStart + (end < bytes.length ? 1 : 0));
  out.set(bytes.subarray(0, wsStart));
  if (end < bytes.length) out[wsStart] = LF;
  return out;
}

// Drop a trailing CR immediately before the LF (or at end of unterminated content).
function dropTrailingCr(bytes: Uint8Array): Uint8Array {
  const end = lfIndex(bytes);
  // The CR must be immediately before the terminator (or at end of unterminated)
  const crPos = end - 1;
  if (crPos < 0 || bytes[crPos] !== CR) return bytes;
  const out = new Uint8Array(bytes.length - 1);
  out.set(bytes.subarray(0, crPos));
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
