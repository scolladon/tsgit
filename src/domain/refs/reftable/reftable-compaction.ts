/**
 * The reftable auto-compaction policy: a pure function over a stack's
 * per-table size metric, replaying git's `stack_table_sizes_for_compaction`
 * geometric-merge decision (factor 2 by default, `reftable.geometricFactor`).
 * No I/O, no `Context` — the writer and compaction protocol that act on this
 * decision arrive in a later part; this module only decides *which* tables
 * would merge.
 */
import {
  FOOTER_LENGTH_V1,
  FOOTER_LENGTH_V2,
  HEADER_LENGTH_V1,
  HEADER_LENGTH_V2,
} from './reftable-format.js';

/** git's own default `reftable.geometricFactor`. */
export const DEFAULT_GEOMETRIC_FACTOR = 2;

/** Version -> the fixed per-file framing overhead the size metric subtracts:
 *  the footer plus the header minus the one byte the footer's own
 *  header-repeat prefix already counts — 91 at v1, 99 at v2. Built from the
 *  named header/footer lengths, never a bare literal. */
const COMPACTION_OVERHEAD: ReadonlyMap<1 | 2, number> = new Map([
  [1, FOOTER_LENGTH_V1 + (HEADER_LENGTH_V1 - 1)],
  [2, FOOTER_LENGTH_V2 + (HEADER_LENGTH_V2 - 1)],
]);

/** A table's compaction-decision weight: its on-disk byte size minus its
 *  fixed per-file framing overhead — never the file size itself. */
export function compactionMetric(fileSize: number, version: 1 | 2): number {
  return fileSize - COMPACTION_OVERHEAD.get(version)!;
}

/** `end` is exclusive — `[start, end)` is empty (no compaction) when
 *  `start === 0 && end === 0`, the only shape an empty segment can take,
 *  since `end` is never 0 for a non-empty range. */
export interface CompactionSegment {
  readonly start: number;
  readonly end: number;
}

const EMPTY_SEGMENT: CompactionSegment = { start: 0, end: 0 };

interface MergeBoundary {
  readonly index: number;
  readonly bytes: number;
}

/** Walks back from the newest table for the first predecessor smaller than
 *  `factor` times its successor — that pair ends the merge segment
 *  (exclusive). `undefined` when no such pair exists anywhere in the stack:
 *  the "found nothing" zero case, distinct from the full-stack zero case
 *  {@link findMergeStart} can produce. */
function findMergeBoundary(sizes: readonly number[], factor: number): MergeBoundary | undefined {
  for (let i = sizes.length - 1; i >= 1; i -= 1) {
    if (sizes[i - 1]! < sizes[i]! * factor) {
      return { index: i, bytes: sizes[i]! };
    }
  }
  return undefined;
}

/** Resumes from the SAME index {@link findMergeBoundary} broke at — not one
 *  below it — accumulating backward to find the oldest predecessor that
 *  still qualifies against the running total. `start` staying 0 here means
 *  the accumulation reached all the way back to the oldest table: the only
 *  path by which a full merge ever happens, distinct from the "found
 *  nothing" zero case above. */
function findMergeStart(
  sizes: readonly number[],
  factor: number,
  boundaryIndex: number,
  boundaryBytes: number,
): number {
  let start = 0;
  let bytes = boundaryBytes;
  for (let i = boundaryIndex; i > 0; i -= 1) {
    const curr = bytes;
    bytes += sizes[i - 1]!;
    if (sizes[i - 1]! < curr * factor) {
      start = i - 1;
    }
  }
  return start;
}

/**
 * git's geometric compaction rule, replayed verbatim from
 * `stack_table_sizes_for_compaction`. `sizes` is the metric vector, oldest
 * to newest. A stack of zero or one table never compacts.
 */
export function suggestCompactionSegment(
  sizes: readonly number[],
  factor: number,
): CompactionSegment {
  if (sizes.length <= 1) {
    return EMPTY_SEGMENT;
  }

  const boundary = findMergeBoundary(sizes, factor);
  if (boundary === undefined) {
    return EMPTY_SEGMENT;
  }

  const start = findMergeStart(sizes, factor, boundary.index, boundary.bytes);
  return { start, end: boundary.index + 1 };
}
