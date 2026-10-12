import type { LineKey } from './whitespace.js';
import { classifyLines, hashLineSide, type LineClasses } from './xdiff/xdl-classify.js';
import { compactChanges, type GroupFallback } from './xdiff/xdl-compact.js';
import { markHistogramChanges } from './xdiff/xdl-histogram.js';
import { markPatienceChanges } from './xdiff/xdl-patience.js';
import { cleanupRecords, type SearchMode, trimEnds } from './xdiff/xdl-prepare.js';
import type { ClassicFallback, LineRegion } from './xdiff/xdl-region.js';
import { markChanges } from './xdiff/xdl-split.js';

/**
 * xdiff's line-matching algorithm (`--diff-algorithm`): `myers` and its
 * exhaustive `minimal` search, `patience`'s unique-line anchoring, or
 * `histogram`'s rarest-common-line anchoring.
 */
export type DiffAlgorithm = 'myers' | 'minimal' | 'patience' | 'histogram';

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
interface ChangedMaps {
  readonly ours: Uint8Array;
  readonly theirs: Uint8Array;
}

interface ChangeSide {
  readonly lines: ReadonlyArray<Uint8Array>;
  readonly changed: Uint8Array;
}

const searchModeOf = (algorithm: DiffAlgorithm): SearchMode =>
  algorithm === 'minimal' ? 'minimal' : 'git-default';

/** xdiff's classic pipeline: trim, discard, then the divide-and-conquer Myers search. */
function classicChanged(classes: LineClasses, mode: SearchMode): ChangedMaps {
  const prepared = cleanupRecords(classes, trimEnds(classes.ours, classes.theirs), mode);
  markChanges(classes, prepared, mode);
  return { ours: prepared.ours.changed, theirs: prepared.theirs.changed };
}

/**
 * xutils.c's `xdl_fall_back_diff`: a fresh classic diff of just the region's
 * lines (its own classifier, trimming and discards), copied into both maps.
 */
function markClassicRegion(
  a: ChangeSide,
  b: ChangeSide,
  lineKey: LineKey | undefined,
  region: LineRegion,
): void {
  const aLines = a.lines.slice(region.line1 - 1, region.line1 - 1 + region.count1);
  const bLines = b.lines.slice(region.line2 - 1, region.line2 - 1 + region.count2);
  const classes = classifyLines(
    aLines,
    bLines,
    lineKey,
    hashLineSide(aLines, lineKey, undefined),
    hashLineSide(bLines, lineKey, undefined),
    undefined,
    undefined,
  );
  const changed = classicChanged(classes, 'git-default');
  a.changed.set(changed.ours, region.line1 - 1);
  b.changed.set(changed.theirs, region.line2 - 1);
}

/** xdiffi.c's post-slide `xdl_fall_back_diff`, with this pass's side as file 1. */
const groupFallback =
  (side: ChangeSide, other: ChangeSide, lineKey: LineKey | undefined): GroupFallback =>
  (group, otherGroup) =>
    markClassicRegion(side, other, lineKey, {
      line1: group.start + 1,
      count1: group.end - group.start,
      line2: otherGroup.start + 1,
      count2: otherGroup.end - otherGroup.start,
    });

type RecursiveMarker = (
  classes: LineClasses,
  oursChanged: Uint8Array,
  theirsChanged: Uint8Array,
  fallback: ClassicFallback,
) => void;

/** Runs histogram or patience over fresh maps, with the classic diff as their fallback. */
function recursiveChanged(
  marker: RecursiveMarker,
  classes: LineClasses,
  sides: { readonly ours: ReadonlyArray<Uint8Array>; readonly theirs: ReadonlyArray<Uint8Array> },
  lineKey: LineKey | undefined,
): ChangedMaps {
  const ours: ChangeSide = { lines: sides.ours, changed: new Uint8Array(sides.ours.length) };
  const theirs: ChangeSide = { lines: sides.theirs, changed: new Uint8Array(sides.theirs.length) };
  marker(classes, ours.changed, theirs.changed, (region) =>
    markClassicRegion(ours, theirs, lineKey, region),
  );
  return { ours: ours.changed, theirs: theirs.changed };
}

function changedFor(
  algorithm: DiffAlgorithm,
  classes: LineClasses,
  sides: { readonly ours: ReadonlyArray<Uint8Array>; readonly theirs: ReadonlyArray<Uint8Array> },
  lineKey: LineKey | undefined,
): ChangedMaps {
  if (algorithm === 'histogram')
    return recursiveChanged(markHistogramChanges, classes, sides, lineKey);
  if (algorithm === 'patience')
    return recursiveChanged(markPatienceChanges, classes, sides, lineKey);
  return classicChanged(classes, searchModeOf(algorithm));
}

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
  return diffPresplitLinesForMode(oursLines, theirsLines, 'myers', options, precomputedHashes);
}

/**
 * `diffPresplitLines`, parameterised by algorithm.
 *
 * @internal — the content merge picks its algorithm from `-X diff-algorithm`
 * (ort defaults to `histogram`); the property oracle in xdiff.properties.test.ts
 * uses `minimal` to assert the change count against an independent LCS bound.
 */
export function diffPresplitLinesForMode(
  oursLines: ReadonlyArray<Uint8Array>,
  theirsLines: ReadonlyArray<Uint8Array>,
  algorithm: DiffAlgorithm,
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
  const changed = changedFor(algorithm, classes, { ours: oursLines, theirs: theirsLines }, lineKey);
  const ours: ChangeSide = { lines: oursLines, changed: changed.ours };
  const theirs: ChangeSide = { lines: theirsLines, changed: changed.theirs };
  const histogram = algorithm === 'histogram';
  // git's own order (xdl_diff, xdiffi.c): compact ours against theirs, then
  // theirs against ours — a group that merges on the first pass can free up
  // a slide on the second.
  compactChanges(
    changed.ours,
    changed.theirs,
    classes.ours,
    oursLines,
    histogram ? groupFallback(ours, theirs, lineKey) : undefined,
  );
  compactChanges(
    changed.theirs,
    changed.ours,
    classes.theirs,
    theirsLines,
    histogram ? groupFallback(theirs, ours, lineKey) : undefined,
  );
  return {
    hunks: buildHunksFromChanged(changed.ours, changed.theirs),
    oursLines,
    theirsLines,
    oursHashes,
    theirsHashes,
  };
}
