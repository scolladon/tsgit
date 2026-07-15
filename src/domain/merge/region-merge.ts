import type { LineHunk } from '../diff/line-diff.js';
import { bytesEqual } from '../objects/encoding.js';

/** A contiguous edit one side made against the base: replace `[baseStart, baseEnd)` with `replacement`. */
export interface ChangeRange {
  readonly baseStart: number;
  readonly baseEnd: number;
  readonly replacement: ReadonlyArray<Uint8Array>;
}

/**
 * One slice of the merged output. A `clean` slice is emitted verbatim; a
 * `conflict` slice holds the two sides' differing content (already edge-trimmed)
 * for the caller to render per favor (markers / union / …).
 */
export type MergeSegment =
  | { readonly kind: 'clean'; readonly lines: ReadonlyArray<Uint8Array> }
  | {
      readonly kind: 'conflict';
      readonly ours: ReadonlyArray<Uint8Array>;
      readonly theirs: ReadonlyArray<Uint8Array>;
    };

/** git coalesces two conflict regions separated by at most this many base lines. */
export const MAX_CONFLICT_COALESCE_GAP = 3;

function lineArraysEqual(a: ReadonlyArray<Uint8Array>, b: ReadonlyArray<Uint8Array>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!bytesEqual(a[i]!, b[i]!)) return false;
  }
  return true;
}

/** Collapse a single side's diff hunks into base-range replacements (one per changed run). */
export function changesFromHunks(
  hunks: ReadonlyArray<LineHunk>,
  sideLines: ReadonlyArray<Uint8Array>,
): ChangeRange[] {
  const changes: ChangeRange[] = [];
  let pending: { baseStart: number; baseEnd: number; replacement: Uint8Array[] } | undefined;

  const flush = (): void => {
    if (pending !== undefined) {
      changes.push({
        baseStart: pending.baseStart,
        baseEnd: pending.baseEnd,
        replacement: pending.replacement,
      });
      pending = undefined;
    }
  };

  for (const hunk of hunks) {
    if (hunk.kind === 'common') {
      flush();
      continue;
    }
    if (pending === undefined) {
      pending = { baseStart: hunk.oursStart, baseEnd: hunk.oursStart, replacement: [] };
    }
    if (hunk.kind === 'ours-only') {
      pending.baseEnd = Math.max(pending.baseEnd, hunk.oursEnd);
    } else {
      for (let j = hunk.theirsStart; j < hunk.theirsEnd; j++) {
        pending.replacement.push(sideLines[j]!);
      }
    }
  }
  flush();
  return changes;
}

/** Does change `a` overlap base range `b` (zero-length inserts overlap at their position)? */
export function rangesOverlap(
  a: { readonly baseStart: number; readonly baseEnd: number },
  b: { readonly baseStart: number; readonly baseEnd: number },
): boolean {
  if (a.baseStart === a.baseEnd) {
    return b.baseStart === b.baseEnd
      ? a.baseStart === b.baseStart
      : a.baseStart >= b.baseStart && a.baseStart < b.baseEnd;
  }
  if (b.baseStart === b.baseEnd) {
    return b.baseStart >= a.baseStart && b.baseStart < a.baseEnd;
  }
  return a.baseStart < b.baseEnd && b.baseStart < a.baseEnd;
}

/** Reconstruct one side's file content over base span `[start, end)`. */
export function applyChangesToSpan(
  baseLines: ReadonlyArray<Uint8Array>,
  start: number,
  end: number,
  changes: ReadonlyArray<ChangeRange>,
): Uint8Array[] {
  const out: Uint8Array[] = [];
  let cursor = start;
  for (const change of changes) {
    for (let i = cursor; i < change.baseStart; i++) out.push(baseLines[i]!);
    for (const line of change.replacement) out.push(line);
    cursor = change.baseEnd;
  }
  for (let i = cursor; i < end; i++) out.push(baseLines[i]!);
  return out;
}

interface TrimmedConflict {
  readonly prefix: ReadonlyArray<Uint8Array>;
  readonly oursMid: ReadonlyArray<Uint8Array>;
  readonly theirsMid: ReadonlyArray<Uint8Array>;
  readonly suffix: ReadonlyArray<Uint8Array>;
}

/** Pull the common leading/trailing lines of a conflict's two sides out as clean runs (git zealous trim). */
export function trimCommonEdges(
  ours: ReadonlyArray<Uint8Array>,
  theirs: ReadonlyArray<Uint8Array>,
): TrimmedConflict {
  const bound = Math.min(ours.length, theirs.length);
  let prefix = 0;
  while (prefix < bound && bytesEqual(ours[prefix]!, theirs[prefix]!)) prefix++;
  let suffix = 0;
  while (
    suffix < bound - prefix &&
    bytesEqual(ours[ours.length - 1 - suffix]!, theirs[theirs.length - 1 - suffix]!)
  ) {
    suffix++;
  }
  return {
    prefix: ours.slice(0, prefix),
    oursMid: ours.slice(prefix, ours.length - suffix),
    theirsMid: theirs.slice(prefix, theirs.length - suffix),
    suffix: ours.slice(ours.length - suffix),
  };
}

type Classification = 'clean-ours' | 'clean-theirs' | 'clean-twin' | 'conflict';

interface RawGroup {
  start: number;
  end: number;
  readonly ours: ChangeRange[];
  readonly theirs: ChangeRange[];
}

interface ClassifiedGroup extends RawGroup {
  readonly classification: Classification;
}

type FinalRegion =
  | {
      readonly kind: 'clean';
      readonly start: number;
      readonly end: number;
      readonly replacement: ReadonlyArray<Uint8Array>;
    }
  | {
      readonly kind: 'conflict';
      readonly start: number;
      readonly end: number;
      readonly ours: ReadonlyArray<ChangeRange>;
      readonly theirs: ReadonlyArray<ChangeRange>;
    };

interface SidedChange extends ChangeRange {
  readonly side: 'ours' | 'theirs';
}

function mergeSorted(
  oursChanges: ReadonlyArray<ChangeRange>,
  theirsChanges: ReadonlyArray<ChangeRange>,
): SidedChange[] {
  const tagged: SidedChange[] = [
    ...oursChanges.map((c) => ({ ...c, side: 'ours' as const })),
    ...theirsChanges.map((c) => ({ ...c, side: 'theirs' as const })),
  ];
  // Sort by base position only: changes sharing a baseStart overlap and land in
  // one group regardless of their relative order, so no further tiebreak is
  // load-bearing (a stable sort keeps ours before theirs, which is immaterial).
  tagged.sort((a, b) => a.baseStart - b.baseStart);
  return tagged;
}

function groupByOverlap(changes: ReadonlyArray<SidedChange>): RawGroup[] {
  const groups: RawGroup[] = [];
  let current: RawGroup | undefined;
  for (const change of changes) {
    if (
      current !== undefined &&
      rangesOverlap(change, { baseStart: current.start, baseEnd: current.end })
    ) {
      current.end = Math.max(current.end, change.baseEnd);
    } else {
      current = { start: change.baseStart, end: change.baseEnd, ours: [], theirs: [] };
      groups.push(current);
    }
    (change.side === 'ours' ? current.ours : current.theirs).push(change);
  }
  return groups;
}

function classify(group: RawGroup): Classification {
  const hasOurs = group.ours.length > 0;
  const hasTheirs = group.theirs.length > 0;
  if (!hasOurs) return 'clean-theirs';
  if (!hasTheirs) return 'clean-ours';
  const [oc] = group.ours;
  const [tc] = group.theirs;
  // Both `length === 1` guards are provably redundant: when the range guards
  // (baseStart/baseEnd equal) hold, the group is necessarily 1-ours-1-theirs,
  // because a second same-side change starts at or after the first change's end
  // and so cannot reach back into the shared span to join the group. Forcing
  // either guard true therefore never flips the verdict; their `=== 1 → false`
  // halves are the killable direction, covered by the identical-change twin test.
  const isTwin =
    // Stryker disable next-line ConditionalExpression: equivalent — see above; forcing this true is subsumed by the range guards, and the `=== 1 → false` half is killed by the twin test.
    group.ours.length === 1 &&
    // Stryker disable next-line ConditionalExpression: equivalent — see above; forcing this true is subsumed by the range guards, and the `=== 1 → false` half is killed by the twin test.
    group.theirs.length === 1 &&
    oc!.baseStart === tc!.baseStart &&
    oc!.baseEnd === tc!.baseEnd &&
    lineArraysEqual(oc!.replacement, tc!.replacement);
  return isTwin ? 'clean-twin' : 'conflict';
}

function cleanRegion(group: ClassifiedGroup): FinalRegion {
  const replacement =
    group.ours.length > 0 ? group.ours[0]!.replacement : group.theirs[0]!.replacement;
  return { kind: 'clean', start: group.start, end: group.end, replacement };
}

/**
 * Coalesce *directly-consecutive* conflict groups separated by at most
 * `MAX_CONFLICT_COALESCE_GAP` common base lines. A clean (single-side or twin)
 * group between two conflicts is a record of its own: it stops coalescing, so
 * the conflicts on either side stay distinct — matching git, which never folds a
 * one-sided change into an adjacent conflict.
 */
function coalesce(groups: ReadonlyArray<ClassifiedGroup>): FinalRegion[] {
  const regions: FinalRegion[] = [];
  let i = 0;
  while (i < groups.length) {
    const group = groups[i]!;
    if (group.classification !== 'conflict') {
      regions.push(cleanRegion(group));
      i++;
      continue;
    }
    let end = group.end;
    const ours = [...group.ours];
    const theirs = [...group.theirs];
    let j = i + 1;
    while (j < groups.length) {
      const next = groups[j]!;
      if (next.classification !== 'conflict' || next.start - end > MAX_CONFLICT_COALESCE_GAP) {
        break;
      }
      ours.push(...next.ours);
      theirs.push(...next.theirs);
      end = next.end;
      j++;
    }
    regions.push({ kind: 'conflict', start: group.start, end, ours, theirs });
    i = j;
  }
  return regions;
}

/**
 * Build the ordered merge segments for a 3-way content merge: clean runs
 * interleaved with conflict regions. Reproduces git's region construction,
 * conflict↔conflict coalescing (`MAX_CONFLICT_COALESCE_GAP`), and zealous
 * prefix/suffix trimming. `baseLines` may be empty (add/add).
 */
export function buildMergeSegments(
  baseLines: ReadonlyArray<Uint8Array>,
  oursChanges: ReadonlyArray<ChangeRange>,
  theirsChanges: ReadonlyArray<ChangeRange>,
): MergeSegment[] {
  const groups = groupByOverlap(mergeSorted(oursChanges, theirsChanges)).map((g) => ({
    ...g,
    classification: classify(g),
  }));
  const regions = coalesce(groups);

  const segments: MergeSegment[] = [];
  const pushClean = (lines: ReadonlyArray<Uint8Array>): void => {
    if (lines.length > 0) segments.push({ kind: 'clean', lines });
  };
  let cursor = 0;
  for (const region of regions) {
    pushClean(baseLines.slice(cursor, region.start));
    if (region.kind === 'clean') {
      pushClean(region.replacement);
    } else {
      const ours = applyChangesToSpan(baseLines, region.start, region.end, region.ours);
      const theirs = applyChangesToSpan(baseLines, region.start, region.end, region.theirs);
      const trimmed = trimCommonEdges(ours, theirs);
      pushClean(trimmed.prefix);
      segments.push({ kind: 'conflict', ours: trimmed.oursMid, theirs: trimmed.theirsMid });
      pushClean(trimmed.suffix);
    }
    cursor = region.end;
  }
  pushClean(baseLines.slice(cursor));
  return segments;
}
