import type { LineKey } from './whitespace.js';
import { classifyLines, hashLineSide } from './xdiff/xdl-classify.js';
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
}

/**
 * @internal — blame's hop-to-hop hash cache. A hop's parent-side blob is the
 * next hop's child-side blob, so a caller walking many hops over the same
 * blob lineage can hand a previous hop's `LineDiffWithHashes.oursHashes`
 * back in as this hop's `theirs`, instead of the classifier re-hashing lines
 * it already hashed. Absent for whichever side is genuinely new this hop.
 */
export interface PrecomputedLineHashes {
  readonly ours?: Uint32Array | undefined;
  readonly theirs?: Uint32Array | undefined;
}

/**
 * @internal — `diffPresplitLines`'s return, widened with each side's
 * `hashLineSide` output (aligned index-for-index with `oursLines`/
 * `theirsLines`), so a hop-to-hop caller can carry a side's hashes forward
 * as `PrecomputedLineHashes` for its next diff call.
 */
export interface LineDiffWithHashes extends LineDiff {
  readonly oursHashes: Uint32Array;
  readonly theirsHashes: Uint32Array;
}

const EMPTY_HASHES = new Uint32Array(0);

export const BINARY_DETECTION_BYTES = 8_000;
// Not consulted by isBinary — git's own binary rule is the NUL window alone.
// Live in exactly one place: the window grep's binary-presence probe scans
// (grep.ts). It does NOT bound the regex match path, whose per-line window was
// reverted — a text line is matched in full, at any length.
export const MAX_LINE_BYTES = 65_536;

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
    // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — nextI's own bound is redundant: a Uint8Array read past its length returns undefined, so oursChanged[nextI] === 0 below already stops the loop at the same point
    nextI < oursChanged.length &&
    // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — nextJ's own bound is redundant: a Uint8Array read past its length returns undefined, so theirsChanged[nextJ] === 0 below already stops the loop at the same point
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
    // Stryker disable next-line LogicalOperator,ConditionalExpression: equivalent — consumeCommonRun advances nextI/nextJ together every iteration, so common.i > i and common.j > j are always equal; swapping || for && or dropping either operand alone can't change this branch's outcome
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
 * copies. `precomputedHashes` lets that same caller skip re-hashing a side
 * whose hashes an earlier hop already computed (see `PrecomputedLineHashes`).
 */
export function diffPresplitLines(
  oursLines: ReadonlyArray<Uint8Array>,
  theirsLines: ReadonlyArray<Uint8Array>,
  options?: LineDiffOptions,
  precomputedHashes?: PrecomputedLineHashes,
): LineDiffWithHashes {
  return diffPresplitLinesForMode(
    oursLines,
    theirsLines,
    'git-default',
    options,
    precomputedHashes,
  );
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
  precomputedHashes?: PrecomputedLineHashes,
): LineDiffWithHashes {
  const lineKey = options?.lineKey;
  const M = oursLines.length;
  const N = theirsLines.length;

  if (M === 0 && N === 0) {
    return {
      hunks: [{ kind: 'common', oursStart: 0, oursEnd: 0, theirsStart: 0, theirsEnd: 0 }],
      oursLines,
      theirsLines,
      oursHashes: EMPTY_HASHES,
      theirsHashes: EMPTY_HASHES,
    };
  }

  // Stryker disable next-line ConditionalExpression,EqualityOperator,ArrayDeclaration: equivalent — classifySide's `normalized?.[i] ?? keyBytesOf(...)` fallback (xdl-classify.ts) re-normalizes a line whenever the cache is absent, wrongly sized, or wrongly populated, so this ternary and the array's pre-sizing only affect how much re-normalization work classifyLines does, never which class id a line gets
  const oursNormalized = lineKey === undefined ? undefined : new Array<Uint8Array>(M);
  // Stryker disable next-line ConditionalExpression,EqualityOperator,ArrayDeclaration: equivalent — same classifySide fallback as oursNormalized above, mirrored for theirs
  const theirsNormalized = lineKey === undefined ? undefined : new Array<Uint8Array>(N);
  const oursHashes = precomputedHashes?.ours ?? hashLineSide(oursLines, lineKey, oursNormalized);
  const theirsHashes =
    precomputedHashes?.theirs ?? hashLineSide(theirsLines, lineKey, theirsNormalized);
  const classes = classifyLines(
    oursLines,
    theirsLines,
    lineKey,
    oursHashes,
    theirsHashes,
    oursNormalized,
    theirsNormalized,
  );
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
    oursHashes,
    theirsHashes,
  };
}
