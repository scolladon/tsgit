import type { LineKey } from './whitespace.js';
import { classifyLines } from './xdiff/xdl-classify.js';
import { compactChanges } from './xdiff/xdl-compact.js';
import { cleanupRecords, type SearchMode, trimEnds } from './xdiff/xdl-prepare.js';
import { markChanges } from './xdiff/xdl-split.js';

export interface LineHunk {
  readonly kind: 'common' | 'ours-only' | 'theirs-only';
  readonly oursStart: number;
  readonly oursEnd: number;
  readonly theirsStart: number;
  readonly theirsEnd: number;
}

export interface LineDiffOptions {
  readonly lineKey?: LineKey;
}

export interface LineDiff {
  readonly hunks: ReadonlyArray<LineHunk>;
  readonly oursLines: ReadonlyArray<Uint8Array>;
  readonly theirsLines: ReadonlyArray<Uint8Array>;
  /** Always `false`; kept so existing readers compile. git's xdiff engine
   *  never bails to a whole-file replace, however large the true edit
   *  distance is. */
  readonly degraded: boolean;
}

export const BINARY_DETECTION_BYTES = 8_000;
// Not consulted by isBinary — git's own binary rule is the NUL window alone.
// Live in exactly one place: the window grep's binary-presence probe scans
// (grep.ts). It does NOT bound the regex match path, whose per-line window was
// reverted — a text line is matched in full, at any length.
export const MAX_LINE_BYTES = 65_536;
// DEPRECATED — no consumer, and NOT a bound: diffLines imposes no limit on how
// many lines either side may have. A caller reading this as a maximum will be
// wrong. Kept at today's value only because dropping a public export breaks
// consumers; do not add uses.
export const MAX_LINES = 100_000;
// DEPRECATED — no consumer, and NOT a bound: the xdiff split engine's cost
// cap (bounded by the input size, not by this constant) replaces the old
// bailout that used to degrade a pair past this edit distance to a
// whole-file replace. Kept at today's value only because dropping a public
// export breaks consumers; do not add uses.
export const MAX_DIFF_EDIT_DISTANCE = 10_000;
// DEPRECATED — no consumer, and NOT a bound: the Myers iteration budget is
// MAX_DIFF_EDIT_DISTANCE alone and is not derived from any factor. Kept at
// today's value only because dropping a public export breaks consumers; do not
// add uses.
export const MAX_DIFF_ITERATION_FACTOR = 1_000;
// DEPRECATED — no consumer, and NOT a bound: diffLines no longer pre-checks
// total input size, so a pair far past this value diffs normally. Kept at
// today's value only because dropping a public export breaks consumers; do not
// add uses.
export const MAX_DIFF_LINES = 50_000;

const LF = 0x0a;
const NUL = 0x00;

export function splitLines(bytes: Uint8Array): ReadonlyArray<Uint8Array> {
  const lines: Uint8Array[] = [];
  let start = 0;
  // Stryker disable next-line EqualityOperator: equivalent — at i===bytes.length, bytes[i] is undefined, !== LF, the extra iteration is a no-op
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === LF) {
      lines.push(bytes.subarray(start, i + 1));
      start = i + 1;
    }
  }
  if (start < bytes.length) {
    lines.push(bytes.subarray(start));
  }
  return lines;
}

function hasNulInWindow(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, BINARY_DETECTION_BYTES);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === NUL) return true;
  }
  return false;
}

export function isBinary(bytes: Uint8Array): boolean {
  return hasNulInWindow(bytes);
}

function commonHunk(
  oursStart: number,
  oursEnd: number,
  theirsStart: number,
  theirsEnd: number,
): LineHunk {
  return { kind: 'common', oursStart, oursEnd, theirsStart, theirsEnd };
}

function oursOnlyHunk(oursStart: number, oursEnd: number, theirsPos: number): LineHunk {
  return { kind: 'ours-only', oursStart, oursEnd, theirsStart: theirsPos, theirsEnd: theirsPos };
}

function theirsOnlyHunk(oursPos: number, theirsStart: number, theirsEnd: number): LineHunk {
  return { kind: 'theirs-only', oursStart: oursPos, oursEnd: oursPos, theirsStart, theirsEnd };
}

/** Walks both post-compaction changed maps to the next common-line pair,
 *  starting from `(i, j)`. */
function consumeCommonRun(
  oursChanged: Uint8Array,
  theirsChanged: Uint8Array,
  i: number,
  j: number,
): { readonly i: number; readonly j: number } {
  let nextI = i;
  let nextJ = j;
  while (
    nextI < oursChanged.length &&
    nextJ < theirsChanged.length &&
    oursChanged[nextI] === 0 &&
    theirsChanged[nextJ] === 0
  ) {
    nextI++;
    nextJ++;
  }
  return { i: nextI, j: nextJ };
}

function consumeChangedRun(changed: Uint8Array, start: number): number {
  let i = start;
  while (i < changed.length && changed[i] !== 0) i++;
  return i;
}

/**
 * Rebuilds `LineHunk`s from the two (post-compaction) changed maps: a common
 * run, then — per gap between common runs — an `ours-only` hunk before a
 * `theirs-only` hunk, matching git's per-side change-group ordering.
 */
function buildHunksFromChanged(
  oursChanged: Uint8Array,
  theirsChanged: Uint8Array,
): ReadonlyArray<LineHunk> {
  const hunks: LineHunk[] = [];
  const M = oursChanged.length;
  const N = theirsChanged.length;
  let i = 0;
  let j = 0;
  while (i < M || j < N) {
    const common = consumeCommonRun(oursChanged, theirsChanged, i, j);
    if (common.i > i || common.j > j) hunks.push(commonHunk(i, common.i, j, common.j));
    ({ i, j } = common);
    const oursEnd = consumeChangedRun(oursChanged, i);
    if (oursEnd > i) hunks.push(oursOnlyHunk(i, oursEnd, j));
    i = oursEnd;
    const theirsEnd = consumeChangedRun(theirsChanged, j);
    if (theirsEnd > j) hunks.push(theirsOnlyHunk(i, j, theirsEnd));
    j = theirsEnd;
  }
  return hunks;
}

/**
 * git's xdiff line diff of `ours` against `theirs`: classify, run the
 * linear-space divide-and-conquer Myers search, then slide the resulting
 * change groups like git's own compaction pass. Never degrades to a
 * whole-file replace, however large the pair's true edit distance is.
 */
export function diffLines(
  ours: Uint8Array,
  theirs: Uint8Array,
  options?: LineDiffOptions,
): LineDiff {
  return diffPresplitLines(splitLines(ours), splitLines(theirs), options);
}

/**
 * `diffLines`'s counterpart for a caller that already holds both sides
 * split — `blame`'s changed-parent hop, where the child side is the
 * previous generation's carried `Suspect.lines` and only the parent side is
 * genuinely new. Skips `splitLines` entirely on both inputs; the returned
 * `oursLines`/`theirsLines` are the SAME array references passed in, not
 * copies.
 */
export function diffPresplitLines(
  oursLines: ReadonlyArray<Uint8Array>,
  theirsLines: ReadonlyArray<Uint8Array>,
  options?: LineDiffOptions,
): LineDiff {
  return diffPresplitLinesForMode(oursLines, theirsLines, 'git-default', options);
}

/**
 * `diffPresplitLines`, parameterised by search mode.
 *
 * @internal — exported only for the property oracle in
 * xdiff.properties.test.ts, which needs `'minimal'` to assert the change
 * count against an independent LCS-based bound. Every production caller
 * goes through `diffPresplitLines`, which always passes `'git-default'`.
 */
export function diffPresplitLinesForMode(
  oursLines: ReadonlyArray<Uint8Array>,
  theirsLines: ReadonlyArray<Uint8Array>,
  mode: SearchMode,
  options?: LineDiffOptions,
): LineDiff {
  const lineKey = options?.lineKey;
  const M = oursLines.length;
  const N = theirsLines.length;

  if (M === 0 && N === 0) {
    return {
      hunks: [{ kind: 'common', oursStart: 0, oursEnd: 0, theirsStart: 0, theirsEnd: 0 }],
      oursLines,
      theirsLines,
      degraded: false,
    };
  }

  const classes = classifyLines(oursLines, theirsLines, lineKey);
  const trimmed = trimEnds(classes.ours, classes.theirs);
  const prepared = cleanupRecords(classes, trimmed, mode);
  markChanges(classes, prepared, mode);
  // git's own order (xdl_diff, xdiffi.c): compact ours against theirs, then
  // theirs against ours — a group that merges on the first pass can free up
  // a slide on the second.
  compactChanges(prepared.ours.changed, prepared.theirs.changed, classes.ours, oursLines);
  compactChanges(prepared.theirs.changed, prepared.ours.changed, classes.theirs, theirsLines);
  return {
    hunks: buildHunksFromChanged(prepared.ours.changed, prepared.theirs.changed),
    oursLines,
    theirsLines,
    degraded: false,
  };
}
