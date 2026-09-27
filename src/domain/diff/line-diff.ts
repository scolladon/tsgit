import type { LineKey } from './whitespace.js';
import { classifyLines } from './xdiff/xdl-classify.js';
import { compactChanges } from './xdiff/xdl-compact.js';

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
// Live in exactly one place: the window grep's binary-presence probe scans
// (grep.ts). It does NOT bound the regex match path, whose per-line window was
// reverted — a text line is matched in full, at any length.
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

// Positional equality over ours[i]/theirs[j] — always an interned class-id
// lookup (see classifyLines), so the Myers core never re-reads or
// re-normalizes a line's bytes on any probe.
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
  //
  // DEPENDS on the caller returning early for M === 0 && N === 0. There `span`
  // is 0, and the two array kinds stop disagreeing about out-of-range reads: a
  // number[] yields undefined (every comparison false, so the walk exhausts the
  // budget and degrades) where an Int32Array coerces to 0 and returns a trace
  // for a pair that has no lines. Relaxing that upstream guard silently changes
  // this function's verdict — re-check it here before touching it.
  // Stryker disable next-line MethodExpression: equivalent — Math.max only ever widens the row. Every read and write is v[k + offset] with |k| ≤ d ≤ maxEditDistance, and offset is span itself, so both sizes address the same diagonals in bounds and the walk returns the same trace; only the allocation this line exists to shrink differs.
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

/** The edit script as two per-side boolean maps — git's own `xdf->changed`
 *  representation, and what `compactChanges` slides in place. */
function changedArraysFromEdits(
  oursLength: number,
  theirsLength: number,
  edits: ReadonlyArray<Edit>,
): { readonly oursChanged: Uint8Array; readonly theirsChanged: Uint8Array } {
  const oursChanged = new Uint8Array(oursLength);
  const theirsChanged = new Uint8Array(theirsLength);
  let oursCursor = 0;
  let theirsCursor = 0;
  for (const edit of edits) {
    if (edit === 'equal') {
      oursCursor++;
      theirsCursor++;
    } else if (edit === 'delete') {
      oursChanged[oursCursor++] = 1;
    } else {
      theirsChanged[theirsCursor++] = 1;
    }
  }
  return { oursChanged, theirsChanged };
}

function commonHunk(
  oursStart: number,
  oursEnd: number,
  theirsStart: number,
  theirsEnd: number,
): LineHunk {
  return { kind: 'common', oursStart, oursEnd, theirsStart, theirsEnd };
}

function oursOnlyHunk(oursStart: number, oursEnd: number, theirsPos: number): LineHunk {
  return { kind: 'ours-only', oursStart, oursEnd, theirsStart: theirsPos, theirsEnd: theirsPos };
}

function theirsOnlyHunk(oursPos: number, theirsStart: number, theirsEnd: number): LineHunk {
  return { kind: 'theirs-only', oursStart: oursPos, oursEnd: oursPos, theirsStart, theirsEnd };
}

/** Walks both post-compaction changed maps to the next common-line pair,
 *  starting from `(i, j)`. */
function consumeCommonRun(
  oursChanged: Uint8Array,
  theirsChanged: Uint8Array,
  i: number,
  j: number,
): { readonly i: number; readonly j: number } {
  let nextI = i;
  let nextJ = j;
  while (
    nextI < oursChanged.length &&
    nextJ < theirsChanged.length &&
    oursChanged[nextI] === 0 &&
    theirsChanged[nextJ] === 0
  ) {
    nextI++;
    nextJ++;
  }
  return { i: nextI, j: nextJ };
}

function consumeChangedRun(changed: Uint8Array, start: number): number {
  let i = start;
  while (i < changed.length && changed[i] !== 0) i++;
  return i;
}

/**
 * Rebuilds `LineHunk`s from the two (post-compaction) changed maps: a common
 * run, then — per gap between common runs — an `ours-only` hunk before a
 * `theirs-only` hunk, matching git's per-side change-group ordering.
 */
function buildHunksFromChanged(
  oursChanged: Uint8Array,
  theirsChanged: Uint8Array,
): ReadonlyArray<LineHunk> {
  const hunks: LineHunk[] = [];
  const M = oursChanged.length;
  const N = theirsChanged.length;
  let i = 0;
  let j = 0;
  while (i < M || j < N) {
    const common = consumeCommonRun(oursChanged, theirsChanged, i, j);
    if (common.i > i || common.j > j) hunks.push(commonHunk(i, common.i, j, common.j));
    ({ i, j } = common);
    const oursEnd = consumeChangedRun(oursChanged, i);
    if (oursEnd > i) hunks.push(oursOnlyHunk(i, oursEnd, j));
    i = oursEnd;
    const theirsEnd = consumeChangedRun(theirsChanged, j);
    if (theirsEnd > j) hunks.push(theirsOnlyHunk(i, j, theirsEnd));
    j = theirsEnd;
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
  return diffPresplitLinesWithBound(splitLines(ours), splitLines(theirs), options, maxEditDistance);
}

/**
 * `diffLines`'s counterpart for a caller that already holds both sides
 * split — `blame`'s changed-parent hop, where the child side is the
 * previous generation's carried `Suspect.lines` and only the parent side is
 * genuinely new. Skips `splitLines` entirely on both inputs; the returned
 * `oursLines`/`theirsLines` are the SAME array references passed in, not
 * copies.
 */
export function diffPresplitLines(
  oursLines: ReadonlyArray<Uint8Array>,
  theirsLines: ReadonlyArray<Uint8Array>,
  options?: LineDiffOptions,
): LineDiff {
  return diffPresplitLinesWithBound(oursLines, theirsLines, options, MAX_DIFF_EDIT_DISTANCE);
}

// Test-only seam, mirroring `diffLinesWithBound`'s — deliberately not
// re-exported from domain/diff/index.ts or public-types.ts.
export function diffPresplitLinesWithBound(
  oursLines: ReadonlyArray<Uint8Array>,
  theirsLines: ReadonlyArray<Uint8Array>,
  options: LineDiffOptions | undefined,
  maxEditDistance: number,
): LineDiff {
  const lineKey = options?.lineKey;
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

  const classes = classifyLines(oursLines, theirsLines, lineKey);
  const eq: LineEq = (i, j) => classes.ours[i] === classes.theirs[j];
  const myers = computeMyersTrace(M, N, eq, maxEditDistance);
  if (myers === undefined) {
    return wholeFileFallback(oursLines, theirsLines);
  }

  const edits = reconstructEdits(M, N, myers.trace);
  const { oursChanged, theirsChanged } = changedArraysFromEdits(M, N, edits);
  // git's own order (xdl_diff, xdiffi.c): compact ours against theirs, then
  // theirs against ours — a group that merges on the first pass can free up
  // a slide on the second.
  compactChanges(oursChanged, theirsChanged, classes.ours, oursLines);
  compactChanges(theirsChanged, oursChanged, classes.theirs, theirsLines);
  return {
    hunks: buildHunksFromChanged(oursChanged, theirsChanged),
    oursLines,
    theirsLines,
    degraded: false,
  };
}
