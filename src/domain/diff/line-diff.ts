import { bytesEqual } from '../objects/encoding.js';
import { type LineKey, normalizeLine } from './whitespace.js';

export interface LineHunk {
  readonly kind: 'common' | 'ours-only' | 'theirs-only';
  readonly oursStart: number;
  readonly oursEnd: number;
  readonly theirsStart: number;
  readonly theirsEnd: number;
}

export interface LineDiffOptions {
  readonly lineKey?: LineKey;
}

export interface LineDiff {
  readonly hunks: ReadonlyArray<LineHunk>;
  readonly oursLines: ReadonlyArray<Uint8Array>;
  readonly theirsLines: ReadonlyArray<Uint8Array>;
  readonly degraded: boolean;
}

export const BINARY_DETECTION_BYTES = 8_000;
// Not consulted by isBinary — git's own binary rule is the NUL window alone.
// Still live as grep's own bound, in both of its branches: the binary-presence
// probe and the per-line match window (grep.ts).
export const MAX_LINE_BYTES = 65_536;
// DEPRECATED — no consumer, and NOT a bound: diffLines imposes no limit on how
// many lines either side may have. A caller reading this as a maximum will be
// wrong. Kept at today's value only because dropping a public export breaks
// consumers; do not add uses.
export const MAX_LINES = 100_000;
// The live bail in computeMyersTrace: a pair whose true edit distance exceeds
// this degrades, independent of how many lines either side has. The only diff
// bound that still exists.
export const MAX_DIFF_EDIT_DISTANCE = 10_000;
// DEPRECATED — no consumer, and NOT a bound: the Myers iteration budget is
// MAX_DIFF_EDIT_DISTANCE alone and is not derived from any factor. Kept at
// today's value only because dropping a public export breaks consumers; do not
// add uses.
export const MAX_DIFF_ITERATION_FACTOR = 1_000;
// DEPRECATED — no consumer, and NOT a bound: diffLines no longer pre-checks
// total input size, so a pair far past this value diffs normally. Kept at
// today's value only because dropping a public export breaks consumers; do not
// add uses.
export const MAX_DIFF_LINES = 50_000;

const LF = 0x0a;
const NUL = 0x00;

export function splitLines(bytes: Uint8Array): ReadonlyArray<Uint8Array> {
  const lines: Uint8Array[] = [];
  let start = 0;
  // Stryker disable next-line EqualityOperator: equivalent — at i===bytes.length, bytes[i] is undefined, !== LF, the extra iteration is a no-op
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === LF) {
      lines.push(bytes.subarray(start, i + 1));
      start = i + 1;
    }
  }
  if (start < bytes.length) {
    lines.push(bytes.subarray(start));
  }
  return lines;
}

function hasNulInWindow(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, BINARY_DETECTION_BYTES);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === NUL) return true;
  }
  return false;
}

export function isBinary(bytes: Uint8Array): boolean {
  return hasNulInWindow(bytes);
}

type Edit = 'equal' | 'delete' | 'insert';

// Every stored value is an x-coordinate — a non-negative integer bounded by the
// line count — so the trace rows and the working array are Int32Array, not
// number[]: measured 3.9 bytes per cell against 7.7, exactly, with no change to
// any verdict.
interface MyersResult {
  readonly trace: ReadonlyArray<Int32Array>;
  readonly totalD: number;
}

// The classic Myers `k !== d` upper-edge guard is omitted: at k===d, v[k+1+offset]
// is the unwritten d+1 diagonal — 0 in the forward pass, undefined in a 2d+1-long
// reconstruction snapshot. Since v[k-1+offset]! is always a non-negative x-coordinate,
// `x < 0` / `x < undefined` is already false, so the comparison alone yields the
// guard's result without the redundant `k !== d &&`.
function chooseDown(v: Int32Array, offset: number, d: number, k: number): boolean {
  return k === -d || v[k - 1 + offset]! < v[k + 1 + offset]!;
}

// Positional equality over ours[i]/theirs[j] — a plain byte comparison for the
// default (no lineKey) path, or an interned-int lookup for the lineKey-active
// path (see buildLineEquality), so the Myers core never re-normalizes a line.
type LineEq = (i: number, j: number) => boolean;

function advanceSnake(
  oursLength: number,
  theirsLength: number,
  v: Int32Array,
  offset: number,
  d: number,
  k: number,
  eq: LineEq,
): { readonly x: number; readonly y: number } {
  const down = chooseDown(v, offset, d, k);
  let x = down ? v[k + 1 + offset]! : v[k - 1 + offset]! + 1;
  let y = x - k;
  while (x < oursLength && y < theirsLength && eq(x, y)) {
    x++;
    y++;
  }
  return { x, y };
}

function computeMyersTrace(
  oursLength: number,
  theirsLength: number,
  eq: LineEq,
  maxEditDistance: number,
): MyersResult | undefined {
  const M = oursLength;
  const N = theirsLength;
  // The loop below bails one step past maxEditDistance, so it never reaches a
  // diagonal outside [-maxEditDistance, maxEditDistance] however large the
  // input is. Sizing off M+N alone would allocate ~40M cells (305 MB,
  // measured) for a 10M-line-per-side pair before the first snake, to index
  // diagonals the walk cannot reach.
  const span = Math.min(M + N, maxEditDistance + 1);
  const offset = span;
  const v = new Int32Array(2 * span + 1);
  const trace: Int32Array[] = [];

  // Bailing on the edit distance itself, rather than on M+N or on a count
  // derived from it, bounds trace memory and CPU at a fixed ceiling
  // regardless of input size: reaching d = maxEditDistance costs the same
  // whether M+N is 20 000 or 20 000 000.
  for (let d = 0; ; d++) {
    if (d > maxEditDistance) return undefined;
    // Only store the active k-range [-d, d] (2*d+1 entries) instead of full v
    // to bound trace memory at O(D^2) instead of O(D*maxD).
    const snapLen = 2 * d + 1;
    const snapshot = new Int32Array(snapLen);
    // Stryker disable next-line EqualityOperator: equivalent — reconstructEdits only reads indices prevK+d ≤ 2d-1 < snapLen (k===d always picks down=false), so the extra index snapLen is never read; on a typed array the extra write is silently dropped as out of bounds
    for (let ki = 0; ki < snapLen; ki++) {
      snapshot[ki] = v[offset - d + ki]!;
    }
    trace.push(snapshot);
    for (let k = -d; k <= d; k += 2) {
      const snake = advanceSnake(oursLength, theirsLength, v, offset, d, k, eq);
      v[k + offset] = snake.x;
      if (snake.x >= M && snake.y >= N) {
        return { trace, totalD: d };
      }
    }
  }
}

function reconstructEdits(_M: number, _N: number, trace: ReadonlyArray<Int32Array>): Edit[] {
  const edits: Edit[] = [];
  let x = _M;
  let y = _N;

  for (let d = trace.length - 1; d > 0; d--) {
    const snap = trace[d]!;
    const localOffset = d;
    const k = x - y;
    const down = chooseDown(snap, localOffset, d, k);
    const prevK = down ? k + 1 : k - 1;
    const prevX = snap[prevK + localOffset]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      edits.push('equal');
      x--;
      y--;
    }
    edits.push(x === prevX ? 'insert' : 'delete');
    if (x === prevX) y--;
    else x--;
  }
  // The trailing run walks the d=0 Myers snake, a diagonal from the origin, so
  // x === y holds throughout. The y > 0 guard and the y decrement are therefore
  // redundant (y is never read after this loop) and are omitted — this keeps the
  // remaining mutants on the loop line fully killable.
  while (x > 0) {
    edits.push('equal');
    x--;
  }
  edits.reverse();
  return edits;
}

function buildHunks(edits: ReadonlyArray<Edit>): ReadonlyArray<LineHunk> {
  const hunks: LineHunk[] = [];
  let oursCursor = 0;
  let theirsCursor = 0;
  let i = 0;
  while (i < edits.length) {
    const kind = edits[i]!;
    const startOurs = oursCursor;
    const startTheirs = theirsCursor;
    // The `i < edits.length` bound is omitted: kind is always a defined Edit, and
    // edits[i] past the end is undefined, so `undefined === kind` is false and the
    // loop exits at the same point — keeping every mutant on this line killable.
    while (edits[i] === kind) {
      if (kind === 'equal') {
        oursCursor++;
        theirsCursor++;
      } else if (kind === 'delete') {
        oursCursor++;
      } else {
        theirsCursor++;
      }
      i++;
    }
    hunks.push({
      kind: kind === 'equal' ? 'common' : kind === 'delete' ? 'ours-only' : 'theirs-only',
      oursStart: startOurs,
      oursEnd: oursCursor,
      theirsStart: startTheirs,
      theirsEnd: theirsCursor,
    });
  }
  return hunks;
}

function wholeFileFallback(
  oursLines: ReadonlyArray<Uint8Array>,
  theirsLines: ReadonlyArray<Uint8Array>,
): LineDiff {
  const hunks: LineHunk[] = [];
  if (oursLines.length > 0) {
    hunks.push({
      kind: 'ours-only',
      oursStart: 0,
      oursEnd: oursLines.length,
      theirsStart: 0,
      theirsEnd: 0,
    });
  }
  if (theirsLines.length > 0) {
    hunks.push({
      kind: 'theirs-only',
      oursStart: oursLines.length,
      oursEnd: oursLines.length,
      theirsStart: 0,
      theirsEnd: theirsLines.length,
    });
  }
  return { hunks, oursLines, theirsLines, degraded: true };
}

// String.fromCharCode chunk size — comfortably under every engine's per-call
// argument-count ceiling, so a large normalized line never throws.
const BINARY_STRING_CHUNK = 8_192;

// A lossless byte->string projection (each byte maps 1:1 to a UTF-16 code
// unit), used only as an exact Map key for line interning below.
function binaryStringOf(bytes: Uint8Array): string {
  // NOTE: this line's EqualityOperator mutant relaxing `<=` to `<` is equivalent at the boundary (bytes.length === BINARY_STRING_CHUNK): the fast path returns `String.fromCharCode(...bytes)` directly, while the mutated guard sends that exact input through the chunked loop below with a single BINARY_STRING_CHUNK-sized chunk (i=0 only), which builds the identical string via one `out += String.fromCharCode(...bytes.subarray(0, BINARY_STRING_CHUNK))`. Left unannotated because the sibling `>` variant on this same line is a real, killed mutant, and Stryker's next-line disable can't distinguish variant from variant of the same mutator.
  if (bytes.length <= BINARY_STRING_CHUNK) return String.fromCharCode(...bytes);
  // Stryker disable next-line StringLiteral: equivalent — the seed is a fixed
  // literal `out` accumulates onto via `+=`; every call gets the identical
  // corrupted prefix, so relative equality/inequality between any two interned
  // keys (the only thing callers observe — the string itself is never surfaced)
  // is unchanged. A length-based collision with a fast-path (uncorrupted, ≤8192-
  // char) key is also impossible: a corrupted key is always strictly longer than
  // BINARY_STRING_CHUNK + the placeholder text, so its length alone rules out
  // matching any fast-path key.
  let out = '';
  for (let i = 0; i < bytes.length; i += BINARY_STRING_CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + BINARY_STRING_CHUNK));
  }
  return out;
}

// Normalize once per line and assign a shared int id (exact-key, no hashing —
// the Myers alignment for the withStat/patch path must be byte-identical to
// the un-interned comparison, so an approximate key is not an option here).
function internOne(line: Uint8Array, key: LineKey, table: Map<string, number>): number {
  const signature = binaryStringOf(normalizeLine(line, key));
  const existing = table.get(signature);
  if (existing !== undefined) return existing;
  const id = table.size;
  table.set(signature, id);
  return id;
}

function internLines(
  oursLines: ReadonlyArray<Uint8Array>,
  theirsLines: ReadonlyArray<Uint8Array>,
  key: LineKey,
): { readonly oursIds: Int32Array; readonly theirsIds: Int32Array } {
  const table = new Map<string, number>();
  const oursIds = new Int32Array(oursLines.length);
  const theirsIds = new Int32Array(theirsLines.length);
  for (let i = 0; i < oursLines.length; i++) oursIds[i] = internOne(oursLines[i]!, key, table);
  for (let j = 0; j < theirsLines.length; j++)
    theirsIds[j] = internOne(theirsLines[j]!, key, table);
  return { oursIds, theirsIds };
}

/**
 * Positional equality for the Myers core. Without a `lineKey`, a plain byte
 * comparison is already cheap. With one active, every line is normalized and
 * interned to an int ONCE up front (git's approach) instead of re-normalizing
 * on every snake comparison Myers makes — collapsing the repeat-allocation/GC
 * cost the string/byte-array path pays per comparison.
 */
function buildLineEquality(
  oursLines: ReadonlyArray<Uint8Array>,
  theirsLines: ReadonlyArray<Uint8Array>,
  lineKey: LineKey | undefined,
): LineEq {
  if (lineKey === undefined) {
    return (i, j) => bytesEqual(oursLines[i]!, theirsLines[j]!);
  }
  const { oursIds, theirsIds } = internLines(oursLines, theirsLines, lineKey);
  return (i, j) => oursIds[i] === theirsIds[j];
}

/**
 * Myers line diff of `ours` against `theirs`, degrading to a whole-file
 * replace when the pair's true edit distance exceeds `MAX_DIFF_EDIT_DISTANCE`.
 */
export function diffLines(
  ours: Uint8Array,
  theirs: Uint8Array,
  options?: LineDiffOptions,
): LineDiff {
  return diffLinesWithBound(ours, theirs, options, MAX_DIFF_EDIT_DISTANCE);
}

// Test-only seam: every production call site goes through `diffLines` above,
// which always runs at the fixed `MAX_DIFF_EDIT_DISTANCE`. This direct-bound
// entry lets unit tests pin the edit-distance bail at a small distance
// instead of allocating a MAX_DIFF_EDIT_DISTANCE-scale pair (hundreds of MB)
// to exercise the same boundary. Deliberately not re-exported from
// domain/diff/index.ts or public-types.ts — it must never become public API.
export function diffLinesWithBound(
  ours: Uint8Array,
  theirs: Uint8Array,
  options: LineDiffOptions | undefined,
  maxEditDistance: number,
): LineDiff {
  const lineKey = options?.lineKey;
  const oursLines = splitLines(ours);
  const theirsLines = splitLines(theirs);
  const M = oursLines.length;
  const N = theirsLines.length;

  if (M === 0 && N === 0) {
    return {
      hunks: [{ kind: 'common', oursStart: 0, oursEnd: 0, theirsStart: 0, theirsEnd: 0 }],
      oursLines,
      theirsLines,
      degraded: false,
    };
  }

  const eq = buildLineEquality(oursLines, theirsLines, lineKey);
  const myers = computeMyersTrace(M, N, eq, maxEditDistance);
  if (myers === undefined) {
    return wholeFileFallback(oursLines, theirsLines);
  }

  const edits = reconstructEdits(M, N, myers.trace);
  return {
    hunks: buildHunks(edits),
    oursLines,
    theirsLines,
    degraded: false,
  };
}
