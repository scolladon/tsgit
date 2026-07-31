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
// Normalization only ever removes bytes, so one buffer the size of the input
// holds any output — written in place and returned as a view, never grown as a
// per-byte number array (~8 bytes plus slack per INPUT byte) and copied.
function dropAllWs(bytes: Uint8Array): Uint8Array {
  const end = lfIndex(bytes);
  const out = new Uint8Array(bytes.length);
  let length = 0;
  for (let i = 0; i < end; i++) {
    const b = bytes[i] as number;
    if (!isWs(b)) out[length++] = b;
  }
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — 'all' is an active key, so normalizeLine always strips this LF straight back off: forcing the write on appends a byte stripTerminator then removes, forcing it off drops a byte stripTerminator would have removed. Only a line carrying an interior LF separates the two, and a line never carries one.
  if (end < bytes.length) out[length++] = LF;
  return out.subarray(0, length);
}

// Collapse each run of space/tab to a single space; drop trailing run.
// Leading run is kept as a single space (so presence is preserved, amount is not).
// Same single pre-sized buffer as dropAllWs above.
function collapseRuns(bytes: Uint8Array): Uint8Array {
  const end = lfIndex(bytes);
  const out = new Uint8Array(bytes.length);
  let length = 0;
  let inWs = false;
  for (let i = 0; i < end; i++) {
    const b = bytes[i] as number;
    if (isWs(b)) {
      if (!inWs) {
        out[length++] = SPACE;
        inWs = true;
      }
    } else {
      inWs = false;
      out[length++] = b;
    }
  }
  // `inWs` still set means the content ended inside a whitespace run, whose
  // collapsed SPACE is the last byte written — take it back, the run is trailing.
  if (inWs) length--;
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — 'change' is an active key, so normalizeLine always strips this LF straight back off: forcing the write on appends a byte stripTerminator then removes, forcing it off drops a byte stripTerminator would have removed. Only a line carrying an interior LF separates the two, and a line never carries one.
  if (end < bytes.length) out[length++] = LF;
  return out.subarray(0, length);
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

// The CR cross-mode rule: trailing CR is droppable under all/change/at-eol
// modes unconditionally, and under ignoreCrAtEol only when it ends a
// terminated line — a CR ending an incomplete final line is content, not
// whitespace, there (C6). Apply CR drop before the mode-specific transform.
function applyCrRule(bytes: Uint8Array, key: LineKey): Uint8Array {
  const terminated = lfIndex(bytes) < bytes.length;
  const crApplies = key.mode !== 'none' || (key.ignoreCrAtEol && terminated);
  return crApplies ? dropTrailingCr(bytes) : bytes;
}

function normalizeUnderMode(bytes: Uint8Array, key: LineKey): Uint8Array {
  switch (key.mode) {
    case 'all':
      return dropAllWs(bytes);
    case 'change':
      return collapseRuns(bytes);
    case 'at-eol':
      return dropTrailingWs(bytes);
    case 'none':
      return bytes;
  }
}

// A line's trailing LF is part of its identity iff the line key is inactive
// (C4): git ignores a difference in the final line's terminator under every
// flag that makes it compare content at all, symmetrically (LF gained or
// lost). The rule can only ever bite the last line pair — every non-final
// line is terminated on both sides by construction — so this strip is safe
// to apply unconditionally to any single normalized line.
function stripTerminator(bytes: Uint8Array): Uint8Array {
  const end = lfIndex(bytes);
  // NOTE: forcing this test to `true`, or relaxing `<` to `<=`, is equivalent — an unterminated
  // line has end === bytes.length, where subarray(0, end) yields the same bytes. Left unannotated
  // because the opposite-direction variants (`false`, `>=`) are real, killed mutants on this same
  // line, and Stryker's next-line disable matches by mutator+line, not by which variant.
  return end < bytes.length ? bytes.subarray(0, end) : bytes;
}

export function normalizeLine(bytes: Uint8Array, key: LineKey): Uint8Array {
  const normalized = normalizeUnderMode(applyCrRule(bytes, key), key);
  return lineKeyIsActive(key) ? stripTerminator(normalized) : normalized;
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
 * A normalized line is blank when its content (excluding a trailing LF) is
 * empty. Split out from `isBlankLine` so a caller holding the normalized bytes
 * already — the drop pass's exact confirmation does — answers the question
 * from the same rule instead of normalizing a second time.
 */
export function normalizedIsBlank(normalized: Uint8Array): boolean {
  return lfIndex(normalized) === 0;
}

/**
 * A line is blank when its content (excluding a trailing LF) is empty after
 * normalization under the active key — so a spaces-only line counts as blank
 * only under a whitespace mode, not under ignore-blank-lines alone.
 */
export function isBlankLine(line: Uint8Array, key: LineKey): boolean {
  return normalizedIsBlank(normalizeLine(line, key));
}

export function lineKeyIsActive(key: LineKey): boolean {
  return key.mode !== 'none' || key.ignoreCrAtEol;
}

/**
 * A rolling-hash fingerprint of one line's normalized form — `length` (0 means
 * blank), `terminated` (had a trailing LF), and a 32-bit FNV-1a fold over the
 * normalized bytes, all in one pass. Lets a streaming predicate reject a
 * DIFFERENCE under a `LineKey` without ever allocating the normalized
 * `Uint8Array` (`normalizeLine` does, per line, on every comparison).
 *
 * A difference filter, never proof of equality. Unequal digests prove unequal
 * normalized lines (the fold is a function of those bytes), so a mismatch is a
 * sound, cheap "differs". Equal digests prove nothing an attacker cannot
 * arrange: a narrow FNV chain admits chosen-input multicollisions, so a
 * would-be-drop verdict is confirmed against the actual normalized bytes
 * before anything leaves the diff (`contentsEqualUnder`,
 * `line-digest-scanner.ts`). A second lane once guarded the equality claim
 * here; with the exact confirmation owning it, that lane bought nothing but a
 * `Math.imul` and an XOR per byte on the hot path, and is gone.
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
 * What the fold has pending behind it: nothing, an open whitespace run, or a
 * CR that would be dropped if the line ended right here. Exactly the `WS* CR?`
 * tail grammar, as one value — the fold reads it once per byte.
 */
const TAIL_NONE = 0;
const TAIL_WS = 1;
const TAIL_CR = 2;

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
  tail: number;
  sawLf: boolean;
  lineHasBytes: boolean;
}

function createFoldState(): FoldState {
  return {
    committedHash: FNV_OFFSET_BASIS,
    committedLength: 0,
    tentHash: FNV_OFFSET_BASIS,
    tentLength: 0,
    tail: TAIL_NONE,
    sawLf: false,
    lineHasBytes: false,
  };
}

function resetLine(state: FoldState): void {
  state.committedHash = FNV_OFFSET_BASIS;
  state.committedLength = 0;
  state.tentHash = FNV_OFFSET_BASIS;
  state.tentLength = 0;
  state.tail = TAIL_NONE;
  state.sawLf = false;
  state.lineHasBytes = false;
}

/**
 * How the fold treats one byte, decided once per key rather than re-derived
 * per byte. `SOFT_WS`/`SOFT_CR` are the two droppable-tail bytes; a key that
 * does not ignore them classifies them `HARD` like anything else.
 */
const HARD = 0;
const SOFT_WS = 1;
const SOFT_CR = 2;
const TERMINATOR = 3;
const BYTE_VALUES = 256;

function buildByteKinds(wsIsSoft: boolean, crIsSoft: boolean): Uint8Array {
  const kinds = new Uint8Array(BYTE_VALUES);
  kinds[LF] = TERMINATOR;
  if (crIsSoft) kinds[CR] = SOFT_CR;
  if (wsIsSoft) {
    kinds[SPACE] = SOFT_WS;
    kinds[TAB] = SOFT_WS;
  }
  return kinds;
}

// The three classifications a `LineKey` can produce: whitespace is soft under
// every mode but 'none', and a CR is soft under those same modes or under
// `ignoreCrAtEol` (mirrors `applyCrRule`'s `crApplies`) — so "soft whitespace,
// hard CR" is not a reachable shape.
const WS_AND_CR_SOFT = buildByteKinds(true, true);
const CR_SOFT_ONLY = buildByteKinds(false, true);
const NOTHING_SOFT = buildByteKinds(false, false);

function byteKindsFor(key: LineKey): Uint8Array {
  if (key.mode !== 'none') return WS_AND_CR_SOFT;
  return key.ignoreCrAtEol ? CR_SOFT_ONLY : NOTHING_SOFT;
}

/**
 * Everything `foldRange` needs to know about a `LineKey`, resolved once per
 * fold. The mode is a string; resolving it here keeps the scan loop asking
 * only about numbers, and lets that loop live at module scope instead of
 * closing over the key.
 */
interface FoldRules {
  readonly kinds: Uint8Array;
  /** 'at-eol' keeps an internal run's bytes verbatim. */
  readonly foldsSoftWs: boolean;
  /** 'change' owes an internal run one collapsed SPACE (mirrors digestCollapseRuns). */
  readonly collapsesRuns: boolean;
}

function compileRules(key: LineKey): FoldRules {
  return {
    kinds: byteKindsFor(key),
    foldsSoftWs: key.mode === 'at-eol',
    collapsesRuns: key.mode === 'change',
  };
}

/**
 * Folds `chunk[from, to)` into `state`, stopping just past the line's LF
 * terminator — the scan that `pushChunk` exposes.
 *
 * Both hash lanes, their lengths and the pending tail live in loop locals for
 * the whole range and are written back to `state` once, at the end. That is
 * the entire point of folding a RANGE rather than a byte: a per-byte call
 * boundary forces every one of them through the state object on every byte,
 * which costs more than the fold itself.
 */
function foldRange(
  state: FoldState,
  rules: FoldRules,
  chunk: Uint8Array,
  from: number,
  to: number,
): number {
  const { kinds, foldsSoftWs, collapsesRuns } = rules;
  let committedHash = state.committedHash;
  let committedLength = state.committedLength;
  let tentHash = state.tentHash;
  let tentLength = state.tentLength;
  let tail = state.tail;
  let stop = NO_TERMINATOR;

  for (let i = from; i < to; i++) {
    const byte = chunk[i] as number;
    const kind = kinds[byte] as number;
    if (kind === TERMINATOR) {
      state.sawLf = true;
      stop = i + 1;
      break;
    }
    if (kind === HARD) {
      // A hard byte proves any tail internal and commits the line through
      // itself. Nothing is owed to the run it closes: 'change' folded that
      // run's collapsed SPACE when the run opened.
      tentHash = fnvMix(tentHash, byte);
      tentLength++;
      committedHash = tentHash;
      committedLength = tentLength;
      tail = TAIL_NONE;
      continue;
    }
    // A soft byte behind a pending CR proves that CR internal, not trailing —
    // promote. Behind an open run it promotes nothing (§D1.2 row 1), and
    // behind nothing the commit is already current.
    if (tail === TAIL_CR) {
      committedHash = tentHash;
      committedLength = tentLength;
    }
    if (kind === SOFT_CR) {
      tentHash = fnvMix(tentHash, CR);
      tentLength++;
      tail = TAIL_CR;
      continue;
    }
    // Whether this run turns out internal is not known yet, so 'change' folds
    // its one SPACE into the TENTATIVE lane as the run opens: a trailing run's
    // tentative lane is discarded wholesale, so folding early costs a run that
    // never closes exactly nothing.
    if (foldsSoftWs) {
      tentHash = fnvMix(tentHash, byte);
      tentLength++;
    } else if (collapsesRuns && tail !== TAIL_WS) {
      tentHash = fnvMix(tentHash, SPACE);
      tentLength++;
    }
    tail = TAIL_WS;
  }

  state.committedHash = committedHash;
  state.committedLength = committedLength;
  state.tentHash = tentHash;
  state.tentLength = tentLength;
  state.tail = tail;
  return stop;
}

/** One of the fold's `committed`/`tentative` hash+length pairs (§D1.3's doc comment). */
interface FoldPair {
  readonly hash: number;
  readonly length: number;
}

// Which pair `emitDigest` reports (C6, §D1.4): `tentative` — the pending
// droppable tail kept as-if it were content — wins only for an incomplete
// final line's trailing CR under `ignoreCrAtEol` with mode 'none', where the
// CR is significant, not whitespace. Every other shape reports `committed`:
// under any other mode a trailing CR is ordinary whitespace and always
// droppable regardless of termination (a soft CR is never pending for an
// inactive key, so this stays dead there too).
function selectedPair(state: FoldState, key: LineKey): FoldPair {
  // NOTE: forcing the first operand (`state.tail === TAIL_CR`) to `true` is equivalent — the
  // conjunction still demands mode 'none', under which whitespace is never soft, so `tail` only
  // ever holds TAIL_CR or TAIL_NONE; and TAIL_NONE means both lanes already carry the same pair
  // (every hard byte copies tentative into committed, and both start at the basis). Left
  // unannotated because four ConditionalExpression mutants on this line are real and killed.
  const useTentative = state.tail === TAIL_CR && key.mode === 'none' && !state.sawLf;
  return useTentative
    ? { hash: state.tentHash, length: state.tentLength }
    : { hash: state.committedHash, length: state.committedLength };
}

function emitDigest(state: FoldState, key: LineKey, keyIsActive: boolean): LineDigest {
  // `terminated` is true only when the line actually ended in LF AND the key
  // is inactive (C4) — under an active key the final line's LF is whitespace,
  // so it is suppressed at construction: neither folded into either lane nor
  // reported.
  const pair = selectedPair(state, key);
  const terminated = state.sawLf && !keyIsActive;
  if (!terminated) {
    return { length: pair.length, terminated, hash: pair.hash };
  }
  return { length: pair.length, terminated, hash: fnvMix(pair.hash, LF) };
}

/** `pushChunk`'s answer when the range ran out before any LF terminator. */
export const NO_TERMINATOR = -1;

export interface LineDigestFold {
  /** Fold the bytes of `chunk` in `[from, to)` up to and including the line's
   *  LF terminator. Returns the index just past that terminator — the caller
   *  must then call `endLine()` before folding more — or `NO_TERMINATOR` when
   *  the range ran out first. */
  pushChunk(chunk: Uint8Array, from: number, to: number): number;
  /** Emit the finished line's digest and reset the per-line state. */
  endLine(): LineDigest;
  /** False when nothing has been folded since the last `endLine()` — lets a
   *  caller tell EOF from an empty unterminated final line. */
  readonly lineHasBytes: boolean;
}

/**
 * Folds one line's bytes into a `LineDigest` incrementally, in `O(1)` memory —
 * the line is never buffered. A "line" here is exactly what `splitLines`
 * emits: at most one LF terminator, always the last byte folded. Feeding an
 * interior LF is outside this contract.
 *
 * The scan runs to the terminator INSIDE the fold rather than a byte at a
 * time from outside it, so the two hash lanes, their lengths and the pending
 * tail flags live in loop locals and are written back to `state` once per
 * chunk. That is the whole reason `pushChunk` takes a range instead of a
 * byte: a per-byte call boundary forces every one of them through the state
 * object on every byte, which measurably dominates the fold itself.
 */
export function createLineDigestFold(key: LineKey): LineDigestFold {
  const state = createFoldState();
  const keyIsActive = lineKeyIsActive(key);
  const rules = compileRules(key);

  function pushChunk(chunk: Uint8Array, from: number, to: number): number {
    if (to > from) state.lineHasBytes = true;
    return foldRange(state, rules, chunk, from, to);
  }

  function endLine(): LineDigest {
    const digest = emitDigest(state, key, keyIsActive);
    resetLine(state);
    return digest;
  }

  return {
    pushChunk,
    endLine,
    get lineHasBytes(): boolean {
      return state.lineHasBytes;
    },
  };
}

/**
 * Digest one line's normalized form under `key`, without allocating the
 * normalized array. One direction is guaranteed and is the only one anything
 * relies on: `linesEqualUnder(a,b,k)` implies `digestsEqual(digest(a,k),
 * digest(b,k))`, so a digest MISMATCH is always a real difference. The
 * converse does not hold — see `LineDigest`.
 */
export function digestNormalizedLine(bytes: Uint8Array, key: LineKey): LineDigest {
  const fold = createLineDigestFold(key);
  fold.pushChunk(bytes, 0, bytes.length);
  return fold.endLine();
}

/** False proves the two normalized lines differ; true is only evidence they
 *  match (see `LineDigest`). */
export function digestsEqual(a: LineDigest, b: LineDigest): boolean {
  return a.length === b.length && a.terminated === b.terminated && a.hash === b.hash;
}

/** A digest is blank when its normalized content (excluding a trailing LF) is empty. */
export function digestIsBlank(digest: LineDigest): boolean {
  return digest.length === 0;
}
