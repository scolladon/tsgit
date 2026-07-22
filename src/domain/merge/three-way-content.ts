import { diffLines, isBinary, splitLines } from '../diff/line-diff.js';
import { bytesEqual } from '../objects/encoding.js';
import { writeConflictMarkers } from './conflict-markers.js';
import type { ConflictMarkerOptions, ContentMergeResult, MergeFavor } from './merge-types.js';
import { buildMergeSegments, changesFromHunks, type MergeSegment } from './region-merge.js';

const LF = 0x0a;

export type MergeContentOptions = ConflictMarkerOptions & { readonly favor?: MergeFavor };

function concatBytes(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

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

function renderUnion(segments: ReadonlyArray<MergeSegment>): ContentMergeResult {
  const lines: Uint8Array[] = [];
  for (const segment of segments) {
    if (segment.kind === 'clean') {
      lines.push(...segment.lines);
    } else {
      lines.push(...segment.ours, ...segment.theirs);
    }
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

function mergeFromDiffs(
  base: Uint8Array,
  ours: Uint8Array,
  theirs: Uint8Array,
  options: MergeContentOptions,
): ContentMergeResult {
  const oursDiff = diffLines(base, ours);
  const theirsDiff = diffLines(base, theirs);
  const segments: ReadonlyArray<MergeSegment> =
    oursDiff.degraded || theirsDiff.degraded
      ? [{ kind: 'conflict', ours: splitLines(ours), theirs: splitLines(theirs) }]
      : buildMergeSegments(
          oursDiff.oursLines,
          changesFromHunks(oursDiff.hunks, oursDiff.theirsLines),
          changesFromHunks(theirsDiff.hunks, theirsDiff.theirsLines),
        );
  return options.favor === 'union' ? renderUnion(segments) : renderWithMarkers(segments, options);
}

/**
 * Three-way line merge. Produces git-faithful per-region output: clean runs are
 * applied directly, and each overlapping region is rendered by `favor` —
 * `none` (default) wraps it in conflict markers, `union` concatenates both
 * sides with no markers (always clean). Binary content and a degraded diff fall
 * back to a single whole-file region.
 */
export function mergeContent(
  base: Uint8Array | undefined,
  ours: Uint8Array,
  theirs: Uint8Array,
  options: MergeContentOptions = {},
): ContentMergeResult {
  if (isBinary(ours) || isBinary(theirs) || (base !== undefined && isBinary(base))) {
    return { status: 'conflict', conflictType: 'binary', markedBytes: ours };
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
