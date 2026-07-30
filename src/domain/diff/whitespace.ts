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
  // NOTE: two more ConditionalExpression variants on this line are equally equivalent but left unannotated (their sibling `true`-on-the-whole-test and `true`-on-the-left-operand variants are real, killable mutants on this same line, and Stryker's next-line disable can't distinguish sub-expression from sub-expression of the same mutator): forcing the WHOLE test to `false`, and forcing just the right operand (`end === bytes.length`) to `true` (reducing the guard to `wsStart === end`). Both reduce to the same reasoning: whenever `wsStart === end` (nothing to trim), the fallthrough branch reproduces `bytes` byte-for-byte regardless of `end`'s relation to `bytes.length`, so skipping the early return via either variant changes no observable output.
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

/**
 * Per-line fold state (§D1.3). `committed` is the fold over everything
 * definitely part of the normalized line; `tentative` is `committed` plus the
 * pending droppable tail (`WS* CR?`), folded as it would be if the tail turned
 * out to be internal. Both are two-number pairs — the memory cost of "not
 * knowing yet" is fixed, never scaling with the run's length.
 */
interface FoldState {
  committedHash: number;
  committedLength: number;
  tentHash: number;
  tentLength: number;
  pendingWs: boolean;
  pendingCr: boolean;
  sawLf: boolean;
  lineHasBytes: boolean;
}

function createFoldState(): FoldState {
  return {
    committedHash: FNV_OFFSET_BASIS,
    committedLength: 0,
    tentHash: FNV_OFFSET_BASIS,
    tentLength: 0,
    pendingWs: false,
    pendingCr: false,
    sawLf: false,
    lineHasBytes: false,
  };
}

function resetLine(state: FoldState): void {
  state.committedHash = FNV_OFFSET_BASIS;
  state.committedLength = 0;
  state.tentHash = FNV_OFFSET_BASIS;
  state.tentLength = 0;
  state.pendingWs = false;
  state.pendingCr = false;
  state.sawLf = false;
  state.lineHasBytes = false;
}

// A byte is soft-WS when it could be part of a droppable trailing run.
function isSoftWs(byte: number, key: LineKey): boolean {
  return isWs(byte) && key.mode !== 'none';
}

// A byte is soft-CR when it could be a droppable trailing CR — today's
// unconditional-on-termination rule (mirrors digestContentEnd's `crApplies`).
function isSoftCr(byte: number, key: LineKey): boolean {
  return byte === CR && (key.ignoreCrAtEol || key.mode !== 'none');
}

function foldTentative(state: FoldState, byte: number): void {
  state.tentHash = fnvMix(state.tentHash, byte);
  state.tentLength++;
}

function promoteTentative(state: FoldState): void {
  state.committedHash = state.tentHash;
  state.committedLength = state.tentLength;
}

// Close a pending whitespace run that turned out to be internal, not trailing.
function closeRun(state: FoldState, key: LineKey): void {
  // 'all' drops the run everywhere (nothing to fold); 'at-eol' already folded
  // it verbatim during the run (mirrors commitRun); 'none' never reaches here
  // (whitespace is hard there). Only 'change' owes the run one collapsed SPACE
  // (mirrors digestCollapseRuns' pendingSpace).
  if (key.mode === 'change') foldTentative(state, SPACE);
}

function onHard(state: FoldState, key: LineKey, byte: number): void {
  if (state.pendingWs) closeRun(state, key);
  state.pendingWs = false;
  state.pendingCr = false;
  foldTentative(state, byte);
  promoteTentative(state);
}

function onSoftWs(state: FoldState, key: LineKey, byte: number): void {
  if (state.pendingCr) {
    // The previous CR is followed by more content — it is internal, not trailing.
    promoteTentative(state);
    state.pendingCr = false;
  }
  if (key.mode === 'at-eol') foldTentative(state, byte);
  state.pendingWs = true;
}

function onSoftCr(state: FoldState, key: LineKey): void {
  if (state.pendingCr) {
    // A second CR follows the first — the first is internal, not trailing.
    promoteTentative(state);
  } else if (state.pendingWs) {
    // The run does not promote just because a CR follows it (§D1.2 row 1).
    closeRun(state, key);
  }
  state.pendingWs = false;
  foldTentative(state, CR);
  state.pendingCr = true;
}

function applyContentByte(state: FoldState, key: LineKey, byte: number): void {
  if (isSoftWs(byte, key)) {
    onSoftWs(state, key, byte);
    return;
  }
  if (isSoftCr(byte, key)) {
    onSoftCr(state, key);
    return;
  }
  onHard(state, key, byte);
}

function emitDigest(state: FoldState): LineDigest {
  // Today's unconditional rules (pre-fix): the LF always decides `terminated`,
  // and the pending tail is always discarded — `committed` always wins.
  const terminated = state.sawLf;
  const hash = terminated ? fnvMix(state.committedHash, LF) : state.committedHash;
  return { length: state.committedLength, terminated, hash };
}

export interface LineDigestFold {
  /** Fold one raw byte of the line. Returns true when the byte was the line's
   *  LF terminator — the caller must then call `endLine()` before folding more. */
  push(byte: number): boolean;
  /** Emit the finished line's digest and reset the per-line state. */
  endLine(): LineDigest;
  /** False when nothing has been folded since the last `endLine()` — lets a
   *  caller tell EOF from an empty unterminated final line. */
  readonly lineHasBytes: boolean;
}

/**
 * Folds one line's bytes into a `LineDigest` incrementally, in `O(1)` memory —
 * the line is never buffered. A "line" here is exactly what `splitLines`
 * emits: at most one LF terminator, always the last byte pushed. Feeding an
 * interior LF is outside this contract.
 */
export function createLineDigestFold(key: LineKey): LineDigestFold {
  const state = createFoldState();

  function push(byte: number): boolean {
    state.lineHasBytes = true;
    if (byte === LF) {
      state.sawLf = true;
      return true;
    }
    applyContentByte(state, key, byte);
    return false;
  }

  function endLine(): LineDigest {
    const digest = emitDigest(state);
    resetLine(state);
    return digest;
  }

  return {
    push,
    endLine,
    get lineHasBytes(): boolean {
      return state.lineHasBytes;
    },
  };
}

/**
 * Digest one line's normalized form under `key` — equality-preserving with
 * `normalizeLine`/`bytesEqual` (`digestsEqual(digest(a,k), digest(b,k))` agrees
 * with `linesEqualUnder(a,b,k)`) but without allocating the normalized array.
 */
export function digestNormalizedLine(bytes: Uint8Array, key: LineKey): LineDigest {
  const fold = createLineDigestFold(key);
  for (let i = 0; i < bytes.length; i++) {
    fold.push(bytes[i]!);
  }
  return fold.endLine();
}

export function digestsEqual(a: LineDigest, b: LineDigest): boolean {
  return a.length === b.length && a.terminated === b.terminated && a.hash === b.hash;
}

/** A digest is blank when its normalized content (excluding a trailing LF) is empty. */
export function digestIsBlank(digest: LineDigest): boolean {
  return digest.length === 0;
}
