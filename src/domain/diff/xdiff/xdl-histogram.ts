// Transcribes git's xdiff/xhistogram.c (git 2.55.0): `scanA`, `try_lcs`,
// `find_lcs` and `histogram_diff`. Lines are 1-based here, as in the C, so
// `line - 1` indexes the class and changed arrays. Records hang off class ids
// rather than hash buckets: a bucket's other records never compare equal to
// the probed line, so only the chain-length cap (an allocation-failure path in
// git) could observe the difference.
import type { LineClasses } from './xdl-classify.js';
import {
  type ClassicFallback,
  type LineRegion,
  markRegion,
  type RegionSink,
} from './xdl-region.js';

/** xhistogram.c's `max_chain_length`: a region whose every common line repeats
 *  more often than this is handed to the classic (Myers) diff instead. */
const MAX_CHAIN_LENGTH = 64;

interface HistogramIndex {
  readonly a: Int32Array;
  readonly b: Int32Array;
  readonly recordGeneration: Int32Array;
  readonly recordPtr: Int32Array;
  readonly recordCount: Int32Array;
  readonly nextPtr: Int32Array;
  generation: number;
}

interface LcsSearch {
  begin1: number;
  end1: number;
  begin2: number;
  end2: number;
  cnt: number;
  hasCommon: boolean;
}

interface Match {
  readonly as: number;
  readonly ae: number;
  readonly bs: number;
  readonly be: number;
  readonly rc: number;
}

function scanA(index: HistogramIndex, line1: number, count1: number): void {
  const { a, recordGeneration, recordPtr, recordCount, nextPtr, generation } = index;
  for (let ptr = line1 + count1 - 1; ptr >= line1; ptr--) {
    const cls = a[ptr - 1]!;
    if (recordGeneration[cls] === generation) {
      nextPtr[ptr - 1] = recordPtr[cls]!;
      recordCount[cls]!++;
    } else {
      recordGeneration[cls] = generation;
      recordCount[cls] = 1;
      nextPtr[ptr - 1] = 0;
    }
    recordPtr[cls] = ptr;
  }
}

const countAt = (index: HistogramIndex, ptr: number): number =>
  index.recordCount[index.a[ptr - 1]!]!;

/** Grows the match at `(as, bPtr)` both ways, tracking the rarest count it spans. */
function extendMatch(
  index: HistogramIndex,
  region: LineRegion,
  start: { readonly as: number; readonly bs: number },
  recordCount: number,
): Match {
  const { a, b } = index;
  const end1 = region.line1 + region.count1 - 1;
  const end2 = region.line2 + region.count2 - 1;
  let { as, bs } = start;
  let ae = as;
  let be = bs;
  let rc = recordCount;
  while (region.line1 < as && region.line2 < bs && a[as - 2] === b[bs - 2]) {
    as--;
    bs--;
    if (1 < rc) rc = Math.min(rc, countAt(index, as));
  }
  while (ae < end1 && be < end2 && a[ae] === b[be]) {
    ae++;
    be++;
    if (1 < rc) rc = Math.min(rc, countAt(index, ae));
  }
  return { as, ae, bs, be, rc };
}

function recordMatch(search: LcsSearch, match: Match): void {
  if (search.end1 - search.begin1 < match.ae - match.as || match.rc < search.cnt) {
    search.begin1 = match.as;
    search.begin2 = match.bs;
    search.end1 = match.ae;
    search.end2 = match.be;
    search.cnt = match.rc;
  }
}

/** The next occurrence of the record past `ae`, or 0 when its chain runs out. */
function nextOccurrenceAfter(index: HistogramIndex, from: number, ae: number): number {
  let np = index.nextPtr[from - 1]!;
  while (np !== 0 && np <= ae) np = index.nextPtr[np - 1]!;
  return np;
}

function tryLcs(
  index: HistogramIndex,
  search: LcsSearch,
  bPtr: number,
  region: LineRegion,
): number {
  let bNext = bPtr + 1;
  const cls = index.b[bPtr - 1]!;
  if (index.recordGeneration[cls] !== index.generation) return bNext;
  search.hasCommon = true;
  const recordCount = index.recordCount[cls]!;
  if (recordCount > search.cnt) return bNext;
  let as = index.recordPtr[cls]!;
  while (as !== 0) {
    const match = extendMatch(index, region, { as, bs: bPtr }, recordCount);
    if (bNext <= match.be) bNext = match.be + 1;
    recordMatch(search, match);
    as = nextOccurrenceAfter(index, as, match.ae);
  }
  return bNext;
}

function findLcs(index: HistogramIndex, region: LineRegion): LcsSearch {
  index.generation++;
  scanA(index, region.line1, region.count1);
  const search: LcsSearch = {
    begin1: 0,
    end1: 0,
    begin2: 0,
    end2: 0,
    cnt: MAX_CHAIN_LENGTH + 1,
    hasCommon: false,
  };
  const end2 = region.line2 + region.count2 - 1;
  for (let bPtr = region.line2; bPtr <= end2; ) bPtr = tryLcs(index, search, bPtr, region);
  return search;
}

/** One `histogram_diff` step: marks what it settles, returns the sub-regions left to diff. */
function splitRegion(
  index: HistogramIndex,
  region: LineRegion,
  sink: RegionSink,
): ReadonlyArray<LineRegion> {
  if (region.count1 === 0 || region.count2 === 0) {
    markRegion(sink, region);
    return [];
  }
  const lcs = findLcs(index, region);
  if (lcs.hasCommon && MAX_CHAIN_LENGTH < lcs.cnt) {
    sink.fallback(region);
    return [];
  }
  if (lcs.begin1 === 0 && lcs.begin2 === 0) {
    markRegion(sink, region);
    return [];
  }
  return regionsAround(region, lcs);
}

/** The sub-regions before and after the common sequence `lcs` found in `region`. */
function regionsAround(region: LineRegion, lcs: LcsSearch): ReadonlyArray<LineRegion> {
  const { line1, count1, line2, count2 } = region;
  return [
    { line1, count1: lcs.begin1 - line1, line2, count2: lcs.begin2 - line2 },
    {
      line1: lcs.end1 + 1,
      count1: line1 + count1 - 1 - lcs.end1,
      line2: lcs.end2 + 1,
      count2: line2 + count2 - 1 - lcs.end2,
    },
  ];
}

/**
 * git's `xdl_do_histogram_diff` over the whole of both sides (histogram skips
 * xprepare's trimming and discarding): marks `oursChanged` / `theirsChanged`
 * from the class ids, handing over-repeated regions to `fallback`. Regions are
 * disjoint and each is diffed independently, so an explicit stack replaces the
 * C recursion without changing the result.
 */
export function markHistogramChanges(
  classes: LineClasses,
  oursChanged: Uint8Array,
  theirsChanged: Uint8Array,
  fallback: ClassicFallback,
): void {
  const index: HistogramIndex = {
    a: classes.ours,
    b: classes.theirs,
    recordGeneration: new Int32Array(classes.classCount),
    recordPtr: new Int32Array(classes.classCount),
    recordCount: new Int32Array(classes.classCount),
    nextPtr: new Int32Array(classes.ours.length),
    generation: 0,
  };
  const sink: RegionSink = { oursChanged, theirsChanged, fallback };
  const pending: LineRegion[] = [
    { line1: 1, count1: classes.ours.length, line2: 1, count2: classes.theirs.length },
  ];
  for (let region = pending.pop(); region !== undefined; region = pending.pop()) {
    pending.push(...splitRegion(index, region, sink));
  }
}
