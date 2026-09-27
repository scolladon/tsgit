// Transcribes git's xdiff/xprepare.c `xdl_trim_ends` (:388-411), `xdl_cleanup_records`
// (:265-382) and `xdl_clean_mmatch` (:194-257), plus `xdl_bogosqrt`
// (xdiff/xutils.c:26-36, moved here from xdl-split.ts — cleanupRecords is now its
// other caller), git 2.55.0.
//
// Narrows the Myers search from "every line" to "every line git could possibly
// need to compare": a common leading/trailing run is trimmed first
// (`trimEnds`), then any line with no match at all on the other side — or,
// once its class occurs at least `mlim` times, only if it sits amid a longer
// run of no-match lines (`cleanMmatch`) — is discarded outright
// (`cleanupRecords`). What survives becomes `referenceIndex`: the kept-space
// view the split search (xdl-split.ts) walks instead of every line.
//
// `need_min` (xprepare.c:269) runs even when the caller asked for a minimal
// diff: it only widens `mlim` to infinity (xprepare.c:291-299), so a line
// with literally zero matches on the other side is discarded unconditionally
// in both modes.

import type { LineClasses } from './xdl-classify.js';

export const XDL_KPDIS_RUN = 4;
export const XDL_MAX_EQLIMIT = 1024;
export const XDL_SIMSCAN_WINDOW = 100;

const ACTION = {
  DISCARD: 0,
  KEEP: 1,
  INVESTIGATE: 2,
} as const;
type Action = (typeof ACTION)[keyof typeof ACTION];

/** git's `xpparam_t.flags & XDF_NEED_MINIMAL`, named by a string union rather
 *  than a boolean: `'git-default'` is what every production caller passes;
 *  `'minimal'` only exists for the property oracle in
 *  xdiff.properties.test.ts, which needs a diff provably as small as
 *  `M + N - 2·LCS`. */
export type SearchMode = 'git-default' | 'minimal';

/** git's `xdl_bogosqrt`: a cheap, monotonic sqrt-ish approximation via
 *  repeated halving of the shift exponent — not a real square root, just
 *  fast, which is all `mlim` and the split's cost cap need. */
export function bogosqrt(n: number): number {
  let i = 1;
  for (let remaining = n; remaining > 0; remaining >>>= 2) i <<= 1;
  return i;
}

export interface PreparedSide {
  /** Original-index space, length = that side's own line count. Discards
   *  found here are pre-marked `1`; the split search (xdl-split.ts) only
   *  ever adds more `1`s on top, never clears one. */
  readonly changed: Uint8Array;
  /** Original indices of the lines `cleanupRecords` kept, in order — the
   *  kept-space view the split search walks instead of every line. */
  readonly referenceIndex: Int32Array;
}

export interface Prepared {
  readonly ours: PreparedSide;
  readonly theirs: PreparedSide;
}

export interface TrimmedEnds {
  readonly dstart: number;
  readonly oursDend: number;
  readonly theirsDend: number;
}

/**
 * git's `xdl_trim_ends`: the common leading run (by class id, walking both
 * sides together) then the common trailing run — narrows `[dstart, dend]` to
 * the range `cleanupRecords` actually evaluates, per side.
 */
export function trimEnds(ours: Int32Array, theirs: Int32Array): TrimmedEnds {
  const limit = Math.min(ours.length, theirs.length);
  let dstart = 0;
  while (dstart < limit && ours[dstart] === theirs[dstart]) dstart++;

  const trailingLimit = limit - dstart;
  let trailing = 0;
  while (
    trailing < trailingLimit &&
    ours[ours.length - 1 - trailing] === theirs[theirs.length - 1 - trailing]
  ) {
    trailing++;
  }
  return {
    dstart,
    oursDend: ours.length - 1 - trailing,
    theirsDend: theirs.length - 1 - trailing,
  };
}

/**
 * git's `xdl_clean_mmatch`: `action[i]` is already known `INVESTIGATE` (a
 * multi-match line). Widens it to a real discard only when a run of
 * no-match/multi-match lines surrounds it on BOTH sides — never at the very
 * start or end of the file — and the surrounding run is mostly no-match
 * rather than mostly multi-match.
 */
export function cleanMmatch(action: Uint8Array, i: number, len: number): boolean {
  const s = Math.max(0, i - XDL_SIMSCAN_WINDOW);
  const e = Math.min(len - 1, i + XDL_SIMSCAN_WINDOW);

  let discardBefore = 0;
  let investigateBefore = 1;
  let r = 1;
  for (; i - r >= s; r++) {
    const mark = action[i - r]!;
    if (mark === ACTION.DISCARD) discardBefore++;
    else if (mark === ACTION.INVESTIGATE) investigateBefore++;
    else break; // KEEP: the run stops here, exactly as git's action[i-r]==KEEP break.
  }
  if (discardBefore === 0) return false;

  let discardAfter = 0;
  let investigateAfter = 1;
  for (r = 1; i + r <= e; r++) {
    const mark = action[i + r]!;
    if (mark === ACTION.DISCARD) discardAfter++;
    else if (mark === ACTION.INVESTIGATE) investigateAfter++;
    else break;
  }
  if (discardAfter === 0) return false;

  const totalDiscard = discardBefore + discardAfter;
  const totalInvestigate = investigateBefore + investigateAfter;
  return totalInvestigate * XDL_KPDIS_RUN < totalInvestigate + totalDiscard;
}

function countOccurrences(ids: Int32Array, classCount: number): Int32Array {
  const counts = new Int32Array(classCount);
  for (let i = 0; i < ids.length; i++) {
    const classId = ids[i]!;
    counts[classId] = counts[classId]! + 1;
  }
  return counts;
}

function classifyAction(matchCount: number, mlim: number): Action {
  if (matchCount === 0) return ACTION.DISCARD;
  return matchCount < mlim ? ACTION.KEEP : ACTION.INVESTIGATE;
}

/** git's `mlim1`/`mlim2` (xprepare.c:291-299, :311-318): `need_min` widens it
 *  to infinity — every finite match count then clears `nm < mlim`, so
 *  `INVESTIGATE` (and hence multi-match discarding) never fires. */
function matchLimit(recordCount: number, mode: SearchMode): number {
  if (mode === 'minimal') return Number.POSITIVE_INFINITY;
  return Math.min(bogosqrt(recordCount), XDL_MAX_EQLIMIT);
}

/** One side of `xdl_cleanup_records`'s two (near-identical) passes: builds
 *  the `action` array over `[dstart, dend]`, resolves every `INVESTIGATE`
 *  line through `cleanMmatch`, then splits the range into `changed`
 *  (discarded) and `referenceIndex` (kept, original-index order). */
function cleanupSide(
  ids: Int32Array,
  otherOccurrences: Int32Array,
  dstart: number,
  dend: number,
  mlim: number,
): PreparedSide {
  const changed = new Uint8Array(ids.length);
  const len = dend - dstart + 1;
  const action = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    action[i] = classifyAction(otherOccurrences[ids[i + dstart]!]!, mlim);
  }

  // `len` is the exact upper bound on kept lines, so a single pre-sized
  // Int32Array plus a write cursor replaces a growable number[] (per-push
  // boxing) followed by an Int32Array.from conversion pass — one allocation
  // and one pass instead of two of each. `subarray` is a view, not a copy.
  const referenceIndex = new Int32Array(len);
  let keptCount = 0;
  for (let i = 0; i < len; i++) {
    const resolved =
      action[i] === ACTION.INVESTIGATE
        ? cleanMmatch(action, i, len)
          ? ACTION.DISCARD
          : ACTION.KEEP
        : action[i]!;
    if (resolved === ACTION.KEEP) referenceIndex[keptCount++] = i + dstart;
    else changed[i + dstart] = 1;
  }
  return { changed, referenceIndex: referenceIndex.subarray(0, keptCount) };
}

/**
 * git's `xdl_cleanup_records`: for each side, discards every line with no
 * match on the other side outright, and — once a line's class occurs at
 * least `mlim` times — discards it too when `cleanMmatch` finds it amid a
 * longer no-match run. Everything else is kept and recorded in
 * `referenceIndex`, in original-index order.
 */
export function cleanupRecords(
  classes: LineClasses,
  trimmed: TrimmedEnds,
  mode: SearchMode,
): Prepared {
  const { ours, theirs, classCount } = classes;
  const oursOccurrences = countOccurrences(ours, classCount);
  const theirsOccurrences = countOccurrences(theirs, classCount);

  return {
    ours: cleanupSide(
      ours,
      theirsOccurrences,
      trimmed.dstart,
      trimmed.oursDend,
      matchLimit(ours.length, mode),
    ),
    theirs: cleanupSide(
      theirs,
      oursOccurrences,
      trimmed.dstart,
      trimmed.theirsDend,
      matchLimit(theirs.length, mode),
    ),
  };
}
