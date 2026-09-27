// Transcribes git's xdiff/xdiffi.c `xdl_split` (:50-263), `xdl_recs_cmp`
// (:265-312) and the `xdl_do_diff` k-vector/env setup (:314-366), git 2.55.0.
// This is the linear-space, divide-and-conquer bidirectional Myers search
// that replaces the bounded classic Myers trace: instead of bailing past a
// fixed edit distance, its snake heuristic and cost cap return a valid,
// possibly non-minimal script in bounded time and O(M + N) memory.
//
// `xdl_recs_cmp`'s `reference_index` indirection is git's on-the-fly
// `get_hash(xdf, i) = xdf->recs[xdf->reference_index[i]].minimal_perfect_hash`
// on every comparison; here it is done once, up front, by remapping the two
// class-id arrays through xdl-prepare.ts's `referenceIndex` into a kept-space
// pair the rest of this module searches exactly as it always has — the
// search core below never changes between "every line kept" and "most lines
// discarded", only which array it is handed.

import type { LineClasses } from './xdl-classify.js';
import { bogosqrt, type Prepared, type SearchMode } from './xdl-prepare.js';

const XDL_MAX_COST_MIN = 256;
const XDL_HEUR_MIN_COST = 256;
const XDL_SNAKE_CNT = 20;
const XDL_K_HEUR = 4;
// git's XDL_LINE_MAX is LONG_MAX on the host register width — a sentinel
// further than any real line index can reach. Every value that flows through
// this module fits comfortably under the 32-bit signed max, so it stands in
// for "further than reachable" without needing the platform's true LONG_MAX.
const XDL_LINE_MAX = 0x7fff_ffff;

interface AlgoEnv {
  readonly mxcost: number;
  readonly snakeCnt: number;
  readonly heurMin: number;
}

/** One shared k-vector buffer for the whole `markChanges` call, addressed as
 *  git addresses `kvdf`/`kvdb`: pointers into a single allocation offset by
 *  `koffset = n2 + 1` (xdiffi.c:346-349). Every recursive box's diagonal
 *  range is a subset of the top box's, so one allocation, sized once, covers
 *  every split. */
interface KVectorGrid {
  readonly kvd: Int32Array;
  readonly ndiags: number;
  readonly koffset: number;
}

function forwardAt(grid: KVectorGrid, k: number): number {
  return grid.kvd[grid.koffset + k]!;
}

function setForwardAt(grid: KVectorGrid, k: number, value: number): void {
  grid.kvd[grid.koffset + k] = value;
}

function backwardAt(grid: KVectorGrid, k: number): number {
  return grid.kvd[grid.ndiags + grid.koffset + k]!;
}

function setBackwardAt(grid: KVectorGrid, k: number, value: number): void {
  grid.kvd[grid.ndiags + grid.koffset + k] = value;
}

/** A "box" — the (off1, lim1, off2, lim2) region `xdl_split` divides, plus
 *  the `need_min` flag its own split point carries into each half. */
interface Box {
  readonly off1: number;
  readonly lim1: number;
  readonly off2: number;
  readonly lim2: number;
  readonly needMin: boolean;
}

/** git's `xdpsplit_t`: the point `xdl_split` divides a box at, and whether
 *  each half must itself search minimally (a full snake connecting the
 *  forward and backward search is provably already minimal on both sides). */
interface SplitPoint {
  readonly i1: number;
  readonly i2: number;
  readonly minLo: boolean;
  readonly minHi: boolean;
}

interface DiagonalRange {
  readonly min: number;
  readonly max: number;
}

/** git's per-iteration domain growth (xdiffi.c:70-86, :107-123): extend the
 *  active diagonal range by one, writing the new edge's sentinel so the
 *  core scan needs no extra bounds check. */
function growForwardRange(
  grid: KVectorGrid,
  dmin: number,
  dmax: number,
  range: DiagonalRange,
): DiagonalRange {
  let { min, max } = range;
  if (min > dmin) setForwardAt(grid, --min - 1, -1);
  else min++;
  if (max < dmax) setForwardAt(grid, ++max + 1, -1);
  else max--;
  return { min, max };
}

function growBackwardRange(
  grid: KVectorGrid,
  dmin: number,
  dmax: number,
  range: DiagonalRange,
): DiagonalRange {
  let { min, max } = range;
  if (min > dmin) setBackwardAt(grid, --min - 1, XDL_LINE_MAX);
  else min++;
  if (max < dmax) setBackwardAt(grid, ++max + 1, XDL_LINE_MAX);
  else max--;
  return { min, max };
}

function extendForwardSnake(
  classes: LineClasses,
  box: Box,
  start1: number,
  start2: number,
): { readonly i1: number; readonly i2: number } {
  let i1 = start1;
  let i2 = start2;
  while (i1 < box.lim1 && i2 < box.lim2 && classes.ours[i1] === classes.theirs[i2]) {
    i1++;
    i2++;
  }
  return { i1, i2 };
}

function extendBackwardSnake(
  classes: LineClasses,
  box: Box,
  start1: number,
  start2: number,
): { readonly i1: number; readonly i2: number } {
  let i1 = start1;
  let i2 = start2;
  while (i1 > box.off1 && i2 > box.off2 && classes.ours[i1 - 1] === classes.theirs[i2 - 1]) {
    i1--;
    i2--;
  }
  return { i1, i2 };
}

interface ScanResult {
  readonly gotSnake: boolean;
  readonly found: SplitPoint | undefined;
}

/** git's forward core loop (xdiffi.c:88-105): extend every active diagonal's
 *  snake, and report a split the instant it crosses the backward search
 *  (an odd total edit distance meets in the middle on a forward step). */
function scanForward(
  classes: LineClasses,
  grid: KVectorGrid,
  box: Box,
  range: DiagonalRange,
  odd: number,
  backwardRange: DiagonalRange,
  env: AlgoEnv,
): ScanResult {
  let gotSnake = false;
  for (let d = range.max; d >= range.min; d -= 2) {
    const start =
      forwardAt(grid, d - 1) >= forwardAt(grid, d + 1)
        ? forwardAt(grid, d - 1) + 1
        : forwardAt(grid, d + 1);
    const { i1, i2 } = extendForwardSnake(classes, box, start, start - d);
    if (i1 - start > env.snakeCnt) gotSnake = true;
    setForwardAt(grid, d, i1);
    if (
      odd !== 0 &&
      backwardRange.min <= d &&
      d <= backwardRange.max &&
      backwardAt(grid, d) <= i1
    ) {
      return { gotSnake, found: { i1, i2, minLo: true, minHi: true } };
    }
  }
  return { gotSnake, found: undefined };
}

/** git's backward core loop (xdiffi.c:125-142) — the mirror of `scanForward`
 *  walking from each box's far corner inward. */
function scanBackward(
  classes: LineClasses,
  grid: KVectorGrid,
  box: Box,
  range: DiagonalRange,
  odd: number,
  forwardRange: DiagonalRange,
  env: AlgoEnv,
): ScanResult {
  let gotSnake = false;
  for (let d = range.max; d >= range.min; d -= 2) {
    const start =
      backwardAt(grid, d - 1) < backwardAt(grid, d + 1)
        ? backwardAt(grid, d - 1)
        : backwardAt(grid, d + 1) - 1;
    const { i1, i2 } = extendBackwardSnake(classes, box, start, start - d);
    if (start - i1 > env.snakeCnt) gotSnake = true;
    setBackwardAt(grid, d, i1);
    if (odd === 0 && forwardRange.min <= d && d <= forwardRange.max && i1 <= forwardAt(grid, d)) {
      return { gotSnake, found: { i1, i2, minLo: true, minHi: true } };
    }
  }
  return { gotSnake, found: undefined };
}

function forwardHeuristicValue(i1: number, i2: number, d: number, fmid: number, box: Box): number {
  const dd = d > fmid ? d - fmid : fmid - d;
  return i1 - box.off1 + (i2 - box.off2) - dd;
}

/**
 * git's inner snake-confirmation loop (xdiffi.c:167-173): a candidate
 * diagonal is only "interesting" once it carries a real snake at least
 * `snake_cnt` long ending at (i1, i2).
 *
 * @internal — exported for direct unit testing.
 */
export function hasForwardSnakeRun(
  classes: LineClasses,
  i1: number,
  i2: number,
  snakeCnt: number,
): boolean {
  for (let k = 1; classes.ours[i1 - k] === classes.theirs[i2 - k]; k++) {
    if (k === snakeCnt) return true;
  }
  return false;
}

/** git's forward heuristic scan (xdiffi.c:157-180): once an expensive search
 *  has produced a long snake, look for a diagonal reaching far enough past
 *  the mid-diagonal to be worth cutting to directly. */
function findForwardHeuristicSplit(
  classes: LineClasses,
  grid: KVectorGrid,
  box: Box,
  range: DiagonalRange,
  fmid: number,
  ec: number,
  env: AlgoEnv,
): SplitPoint | undefined {
  let best = 0;
  let found: SplitPoint | undefined;
  for (let d = range.max; d >= range.min; d -= 2) {
    const i1 = forwardAt(grid, d);
    const i2 = i1 - d;
    const v = forwardHeuristicValue(i1, i2, d, fmid, box);
    const inWindow =
      box.off1 + env.snakeCnt <= i1 &&
      i1 < box.lim1 &&
      box.off2 + env.snakeCnt <= i2 &&
      i2 < box.lim2;
    if (
      v > XDL_K_HEUR * ec &&
      v > best &&
      inWindow &&
      hasForwardSnakeRun(classes, i1, i2, env.snakeCnt)
    ) {
      best = v;
      found = { i1, i2, minLo: true, minHi: false };
    }
  }
  return found;
}

function backwardHeuristicValue(i1: number, i2: number, d: number, bmid: number, box: Box): number {
  const dd = d > bmid ? d - bmid : bmid - d;
  return box.lim1 - i1 + (box.lim2 - i2) - dd;
}

/**
 * git's inner snake-confirmation loop (xdiffi.c:191-197), backward: the
 * snake starts AT (i1, i2) and extends forward, so `k` starts at 0.
 *
 * @internal — exported for direct unit testing.
 */
export function hasBackwardSnakeRun(
  classes: LineClasses,
  i1: number,
  i2: number,
  snakeCnt: number,
): boolean {
  for (let k = 0; classes.ours[i1 + k] === classes.theirs[i2 + k]; k++) {
    if (k === snakeCnt - 1) return true;
  }
  return false;
}

/** git's backward heuristic scan (xdiffi.c:182-204) — the mirror of
 *  `findForwardHeuristicSplit` from the box's far corner. */
function findBackwardHeuristicSplit(
  classes: LineClasses,
  grid: KVectorGrid,
  box: Box,
  range: DiagonalRange,
  bmid: number,
  ec: number,
  env: AlgoEnv,
): SplitPoint | undefined {
  let best = 0;
  let found: SplitPoint | undefined;
  for (let d = range.max; d >= range.min; d -= 2) {
    const i1 = backwardAt(grid, d);
    const i2 = i1 - d;
    const v = backwardHeuristicValue(i1, i2, d, bmid, box);
    const inWindow =
      box.off1 < i1 &&
      i1 <= box.lim1 - env.snakeCnt &&
      box.off2 < i2 &&
      i2 <= box.lim2 - env.snakeCnt;
    if (
      v > XDL_K_HEUR * ec &&
      v > best &&
      inWindow &&
      hasBackwardSnakeRun(classes, i1, i2, env.snakeCnt)
    ) {
      best = v;
      found = { i1, i2, minLo: false, minHi: true };
    }
  }
  return found;
}

/** git's forward furthest-reach scan inside the cost cap (xdiffi.c:216-227):
 *  the diagonal whose (i1 + i2) corner distance is greatest, clipped to the
 *  box. */
function furthestForwardReach(
  grid: KVectorGrid,
  box: Box,
  range: DiagonalRange,
): { readonly sum: number; readonly i1: number } {
  let best = -1;
  let bestI1 = -1;
  for (let d = range.max; d >= range.min; d -= 2) {
    let i1 = Math.min(forwardAt(grid, d), box.lim1);
    let i2 = i1 - d;
    if (box.lim2 < i2) {
      i1 = box.lim2 + d;
      i2 = box.lim2;
    }
    if (best < i1 + i2) {
      best = i1 + i2;
      bestI1 = i1;
    }
  }
  return { sum: best, i1: bestI1 };
}

/** git's backward furthest-reach scan (xdiffi.c:229-241) — the mirror of
 *  `furthestForwardReach` from the box's far corner. */
function furthestBackwardReach(
  grid: KVectorGrid,
  box: Box,
  range: DiagonalRange,
): { readonly sum: number; readonly i1: number } {
  let best = XDL_LINE_MAX;
  let bestI1 = XDL_LINE_MAX;
  for (let d = range.max; d >= range.min; d -= 2) {
    let i1 = Math.max(box.off1, backwardAt(grid, d));
    let i2 = i1 - d;
    if (i2 < box.off2) {
      i1 = box.off2 + d;
      i2 = box.off2;
    }
    if (i1 + i2 < best) {
      best = i1 + i2;
      bestI1 = i1;
    }
  }
  return { sum: best, i1: bestI1 };
}

/** git's cost-cap cutoff (xdiffi.c:212-255): once the search has spent
 *  `mxcost`, stop and take whichever direction reached furthest — a valid
 *  but possibly non-minimal split. */
function costCappedSplit(
  grid: KVectorGrid,
  box: Box,
  forwardRange: DiagonalRange,
  backwardRange: DiagonalRange,
): SplitPoint {
  const forwardReach = furthestForwardReach(grid, box, forwardRange);
  const backwardReach = furthestBackwardReach(grid, box, backwardRange);
  const takeForward =
    box.lim1 + box.lim2 - backwardReach.sum < forwardReach.sum - (box.off1 + box.off2);
  return takeForward
    ? { i1: forwardReach.i1, i2: forwardReach.sum - forwardReach.i1, minLo: true, minHi: false }
    : { i1: backwardReach.i1, i2: backwardReach.sum - backwardReach.i1, minLo: false, minHi: true };
}

interface SplitState {
  readonly dmin: number;
  readonly dmax: number;
  readonly fmid: number;
  readonly bmid: number;
  readonly odd: number;
}

function initSplitState(box: Box): SplitState {
  const dmin = box.off1 - box.lim2;
  const dmax = box.lim1 - box.off2;
  const fmid = box.off1 - box.off2;
  const bmid = box.lim1 - box.lim2;
  return { dmin, dmax, fmid, bmid, odd: (fmid - bmid) & 1 };
}

/** git's snake heuristic and cost-cap cutoffs (xdiffi.c:144-255): skipped
 *  entirely when the box's own `need_min` demands a minimal split, exactly
 *  as git's `if (need_min) continue;` guard. */
function trySplitCutoff(
  classes: LineClasses,
  grid: KVectorGrid,
  box: Box,
  env: AlgoEnv,
  forwardRange: DiagonalRange,
  backwardRange: DiagonalRange,
  state: SplitState,
  ec: number,
  gotSnake: boolean,
): SplitPoint | undefined {
  if (gotSnake && ec > env.heurMin) {
    const forwardHeuristic = findForwardHeuristicSplit(
      classes,
      grid,
      box,
      forwardRange,
      state.fmid,
      ec,
      env,
    );
    if (forwardHeuristic !== undefined) return forwardHeuristic;
    const backwardHeuristic = findBackwardHeuristicSplit(
      classes,
      grid,
      box,
      backwardRange,
      state.bmid,
      ec,
      env,
    );
    if (backwardHeuristic !== undefined) return backwardHeuristic;
  }
  return ec >= env.mxcost ? costCappedSplit(grid, box, forwardRange, backwardRange) : undefined;
}

/** git's `xdl_split` (xdiffi.c:50-257): the Myers bidirectional search over
 *  one box, cut short by the snake heuristic or the cost cap unless the box
 *  demands a minimal split. */
function xdlSplit(classes: LineClasses, grid: KVectorGrid, env: AlgoEnv, box: Box): SplitPoint {
  const state = initSplitState(box);
  let forwardRange: DiagonalRange = { min: state.fmid, max: state.fmid };
  let backwardRange: DiagonalRange = { min: state.bmid, max: state.bmid };
  setForwardAt(grid, state.fmid, box.off1);
  setBackwardAt(grid, state.bmid, box.lim1);

  for (let ec = 1; ; ec++) {
    forwardRange = growForwardRange(grid, state.dmin, state.dmax, forwardRange);
    const forwardScan = scanForward(
      classes,
      grid,
      box,
      forwardRange,
      state.odd,
      backwardRange,
      env,
    );
    if (forwardScan.found !== undefined) return forwardScan.found;

    backwardRange = growBackwardRange(grid, state.dmin, state.dmax, backwardRange);
    const backwardScan = scanBackward(
      classes,
      grid,
      box,
      backwardRange,
      state.odd,
      forwardRange,
      env,
    );
    if (backwardScan.found !== undefined) return backwardScan.found;

    if (box.needMin) continue;
    const cutoff = trySplitCutoff(
      classes,
      grid,
      box,
      env,
      forwardRange,
      backwardRange,
      state,
      ec,
      forwardScan.gotSnake || backwardScan.gotSnake,
    );
    if (cutoff !== undefined) return cutoff;
  }
}

/** git's box-shrink prefix (xdiffi.c:270-273): trim the common leading
 *  snake, then the common trailing one. */
function trimBox(classes: LineClasses, box: Box): Box {
  let { off1, off2 } = box;
  while (off1 < box.lim1 && off2 < box.lim2 && classes.ours[off1] === classes.theirs[off2]) {
    off1++;
    off2++;
  }
  let { lim1, lim2 } = box;
  while (off1 < lim1 && off2 < lim2 && classes.ours[lim1 - 1] === classes.theirs[lim2 - 1]) {
    lim1--;
    lim2--;
  }
  return { off1, lim1, off2, lim2, needMin: box.needMin };
}

/** git's empty-dimension base case (xdiffi.c:279-284): once one side of a
 *  trimmed box is empty, every record on the other side is unmatchable and
 *  therefore changed. Returns whether the box was fully resolved this way. */
function markIfOneSideEmpty(box: Box, oursChanged: Uint8Array, theirsChanged: Uint8Array): boolean {
  if (box.off1 === box.lim1) {
    for (let j = box.off2; j < box.lim2; j++) theirsChanged[j] = 1;
    return true;
  }
  if (box.off2 === box.lim2) {
    for (let i = box.off1; i < box.lim1; i++) oursChanged[i] = 1;
    return true;
  }
  return false;
}

/** git's `xdl_recs_cmp` (xdiffi.c:265-311), run over an explicit work stack
 *  instead of native recursion: the two halves `xdl_split` divides a box
 *  into are independent (they mark disjoint index ranges), so an adversarial
 *  input that would recurse arbitrarily deep in C cannot overflow the JS
 *  call stack here — it only grows this array. */
function xdlRecsCmp(
  classes: LineClasses,
  oursChanged: Uint8Array,
  theirsChanged: Uint8Array,
  grid: KVectorGrid,
  env: AlgoEnv,
  root: Box,
): void {
  const stack: Box[] = [root];
  let box = stack.pop();
  while (box !== undefined) {
    const trimmed = trimBox(classes, box);
    if (!markIfOneSideEmpty(trimmed, oursChanged, theirsChanged)) {
      const split = xdlSplit(classes, grid, env, trimmed);
      stack.push({
        off1: trimmed.off1,
        lim1: split.i1,
        off2: trimmed.off2,
        lim2: split.i2,
        needMin: split.minLo,
      });
      stack.push({
        off1: split.i1,
        lim1: trimmed.lim1,
        off2: split.i2,
        lim2: trimmed.lim2,
        needMin: split.minHi,
      });
    }
    box = stack.pop();
  }
}

/** Builds the kept-space class-id array git reads through
 *  `get_hash(xdf, i) = xdf->recs[xdf->reference_index[i]].minimal_perfect_hash`:
 *  one lookup per kept line, up front, rather than one indirection per
 *  comparison during the search. */
function mapToKeptSpace(ids: Int32Array, referenceIndex: Int32Array): Int32Array {
  const kept = new Int32Array(referenceIndex.length);
  for (let i = 0; i < referenceIndex.length; i++) kept[i] = ids[referenceIndex[i]!]!;
  return kept;
}

/** Scatters a kept-space `changed` result back through `referenceIndex` into
 *  original-index space — the mirror of `mapToKeptSpace`, and of git's own
 *  `xdf->changed[xdf->reference_index[off]] = true` (xdiffi.c:281, :284). */
function scatterToOriginalSpace(
  changedInKeptSpace: Uint8Array,
  referenceIndex: Int32Array,
  changed: Uint8Array,
): void {
  for (let i = 0; i < changedInKeptSpace.length; i++) {
    if (changedInKeptSpace[i] !== 0) changed[referenceIndex[i]!] = 1;
  }
}

/**
 * git's `xdl_do_diff` k-vector setup (xdiffi.c:334-359) plus `xdl_recs_cmp`:
 * marks every changed line of `ours` and `theirs` via the linear-space
 * divide-and-conquer Myers search, never bailing however large the edit
 * distance is. Searches the kept-space view `prepared` holds (built by
 * xdl-prepare.ts's `cleanupRecords`) rather than every line, and mutates
 * `prepared.ours.changed` / `prepared.theirs.changed` in place — already
 * pre-marked with `cleanupRecords`'s own discards — matching git's own
 * `xdf->changed` representation. `mode === 'minimal'` forces the root box
 * to search minimally; git's own `need_min` box flag is contagious from
 * there (every genuine crossing returns `minLo: true, minHi: true`), so no
 * further threading is needed.
 */
export function markChanges(classes: LineClasses, prepared: Prepared, mode: SearchMode): void {
  const keptOurs = mapToKeptSpace(classes.ours, prepared.ours.referenceIndex);
  const keptTheirs = mapToKeptSpace(classes.theirs, prepared.theirs.referenceIndex);
  const keptClasses: LineClasses = {
    ours: keptOurs,
    theirs: keptTheirs,
    classCount: classes.classCount,
  };

  const M = keptOurs.length;
  const N = keptTheirs.length;
  const ndiags = M + N + 3;
  const koffset = N + 1;
  const grid: KVectorGrid = { kvd: new Int32Array(2 * ndiags + 2), ndiags, koffset };
  const env: AlgoEnv = {
    mxcost: Math.max(bogosqrt(ndiags), XDL_MAX_COST_MIN),
    snakeCnt: XDL_SNAKE_CNT,
    heurMin: XDL_HEUR_MIN_COST,
  };
  const oursChangedKept = new Uint8Array(M);
  const theirsChangedKept = new Uint8Array(N);
  xdlRecsCmp(keptClasses, oursChangedKept, theirsChangedKept, grid, env, {
    off1: 0,
    lim1: M,
    off2: 0,
    lim2: N,
    needMin: mode === 'minimal',
  });
  scatterToOriginalSpace(oursChangedKept, prepared.ours.referenceIndex, prepared.ours.changed);
  scatterToOriginalSpace(
    theirsChangedKept,
    prepared.theirs.referenceIndex,
    prepared.theirs.changed,
  );
}
