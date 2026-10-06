import { diffPresplitLinesForMode, type LineHunk } from '../diff/line-diff.js';
import { bytesEqual } from '../objects/encoding.js';

/** One xdiff change: base lines `[i1, i1 + chg1)` became side lines `[i2, i2 + chg2)`. */
export interface LineChange {
  readonly i1: number;
  readonly chg1: number;
  readonly i2: number;
  readonly chg2: number;
}

/** A side of a 3-way merge: its own lines and the changes its diff against the base made. */
export interface SideEdit {
  readonly lines: ReadonlyArray<Uint8Array>;
  readonly changes: ReadonlyArray<LineChange>;
}

/**
 * One slice of the merged output. A `clean` slice is emitted verbatim; a
 * `conflict` slice holds the two sides' differing content for the caller to
 * render per favor (markers / union / …).
 */
export type MergeSegment =
  | { readonly kind: 'clean'; readonly lines: ReadonlyArray<Uint8Array> }
  | {
      readonly kind: 'conflict';
      readonly ours: ReadonlyArray<Uint8Array>;
      readonly theirs: ReadonlyArray<Uint8Array>;
    };

type LinesEqual = (a: Uint8Array, b: Uint8Array) => boolean;

/** Diff a conflict's two sides with the merge's own line diff (algorithm and whitespace). */
export type SideDiff = (
  ours: ReadonlyArray<Uint8Array>,
  theirs: ReadonlyArray<Uint8Array>,
) => ReadonlyArray<LineHunk>;

/** How the merge compares lines: the twin check's equality and the refinement's diff. */
export interface LineModel {
  readonly linesEqual: LinesEqual;
  readonly diffSides: SideDiff;
}

const BYTE_EXACT: LineModel = {
  linesEqual: bytesEqual,
  diffSides: (ours, theirs) => diffPresplitLinesForMode(ours, theirs, 'myers').hunks,
};

/** git coalesces two conflicts separated by at most this many unchanged lines. */
export const MAX_CONFLICT_COALESCE_GAP = 3;

/** Collapse a diff's hunks into xdiff changes: one per run between common hunks. */
export function changesFromHunks(hunks: ReadonlyArray<LineHunk>): LineChange[] {
  const changes: LineChange[] = [];
  let open: LineChange | undefined;
  for (const hunk of hunks) {
    if (hunk.kind === 'common') {
      if (open !== undefined) changes.push(open);
      open = undefined;
      continue;
    }
    const i1 = open?.i1 ?? hunk.oursStart;
    const i2 = open?.i2 ?? hunk.theirsStart;
    open = { i1, chg1: hunk.oursEnd - i1, i2, chg2: hunk.theirsEnd - i2 };
  }
  if (open !== undefined) changes.push(open);
  return changes;
}

const CONFLICT = 0;
const TAKE_OURS = 1;
const TAKE_THEIRS = 2;
/** A conflict whose two sides refinement found identical: it emits nothing of its own. */
const IDENTICAL = 4;

/** xdiff's merge record, minus the base span only the unsupported diff3 style reads. */
interface MergeRecord {
  readonly mode: number;
  readonly i1: number;
  readonly chg1: number;
  readonly i2: number;
  readonly chg2: number;
}

interface SidePair {
  readonly ours: SideEdit;
  readonly theirs: SideEdit;
}

/** xdiff's `xdl_append_merge`: a record touching the last one in either side's lines joins it. */
function appendRecord(records: MergeRecord[], next: MergeRecord): void {
  const last = records[records.length - 1];
  if (last === undefined || (next.i1 > last.i1 + last.chg1 && next.i2 > last.i2 + last.chg2)) {
    records.push(next);
    return;
  }
  records[records.length - 1] = {
    mode: next.mode === last.mode ? last.mode : CONFLICT,
    i1: last.i1,
    chg1: next.i1 + next.chg1 - last.i1,
    i2: last.i2,
    chg2: next.i2 + next.chg2 - last.i2,
  };
}

/** An ours-only change, placed in theirs' lines by the offset theirs had reached. */
function oursRecord(change: LineChange, theirsOffset: number): MergeRecord {
  return {
    mode: TAKE_OURS,
    i1: change.i2,
    chg1: change.chg2,
    i2: change.i1 + theirsOffset,
    chg2: change.chg1,
  };
}

function theirsRecord(change: LineChange, oursOffset: number): MergeRecord {
  return {
    mode: TAKE_THEIRS,
    i1: change.i1 + oursOffset,
    chg1: change.chg1,
    i2: change.i2,
    chg2: change.chg2,
  };
}

/** The conflict two overlapping changes form, widened to the union of their base spans. */
function conflictRecord(ours: LineChange, theirs: LineChange): MergeRecord {
  const off = ours.i1 - theirs.i1;
  const ffo = off + ours.chg1 - theirs.chg1;
  const i1 = off > 0 ? ours.i2 - off : ours.i2;
  const i2 = off > 0 ? theirs.i2 : theirs.i2 + off;
  const chg1 = ours.i2 + ours.chg2 - i1;
  const chg2 = theirs.i2 + theirs.chg2 - i2;
  return {
    mode: CONFLICT,
    i1,
    chg1: ffo < 0 ? chg1 - ffo : chg1,
    i2,
    chg2: ffo < 0 ? chg2 : chg2 + ffo,
  };
}

function isTwin(ours: LineChange, theirs: LineChange, sides: SidePair, model: LineModel): boolean {
  if (ours.i1 !== theirs.i1 || ours.chg1 !== theirs.chg1 || ours.chg2 !== theirs.chg2) return false;
  for (let k = 0; k < ours.chg2; k++) {
    if (!model.linesEqual(sides.ours.lines[ours.i2 + k]!, sides.theirs.lines[theirs.i2 + k]!)) {
      return false;
    }
  }
  return true;
}

const endOf = (change: LineChange): number => change.i1 + change.chg1;

interface Advance {
  readonly ours: boolean;
  readonly theirs: boolean;
}

const ADVANCE_OURS: Advance = { ours: true, theirs: false };
const ADVANCE_THEIRS: Advance = { ours: false, theirs: true };

/**
 * One step of xdiff's `xdl_do_merge` walk: a change apart from the other side's
 * becomes a one-sided record; overlapping ones a conflict unless both sides
 * made the same change (which records nothing — it lies between records,
 * emitted from ours). Returns which side's change the walk is done with.
 */
function stepRecords(
  records: MergeRecord[],
  x1: LineChange,
  x2: LineChange,
  context: { readonly sides: SidePair; readonly model: LineModel },
): Advance {
  if (endOf(x1) < x2.i1) {
    appendRecord(records, oursRecord(x1, x2.i2 - x2.i1));
    return ADVANCE_OURS;
  }
  if (endOf(x2) < x1.i1) {
    appendRecord(records, theirsRecord(x2, x1.i2 - x1.i1));
    return ADVANCE_THEIRS;
  }
  if (!isTwin(x1, x2, context.sides, context.model)) appendRecord(records, conflictRecord(x1, x2));
  return { ours: endOf(x2) >= endOf(x1), theirs: endOf(x1) >= endOf(x2) };
}

function buildRecords(baseLength: number, sides: SidePair, model: LineModel): MergeRecord[] {
  const ours = sides.ours.changes;
  const theirs = sides.theirs.changes;
  const records: MergeRecord[] = [];
  let a = 0;
  let b = 0;
  while (a < ours.length && b < theirs.length) {
    const advance = stepRecords(records, ours[a]!, theirs[b]!, { sides, model });
    if (advance.ours) a++;
    if (advance.theirs) b++;
  }
  for (; a < ours.length; a++) {
    appendRecord(records, oursRecord(ours[a]!, sides.theirs.lines.length - baseLength));
  }
  for (; b < theirs.length; b++) {
    appendRecord(records, theirsRecord(theirs[b]!, sides.ours.lines.length - baseLength));
  }
  return records;
}

/**
 * xdiff's `xdl_refine_conflicts`: diff a conflict's two sides and keep only the
 * differing runs conflicted; sides found identical resolve to ours.
 */
function refineConflict(record: MergeRecord, sides: SidePair, model: LineModel): MergeRecord[] {
  if (record.mode !== CONFLICT || record.chg1 === 0 || record.chg2 === 0) return [record];
  const hunks = model.diffSides(
    sides.ours.lines.slice(record.i1, record.i1 + record.chg1),
    sides.theirs.lines.slice(record.i2, record.i2 + record.chg2),
  );
  const runs = changesFromHunks(hunks);
  if (runs.length === 0) return [{ ...record, mode: IDENTICAL }];
  return runs.map((run) => ({
    mode: CONFLICT,
    i1: record.i1 + run.i1,
    chg1: run.chg1,
    i2: record.i2 + run.i2,
    chg2: run.chg2,
  }));
}

/**
 * xdiff's `xdl_simplify_non_conflicts`: two adjacent conflict records at most
 * `MAX_CONFLICT_COALESCE_GAP` lines apart become one, the gap on both sides.
 */
function coalesceNearConflicts(records: ReadonlyArray<MergeRecord>): MergeRecord[] {
  const out: MergeRecord[] = [];
  for (const record of records) {
    const last = out[out.length - 1];
    const joins =
      last !== undefined &&
      last.mode === CONFLICT &&
      record.mode === CONFLICT &&
      record.i1 - (last.i1 + last.chg1) <= MAX_CONFLICT_COALESCE_GAP;
    if (!joins) {
      out.push(record);
      continue;
    }
    out[out.length - 1] = {
      ...last,
      chg1: record.i1 + record.chg1 - last.i1,
      chg2: record.i2 + record.chg2 - last.i2,
    };
  }
  return out;
}

/** xdiff's `xdl_fill_merge_buffer`: ours' lines between records, each record's own lines. */
function toSegments(records: ReadonlyArray<MergeRecord>, sides: SidePair): MergeSegment[] {
  const ours = sides.ours.lines;
  const theirs = sides.theirs.lines;
  const segments: MergeSegment[] = [];
  const pushClean = (lines: ReadonlyArray<Uint8Array>): void => {
    if (lines.length > 0) segments.push({ kind: 'clean', lines });
  };
  let cursor = 0;
  for (const record of records) {
    if (record.mode === IDENTICAL) continue;
    pushClean(ours.slice(cursor, record.i1));
    const oursLines = ours.slice(record.i1, record.i1 + record.chg1);
    const theirsLines = theirs.slice(record.i2, record.i2 + record.chg2);
    if (record.mode === CONFLICT) {
      segments.push({ kind: 'conflict', ours: oursLines, theirs: theirsLines });
    } else {
      pushClean(record.mode === TAKE_OURS ? oursLines : theirsLines);
    }
    cursor = record.i1 + record.chg1;
  }
  pushClean(ours.slice(cursor));
  return segments;
}

/**
 * Build the ordered merge segments for a 3-way content merge, as xdiff's
 * zealous `xdl_merge` does: records from the two sides' changes, conflicts
 * refined over the sides' own diff, then near conflicts coalesced
 * (`MAX_CONFLICT_COALESCE_GAP`). A side that changed nothing yields the other.
 */
export function buildMergeSegments(
  baseLength: number,
  ours: SideEdit,
  theirs: SideEdit,
  model: LineModel = BYTE_EXACT,
): MergeSegment[] {
  if (ours.changes.length === 0) return [{ kind: 'clean', lines: theirs.lines }];
  if (theirs.changes.length === 0) return [{ kind: 'clean', lines: ours.lines }];
  const sides = { ours, theirs };
  const refined = buildRecords(baseLength, sides, model).flatMap((record) =>
    refineConflict(record, sides, model),
  );
  return toSegments(coalesceNearConflicts(refined), sides);
}
