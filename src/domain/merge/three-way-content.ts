import {
  diffPresplitLinesForMode,
  isBinary,
  type LineDiff,
  type LineDiffOptions,
  splitLines,
} from '../diff/line-diff.js';
import { type LineKey, lineKeyIsActive, linesEqualUnder } from '../diff/whitespace.js';
import type { SearchMode } from '../diff/xdiff/xdl-prepare.js';
import { bytesEqual, concatBytes } from '../objects/encoding.js';
import { writeConflictMarkers } from './conflict-markers.js';
import type { ConflictMarkerOptions, ContentMergeResult, MergeFavor } from './merge-types.js';
import {
  buildMergeSegments,
  changesFromHunks,
  type LineModel,
  type MergeSegment,
} from './region-merge.js';

const LF = 0x0a;

export type MergeContentOptions = ConflictMarkerOptions & {
  readonly favor?: MergeFavor;
  /** The whitespace the line diffs ignore (git's `-X ignore-*`); absent compares bytes. */
  readonly lineKey?: LineKey | undefined;
  /** xdiff's search: `minimal` (`-X diff-algorithm=minimal`) never cuts a costly diff short. */
  readonly diffSearch?: SearchMode | undefined;
};

function endsWithLf(line: Uint8Array): boolean {
  // Stryker disable next-line EqualityOperator: equivalent — length >= 0 always holds; at length 0 line[-1] is undefined !== LF, so both forms short-circuit to false
  return line.length > 0 && line[line.length - 1] === LF;
}

/** Concatenate lines, ensuring every line but the last ends in `\n` (interior newline safety). */
function joinLinesEnsuringInteriorLf(lines: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    total += lines[i]!.length;
    if (i < lines.length - 1 && !endsWithLf(lines[i]!)) total += 1;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    out.set(line, offset);
    offset += line.length;
    // Stryker disable next-line EqualityOperator,ArithmeticOperator: equivalent — the index test is vacuously true for every i, so both mutants differ only on the last line, whose extra LF write lands at out[total] (index === buffer length, out of bounds → silent no-op), yielding byte-identical output
    if (i < lines.length - 1 && !endsWithLf(line)) {
      out[offset] = LF;
      offset += 1;
    }
  }
  return out;
}

type ResolvingFavor = Exclude<MergeFavor, 'none'>;

function resolvedLines(
  segment: Exclude<MergeSegment, { kind: 'clean' }>,
  favor: ResolvingFavor,
): ReadonlyArray<Uint8Array> {
  if (favor === 'ours') return segment.ours;
  if (favor === 'theirs') return segment.theirs;
  return [...segment.ours, ...segment.theirs];
}

/** xdiff's favoured fill: every overlapping region becomes the favoured side(s), so the merge is clean. */
function renderFavoured(
  segments: ReadonlyArray<MergeSegment>,
  favor: ResolvingFavor,
): ContentMergeResult {
  const lines: Uint8Array[] = [];
  for (const segment of segments) {
    lines.push(...(segment.kind === 'clean' ? segment.lines : resolvedLines(segment, favor)));
  }
  return { status: 'clean', bytes: joinLinesEnsuringInteriorLf(lines) };
}

function renderWithMarkers(
  segments: ReadonlyArray<MergeSegment>,
  options: ConflictMarkerOptions,
): ContentMergeResult {
  const parts: Uint8Array[] = [];
  let conflicted = false;
  for (const segment of segments) {
    if (segment.kind === 'clean') {
      parts.push(...segment.lines);
    } else {
      conflicted = true;
      parts.push(writeConflictMarkers(segment.ours, segment.theirs, options));
    }
  }
  const bytes = concatBytes(parts);
  return conflicted
    ? { status: 'conflict', conflictType: 'content', markedBytes: bytes }
    : { status: 'clean', bytes };
}

const activeKey = (key: LineKey | undefined): LineKey | undefined =>
  key !== undefined && lineKeyIsActive(key) ? key : undefined;

function lineModel(
  lineKey: LineKey | undefined,
  search: SearchMode,
  options: LineDiffOptions | undefined,
): LineModel {
  return {
    linesEqual: lineKey === undefined ? bytesEqual : (a, b) => linesEqualUnder(a, b, lineKey),
    diffSides: (ours, theirs) => diffPresplitLinesForMode(ours, theirs, search, options).hunks,
  };
}

const diffAgainstBase = (
  baseLines: ReadonlyArray<Uint8Array>,
  side: Uint8Array,
  search: SearchMode,
  options: LineDiffOptions | undefined,
): LineDiff => diffPresplitLinesForMode(baseLines, splitLines(side), search, options);

function mergeFromDiffs(
  base: Uint8Array,
  ours: Uint8Array,
  theirs: Uint8Array,
  options: MergeContentOptions,
): ContentMergeResult {
  const lineKey = activeKey(options.lineKey);
  const diffOptions = lineKey === undefined ? undefined : { lineKey };
  const search = options.diffSearch ?? 'git-default';
  const baseLines = splitLines(base);
  const oursDiff = diffAgainstBase(baseLines, ours, search, diffOptions);
  const theirsDiff = diffAgainstBase(baseLines, theirs, search, diffOptions);
  const segments = buildMergeSegments(
    baseLines.length,
    { lines: oursDiff.theirsLines, changes: changesFromHunks(oursDiff.hunks) },
    { lines: theirsDiff.theirsLines, changes: changesFromHunks(theirsDiff.hunks) },
    lineModel(lineKey, search, diffOptions),
  );
  const favor = options.favor ?? 'none';
  return favor === 'none' ? renderWithMarkers(segments, options) : renderFavoured(segments, favor);
}

/** git's `ll_binary_merge`: ours with a conflict, unless `-X ours` / `-X theirs` settles it. */
export function mergeBinary(
  ours: Uint8Array,
  theirs: Uint8Array,
  favor?: MergeFavor,
): ContentMergeResult {
  if (favor === 'ours') return { status: 'clean', bytes: ours };
  if (favor === 'theirs') return { status: 'clean', bytes: theirs };
  return { status: 'conflict', conflictType: 'binary', markedBytes: ours };
}

/**
 * Three-way line merge. Produces git-faithful per-region output: clean runs are
 * applied directly, and each overlapping region is rendered by `favor` —
 * `none` (default) wraps it in conflict markers, `union` concatenates both
 * sides with no markers (always clean), `ours` / `theirs` keep that side.
 * Binary content falls back to a single whole-file region.
 */
export function mergeContent(
  base: Uint8Array | undefined,
  ours: Uint8Array,
  theirs: Uint8Array,
  options: MergeContentOptions = {},
): ContentMergeResult {
  if (isBinary(ours) || isBinary(theirs) || (base !== undefined && isBinary(base))) {
    return mergeBinary(ours, theirs, options.favor);
  }

  if (base === undefined) {
    if (bytesEqual(ours, theirs)) return { status: 'clean', bytes: ours };
    return mergeFromDiffs(new Uint8Array(0), ours, theirs, options);
  }

  if (bytesEqual(ours, base)) return { status: 'clean', bytes: theirs };
  if (bytesEqual(theirs, base)) return { status: 'clean', bytes: ours };
  if (bytesEqual(ours, theirs)) return { status: 'clean', bytes: ours };

  return mergeFromDiffs(base, ours, theirs, options);
}
