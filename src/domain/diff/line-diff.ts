export interface LineHunk {
  readonly kind: 'common' | 'ours-only' | 'theirs-only';
  readonly oursStart: number;
  readonly oursEnd: number;
  readonly theirsStart: number;
  readonly theirsEnd: number;
}

export interface LineDiff {
  readonly hunks: ReadonlyArray<LineHunk>;
  readonly oursLines: ReadonlyArray<Uint8Array>;
  readonly theirsLines: ReadonlyArray<Uint8Array>;
  readonly degraded: boolean;
}

export const BINARY_DETECTION_BYTES = 8_000;
export const MAX_LINE_BYTES = 65_536;
export const MAX_LINES = 100_000;
export const MAX_DIFF_EDIT_DISTANCE = 10_000;
export const MAX_DIFF_ITERATION_FACTOR = 1_000;
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

function exceedsLineCaps(bytes: Uint8Array): boolean {
  let currentLineBytes = 0;
  let lineCount = 0;
  for (let i = 0; i < bytes.length; i++) {
    currentLineBytes++;
    if (currentLineBytes >= MAX_LINE_BYTES) return true;
    if (bytes[i] === LF) {
      lineCount++;
      if (lineCount >= MAX_LINES) return true;
      currentLineBytes = 0;
    }
  }
  if (currentLineBytes > 0) {
    lineCount++;
    if (lineCount >= MAX_LINES) return true;
  }
  return false;
}

export function isBinary(bytes: Uint8Array): boolean {
  return hasNulInWindow(bytes) || exceedsLineCaps(bytes);
}

function linesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  // Stryker disable next-line EqualityOperator: equivalent — lengths are equal here, so at i===a.length both a[i] and b[i] are undefined and undefined !== undefined is false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

type Edit = 'equal' | 'delete' | 'insert';

interface MyersResult {
  readonly trace: ReadonlyArray<ReadonlyArray<number>>;
  readonly totalD: number;
}

// The classic Myers `k !== d` upper-edge guard is omitted: at k===d, v[k+1+offset]
// is the unwritten d+1 diagonal — 0 in the forward pass, undefined in a 2d+1-long
// reconstruction snapshot. Since v[k-1+offset]! is always a non-negative x-coordinate,
// `x < 0` / `x < undefined` is already false, so the comparison alone yields the
// guard's result without the redundant `k !== d &&`.
function chooseDown(v: ReadonlyArray<number>, offset: number, d: number, k: number): boolean {
  return k === -d || v[k - 1 + offset]! < v[k + 1 + offset]!;
}

function advanceSnake(
  oursLines: ReadonlyArray<Uint8Array>,
  theirsLines: ReadonlyArray<Uint8Array>,
  v: ReadonlyArray<number>,
  offset: number,
  d: number,
  k: number,
): { readonly x: number; readonly y: number } {
  const down = chooseDown(v, offset, d, k);
  let x = down ? v[k + 1 + offset]! : v[k - 1 + offset]! + 1;
  let y = x - k;
  while (
    x < oursLines.length &&
    y < theirsLines.length &&
    linesEqual(oursLines[x]!, theirsLines[y]!)
  ) {
    x++;
    y++;
  }
  return { x, y };
}

function computeMyersTrace(
  oursLines: ReadonlyArray<Uint8Array>,
  theirsLines: ReadonlyArray<Uint8Array>,
): MyersResult | undefined {
  const M = oursLines.length;
  const N = theirsLines.length;
  // Each trace snapshot is 2*(M+N)+1 numbers (8 bytes each).
  // At MAX_DIFF_EDIT_DISTANCE iterations, worst-case heap ~ 10K * 2*(M+N) * 8.
  // Cap total lines to keep heap under ~800MB.
  if (M + N > MAX_DIFF_LINES) return undefined;
  const maxD = M + N;
  const offset = maxD;
  const v = new Array<number>(2 * maxD + 1).fill(0);
  const trace: number[][] = [];

  const iterationBudget = maxD * MAX_DIFF_ITERATION_FACTOR;
  let iterations = 0;
  // Iteration budget bounds total CPU. The MAX_DIFF_LINES pre-check above
  // bounds M+N, which transitively caps D (edit distance ≤ M+N ≤ MAX_DIFF_LINES) and
  // trace memory (snapshots × v-array size). Together they subsume the design's
  // MAX_DIFF_EDIT_DISTANCE constant, which remains exported for documentation.
  for (let d = 0; ; d++) {
    // Only store the active k-range [-d, d] (2*d+1 entries) instead of full v
    // to bound trace memory at O(D^2) instead of O(D*maxD).
    const snapLen = 2 * d + 1;
    // Stryker disable next-line ArrayDeclaration: equivalent — the loop below densely fills indices 0..snapLen-1, so a pre-sized array and an empty one converge to identical content
    const snapshot = new Array<number>(snapLen);
    // Stryker disable next-line EqualityOperator: equivalent — reconstructEdits only reads indices prevK+d ≤ 2d-1 < snapLen (k===d always picks down=false), so the extra index snapLen is never read
    for (let ki = 0; ki < snapLen; ki++) {
      snapshot[ki] = v[offset - d + ki]!;
    }
    trace.push(snapshot);
    for (let k = -d; k <= d; k += 2) {
      iterations++;
      if (iterations > iterationBudget) return undefined;
      const snake = advanceSnake(oursLines, theirsLines, v, offset, d, k);
      v[k + offset] = snake.x;
      if (snake.x >= M && snake.y >= N) {
        return { trace, totalD: d };
      }
    }
  }
}

function reconstructEdits(
  _M: number,
  _N: number,
  trace: ReadonlyArray<ReadonlyArray<number>>,
): Edit[] {
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

export function diffLines(ours: Uint8Array, theirs: Uint8Array): LineDiff {
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

  const myers = computeMyersTrace(oursLines, theirsLines);
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
