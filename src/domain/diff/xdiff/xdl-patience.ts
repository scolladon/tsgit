// Transcribes git's xdiff/xpatience.c (git 2.55.0): `fill_hashmap`,
// `find_longest_common_sequence`, `walk_common_sequence` and `patience_diff`.
// Lines are 1-based, as in the C. Merges never pass `--anchored`, so the
// anchor branch is absent. Each gap between anchors is diffed independently,
// so an explicit stack replaces the C recursion without changing the result.
import type { LineClasses } from './xdl-classify.js';
import {
  type ClassicFallback,
  type LineRegion,
  markRegion,
  type RegionSink,
} from './xdl-region.js';

/** xpatience.c's `NON_UNIQUE`: the line repeats on at least one side. */
const NON_UNIQUE = -1;
const UNSEEN = 0;

interface PatienceEntry {
  readonly line1: number;
  line2: number;
  previous: PatienceEntry | undefined;
  next: PatienceEntry | undefined;
}

interface UniqueLines {
  /** One entry per distinct line of side 1, in first-occurrence order. */
  readonly entries: ReadonlyArray<PatienceEntry>;
  readonly hasMatches: boolean;
}

function indexFirstSide(classes: LineClasses, region: LineRegion): Map<number, PatienceEntry> {
  const byClass = new Map<number, PatienceEntry>();
  for (let line = region.line1; line < region.line1 + region.count1; line++) {
    const cls = classes.ours[line - 1]!;
    const seen = byClass.get(cls);
    if (seen !== undefined) seen.line2 = NON_UNIQUE;
    else byClass.set(cls, { line1: line, line2: UNSEEN, previous: undefined, next: undefined });
  }
  return byClass;
}

/** xpatience.c's `fill_hashmap`: which lines occur exactly once on each side. */
function fillHashmap(classes: LineClasses, region: LineRegion): UniqueLines {
  const byClass = indexFirstSide(classes, region);
  let hasMatches = false;
  for (let line = region.line2; line < region.line2 + region.count2; line++) {
    const entry = byClass.get(classes.theirs[line - 1]!);
    if (entry === undefined) continue;
    hasMatches = true;
    entry.line2 = entry.line2 === UNSEEN ? line : NON_UNIQUE;
  }
  return { entries: [...byClass.values()], hasMatches };
}

/** The last index whose `line2` is below the entry's — xpatience.c's `binary_search`. */
function binarySearch(sequence: ReadonlyArray<PatienceEntry>, line2: number): number {
  let left = -1;
  let right = sequence.length;
  while (left + 1 < right) {
    const middle = left + Math.floor((right - left) / 2);
    if (sequence[middle]!.line2 > line2) right = middle;
    else left = middle;
  }
  return left;
}

function isUnique(entry: PatienceEntry): boolean {
  return entry.line2 !== UNSEEN && entry.line2 !== NON_UNIQUE;
}

/** Chains the sequence's tail back to its head through `next`; returns the head. */
function chainFromTail(tail: PatienceEntry): PatienceEntry {
  let entry = tail;
  entry.next = undefined;
  for (let previous = entry.previous; previous !== undefined; previous = entry.previous) {
    previous.next = entry;
    entry = previous;
  }
  return entry;
}

/** xpatience.c's `find_longest_common_sequence`: patience sorting over the unique lines. */
function findLongestCommonSequence(
  entries: ReadonlyArray<PatienceEntry>,
): PatienceEntry | undefined {
  const sequence: PatienceEntry[] = [];
  for (const entry of entries) {
    if (!isUnique(entry)) continue;
    const longest = sequence.length;
    const last = sequence[longest - 1];
    const i =
      last === undefined || entry.line2 > last.line2
        ? longest - 1
        : binarySearch(sequence, entry.line2);
    entry.previous = i < 0 ? undefined : sequence[i];
    sequence[i + 1] = entry;
  }
  const tail = sequence[sequence.length - 1];
  return tail === undefined ? undefined : chainFromTail(tail);
}

/** The last anchor of the run of consecutive anchors starting at `entry`. */
function endOfAnchorRun(entry: PatienceEntry): PatienceEntry {
  let last = entry;
  for (let next = last.next; next !== undefined; next = last.next) {
    if (next.line1 !== last.line1 + 1 || next.line2 !== last.line2 + 1) break;
    last = next;
  }
  return last;
}

/** Where the gap before `entry` ends, after pulling matching lines off its back. */
function gapEnd(
  classes: LineClasses,
  entry: PatienceEntry | undefined,
  start: { readonly line1: number; readonly line2: number },
  region: LineRegion,
): { line1: number; line2: number } {
  if (entry === undefined) {
    return { line1: region.line1 + region.count1, line2: region.line2 + region.count2 };
  }
  let { line1, line2 } = entry;
  while (
    line1 > start.line1 &&
    line2 > start.line2 &&
    classes.ours[line1 - 2] === classes.theirs[line2 - 2]
  ) {
    line1--;
    line2--;
  }
  return { line1, line2 };
}

/** A line on each side, 1-based. */
interface LinePair {
  readonly line1: number;
  readonly line2: number;
}

/** xpatience.c's `walk_common_sequence`: queues every gap between the anchors. */
function walkCommonSequence(
  classes: LineClasses,
  first: PatienceEntry,
  region: LineRegion,
  pending: LineRegion[],
): void {
  let from: LinePair = { line1: region.line1, line2: region.line2 };
  for (let entry: PatienceEntry | undefined = first; ; ) {
    const next = gapEnd(classes, entry, from, region);
    const { line1, line2 } = skipEqualLines(classes, from, next);
    if (next.line1 > line1 || next.line2 > line2) {
      pending.push({ line1, count1: next.line1 - line1, line2, count2: next.line2 - line2 });
    }
    if (entry === undefined) return;
    const runEnd = endOfAnchorRun(entry);
    from = { line1: runEnd.line1 + 1, line2: runEnd.line2 + 1 };
    entry = runEnd.next;
  }
}

/** Advance both sides past the lines they share before the gap ends at `next`. */
function skipEqualLines(classes: LineClasses, from: LinePair, next: LinePair): LinePair {
  let { line1, line2 } = from;
  while (
    line1 < next.line1 &&
    line2 < next.line2 &&
    classes.ours[line1 - 1] === classes.theirs[line2 - 1]
  ) {
    line1++;
    line2++;
  }
  return { line1, line2 };
}

/** One `patience_diff` call: marks what it settles, queues the gaps left to diff. */
function patienceStep(
  classes: LineClasses,
  region: LineRegion,
  sink: RegionSink,
  pending: LineRegion[],
): void {
  if (region.count1 === 0 || region.count2 === 0) {
    markRegion(sink, region);
    return;
  }
  const { entries, hasMatches } = fillHashmap(classes, region);
  if (!hasMatches) {
    markRegion(sink, region);
    return;
  }
  const first = findLongestCommonSequence(entries);
  if (first === undefined) sink.fallback(region);
  else walkCommonSequence(classes, first, region, pending);
}

/**
 * git's `xdl_do_patience_diff` over the whole of both sides (patience skips
 * xprepare's trimming and discarding): anchors on the lines unique to both
 * sides, recursing into the gaps, and hands a region with matches but no
 * unique anchor to `fallback`.
 */
export function markPatienceChanges(
  classes: LineClasses,
  oursChanged: Uint8Array,
  theirsChanged: Uint8Array,
  fallback: ClassicFallback,
): void {
  const sink: RegionSink = { oursChanged, theirsChanged, fallback };
  const pending: LineRegion[] = [
    { line1: 1, count1: classes.ours.length, line2: 1, count2: classes.theirs.length },
  ];
  for (let region = pending.pop(); region !== undefined; region = pending.pop()) {
    patienceStep(classes, region, sink, pending);
  }
}
