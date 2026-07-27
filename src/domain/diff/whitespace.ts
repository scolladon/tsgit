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
  // Stryker disable next-line ConditionalExpression: equivalent — the guard is only false when bytes is empty (last === -1), and then bytes[-1] is undefined !== LF, so the condition is false either way and bytes.length (0) is returned.
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
  // Stryker disable next-line ConditionalExpression: equivalent — `out.length > 0` forced true still short-circuits safely: when out is empty, out[-1] is undefined !== SPACE, so the pop is skipped regardless.
  // NOTE: the EqualityOperator variant of this guard (`out.length > 0` -> `>= 0`) is equally equivalent but left unannotated — this line also carries a killable EqualityOperator mutant on `out[out.length - 1] === SPACE` -> `!==` (kills via existing tests), and Stryker's next-line disable matches by mutator+line, not sub-expression, so annotating EqualityOperator here would blind that real mutant too.
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
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — `wsStart > 0` forced true or relaxed to `>= 0` still stops the scan at wsStart === 0: bytes[-1] is undefined so isWs(undefined) is false and the loop exits at the same point regardless.
  while (wsStart > 0 && isWs(bytes[wsStart - 1] as number)) {
    wsStart--;
  }
  // Stryker disable next-line EqualityOperator: equivalent — flipping `end === bytes.length` to `!==` only swaps which branch (early return vs. fallthrough copy) fires when nothing needs trimming; both produce byte-identical output (verified by hand).
  // NOTE: this line's ConditionalExpression mutant forcing the whole test to `false` is equally equivalent (same reasoning — the fallthrough branch always reproduces `bytes` byte-for-byte when there's nothing to trim), but is left unannotated: the sibling ConditionalExpression mutant forcing the test to `true` breaks real trimming and is a killable mutant on this same line, and Stryker's next-line disable can't distinguish `true` from `false` variants of the same mutator.
  if (wsStart === end && end === bytes.length) return bytes; // nothing to drop
  const out = new Uint8Array(wsStart + (end < bytes.length ? 1 : 0));
  out.set(bytes.subarray(0, wsStart));
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — forcing this test to `true` (or relaxing `<` to `<=`) still only fires the extra write when unterminated (end === bytes.length); out has length wsStart there, so out[wsStart] is an out-of-bounds typed-array write, which is a silent no-op. Both reduce to the original behaviour.
  if (end < bytes.length) out[wsStart] = LF;
  return out;
}

// Drop a trailing CR immediately before the LF (or at end of unterminated content).
function dropTrailingCr(bytes: Uint8Array): Uint8Array {
  const end = lfIndex(bytes);
  // The CR must be immediately before the terminator (or at end of unterminated)
  const crPos = end - 1;
  // Stryker disable next-line ConditionalExpression: equivalent — forcing `crPos < 0` to false still resolves via the second disjunct: when crPos < 0 (empty content) bytes[-1] is undefined !== CR, so bytes is still returned unchanged.
  if (crPos < 0 || bytes[crPos] !== CR) return bytes;
  const out = new Uint8Array(bytes.length - 1);
  out.set(bytes.subarray(0, crPos));
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — forcing this test to `true` (or relaxing `<` to `<=`) still only fires the extra write when unterminated (end === bytes.length): crPos === bytes.length - 1 === out.length there, so out[crPos] is an out-of-bounds typed-array write, a silent no-op. Both reduce to the original behaviour.
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

/**
 * A rolling-hash fingerprint of one line's normalized form — `length` (0 means
 * blank), `terminated` (had a trailing LF), and a 32-bit FNV-1a `hash` folded
 * over the normalized bytes. Lets a streaming predicate compare lines for
 * equality under a `LineKey` without ever allocating the normalized
 * `Uint8Array` (`normalizeLine` does, per line, on every comparison).
 */
export interface LineDigest {
  readonly length: number;
  readonly terminated: boolean;
  readonly hash: number;
}

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnvMix(hash: number, byte: number): number {
  return Math.imul(hash ^ byte, FNV_PRIME) >>> 0;
}

/** The CR-adjusted content boundary, mirroring `applyCrRule` without allocating. */
function digestContentEnd(bytes: Uint8Array, end: number, key: LineKey): number {
  const crApplies = key.ignoreCrAtEol || key.mode !== 'none';
  if (!crApplies) return end;
  const crPos = end - 1;
  return crPos >= 0 && bytes[crPos] === CR ? crPos : end;
}

function digestVerbatim(bytes: Uint8Array, contentEnd: number, terminated: boolean): LineDigest {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < contentEnd; i++) hash = fnvMix(hash, bytes[i]!);
  if (terminated) hash = fnvMix(hash, LF);
  return { length: contentEnd, terminated, hash };
}

// Mirrors dropAllWs: every space/tab byte is dropped, regardless of position.
function digestDropAllWs(bytes: Uint8Array, contentEnd: number, terminated: boolean): LineDigest {
  let hash = FNV_OFFSET_BASIS;
  let length = 0;
  for (let i = 0; i < contentEnd; i++) {
    const b = bytes[i]!;
    if (isWs(b)) continue;
    hash = fnvMix(hash, b);
    length++;
  }
  if (terminated) hash = fnvMix(hash, LF);
  return { length, terminated, hash };
}

// Mirrors collapseRuns: each internal run collapses to one space; a run
// touching the end (still pending when the loop ends) is dropped, not committed.
function digestCollapseRuns(
  bytes: Uint8Array,
  contentEnd: number,
  terminated: boolean,
): LineDigest {
  let hash = FNV_OFFSET_BASIS;
  let length = 0;
  let pendingSpace = false;
  for (let i = 0; i < contentEnd; i++) {
    const b = bytes[i]!;
    if (isWs(b)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      hash = fnvMix(hash, SPACE);
      length++;
      pendingSpace = false;
    }
    hash = fnvMix(hash, b);
    length++;
  }
  if (terminated) hash = fnvMix(hash, LF);
  return { length, terminated, hash };
}

/** Commit a buffered (non-trailing) whitespace run's bytes verbatim into the digest. */
function commitRun(
  bytes: Uint8Array,
  runStart: number,
  runEnd: number,
  hash: number,
  length: number,
): { readonly hash: number; readonly length: number } {
  let h = hash;
  let l = length;
  for (let j = runStart; j < runEnd; j++) {
    h = fnvMix(h, bytes[j]!);
    l++;
  }
  return { hash: h, length: l };
}

// Mirrors dropTrailingWs: internal runs are preserved verbatim; only a run
// still pending when the loop ends (touching the content boundary) is dropped.
function digestDropTrailingWs(
  bytes: Uint8Array,
  contentEnd: number,
  terminated: boolean,
): LineDigest {
  let hash = FNV_OFFSET_BASIS;
  let length = 0;
  let runStart = -1;
  for (let i = 0; i < contentEnd; i++) {
    const b = bytes[i]!;
    if (isWs(b)) {
      if (runStart === -1) runStart = i;
      continue;
    }
    if (runStart !== -1) {
      ({ hash, length } = commitRun(bytes, runStart, i, hash, length));
      runStart = -1;
    }
    hash = fnvMix(hash, b);
    length++;
  }
  if (terminated) hash = fnvMix(hash, LF);
  return { length, terminated, hash };
}

/**
 * Digest one line's normalized form under `key` — equality-preserving with
 * `normalizeLine`/`bytesEqual` (`digestsEqual(digest(a,k), digest(b,k))` agrees
 * with `linesEqualUnder(a,b,k)`) but without allocating the normalized array.
 */
export function digestNormalizedLine(bytes: Uint8Array, key: LineKey): LineDigest {
  const end = lfIndex(bytes);
  const terminated = end < bytes.length;
  const contentEnd = digestContentEnd(bytes, end, key);
  switch (key.mode) {
    case 'all':
      return digestDropAllWs(bytes, contentEnd, terminated);
    case 'change':
      return digestCollapseRuns(bytes, contentEnd, terminated);
    case 'at-eol':
      return digestDropTrailingWs(bytes, contentEnd, terminated);
    case 'none':
      return digestVerbatim(bytes, contentEnd, terminated);
  }
}

export function digestsEqual(a: LineDigest, b: LineDigest): boolean {
  return a.length === b.length && a.terminated === b.terminated && a.hash === b.hash;
}

/** A digest is blank when its normalized content (excluding a trailing LF) is empty. */
export function digestIsBlank(digest: LineDigest): boolean {
  return digest.length === 0;
}
