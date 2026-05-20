import type { LineHunk } from '../diff/line-diff.js';
import { diffLines, isBinary, splitLines } from '../diff/line-diff.js';
import { writeConflictMarkers } from './conflict-markers.js';
import type { ConflictMarkerOptions, ContentMergeResult } from './merge-types.js';

interface ChangeRange {
  readonly baseStart: number;
  readonly baseEnd: number;
  readonly replacement: ReadonlyArray<Uint8Array>;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  // Stryker disable next-line EqualityOperator: equivalent — lengths are equal here, so at i===a.length both a[i] and b[i] are undefined and undefined !== undefined is false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function lineArraysEqual(a: ReadonlyArray<Uint8Array>, b: ReadonlyArray<Uint8Array>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!bytesEqual(a[i]!, b[i]!)) return false;
  }
  return true;
}

function concatLines(lines: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 0;
  for (const l of lines) total += l.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const l of lines) {
    out.set(l, offset);
    offset += l.length;
  }
  return out;
}

function changesFromHunks(
  hunks: ReadonlyArray<LineHunk>,
  sideLines: ReadonlyArray<Uint8Array>,
): ChangeRange[] {
  const changes: ChangeRange[] = [];
  let pending: { baseStart: number; baseEnd: number; replacement: Uint8Array[] } | undefined;

  const flush = () => {
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

function rangesOverlap(a: ChangeRange, b: ChangeRange): boolean {
  // Zero-length insertion inside or at the boundary of another range overlaps.
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

interface MergedPlan {
  readonly changes: ReadonlyArray<ChangeRange>;
}

// Changes on a single side come from runs separated by common hunks, so they
// have strictly ordered, non-overlapping (and distinct) [baseStart, baseEnd)
// ranges. A twin therefore shares its exact range with exactly one opposite-side
// change, which means an already-consumed candidate can neither twin nor overlap
// any other target — no consumed-set filtering is needed here.
function findIdenticalTwin(
  target: ChangeRange,
  candidates: ReadonlyArray<ChangeRange>,
): ChangeRange | undefined {
  for (const candidate of candidates) {
    if (
      candidate.baseStart === target.baseStart &&
      candidate.baseEnd === target.baseEnd &&
      lineArraysEqual(candidate.replacement, target.replacement)
    ) {
      return candidate;
    }
  }
  return undefined;
}

function collidesWithAny(target: ChangeRange, candidates: ReadonlyArray<ChangeRange>): boolean {
  for (const candidate of candidates) {
    if (rangesOverlap(target, candidate)) return true;
  }
  return false;
}

function mergePlans(
  oursChanges: ReadonlyArray<ChangeRange>,
  theirsChanges: ReadonlyArray<ChangeRange>,
): MergedPlan | undefined {
  const out: ChangeRange[] = [];
  const consumedTheirs = new Set<ChangeRange>();

  for (const oc of oursChanges) {
    const twin = findIdenticalTwin(oc, theirsChanges);
    if (twin !== undefined) {
      consumedTheirs.add(twin);
      out.push(oc);
      continue;
    }
    if (collidesWithAny(oc, theirsChanges)) return undefined;
    out.push(oc);
  }
  for (const tc of theirsChanges) {
    if (!consumedTheirs.has(tc)) out.push(tc);
  }
  out.sort((a, b) => a.baseStart - b.baseStart);
  return { changes: out };
}

function applyPlan(baseLines: ReadonlyArray<Uint8Array>, plan: MergedPlan): Uint8Array[] {
  const result: Uint8Array[] = [];
  let cursor = 0;
  for (const change of plan.changes) {
    for (let i = cursor; i < change.baseStart; i++) result.push(baseLines[i]!);
    for (const line of change.replacement) result.push(line);
    cursor = change.baseEnd;
  }
  for (let i = cursor; i < baseLines.length; i++) result.push(baseLines[i]!);
  return result;
}

function wholeFileConflict(
  oursLines: ReadonlyArray<Uint8Array>,
  theirsLines: ReadonlyArray<Uint8Array>,
  options: ConflictMarkerOptions,
): ContentMergeResult {
  const markedBytes = writeConflictMarkers(oursLines, theirsLines, options);
  return { status: 'conflict', conflictType: 'content', markedBytes };
}

export function mergeContent(
  base: Uint8Array | undefined,
  ours: Uint8Array,
  theirs: Uint8Array,
  options: ConflictMarkerOptions = {},
): ContentMergeResult {
  if (isBinary(ours) || isBinary(theirs) || (base !== undefined && isBinary(base))) {
    return { status: 'conflict', conflictType: 'binary', markedBytes: ours };
  }

  if (base === undefined) {
    if (bytesEqual(ours, theirs)) return { status: 'clean', bytes: ours };
    return wholeFileConflict(splitLines(ours), splitLines(theirs), options);
  }

  if (bytesEqual(ours, base)) return { status: 'clean', bytes: theirs };
  if (bytesEqual(theirs, base)) return { status: 'clean', bytes: ours };
  if (bytesEqual(ours, theirs)) return { status: 'clean', bytes: ours };

  const oursDiff = diffLines(base, ours);
  const theirsDiff = diffLines(base, theirs);
  if (oursDiff.degraded || theirsDiff.degraded) {
    return wholeFileConflict(splitLines(ours), splitLines(theirs), options);
  }

  const oursChanges = changesFromHunks(oursDiff.hunks, oursDiff.theirsLines);
  const theirsChanges = changesFromHunks(theirsDiff.hunks, theirsDiff.theirsLines);
  const plan = mergePlans(oursChanges, theirsChanges);
  if (plan === undefined) {
    // Conservative whole-file fallback: per-region conflict markers require a lockstep walk
    // over two independent edit scripts against the same base, correlating overlapping regions
    // while faithfully emitting clean segments from the correct side. Implementing this safely
    // needs extensive property tests and interop validation against C git. The whole-file
    // fallback is correct (never silently drops data) and matches git's behavior for complex
    // overlapping edits. Per-region output is deferred to a future iteration.
    return wholeFileConflict(splitLines(ours), splitLines(theirs), options);
  }

  const mergedLines = applyPlan(oursDiff.oursLines, plan);
  return { status: 'clean', bytes: concatLines(mergedLines) };
}
