// Transcribes git's xdiff/xdiffi.c `xdl_change_compact` (xdiffi.c:793) and its
// indent-heuristic helpers (`get_indent` :404, `measure_split` :481,
// `score_add_split` :588, `score_cmp` :666), git 2.55.0. The indent heuristic
// is git's own default (`diff.indentHeuristic`), so it always runs here —
// there is no flag to gate it.

interface Group {
  start: number;
  end: number;
}

interface CompactionSide {
  readonly changed: Uint8Array;
  readonly ids: Int32Array;
}

// xdiffi.c prepares `changed` with a sentinel false at index -1 and at index
// nrec, so every boundary scan can read one past either end without a bounds
// check. A Uint8Array has no index -1, so every read goes through this guard
// instead of the sentinel.
function isChanged(changed: Uint8Array, index: number): boolean {
  return index >= 0 && index < changed.length && changed[index] !== 0;
}

function groupInit(changed: Uint8Array, g: Group): void {
  g.start = 0;
  g.end = 0;
  while (isChanged(changed, g.end)) g.end++;
}

// Reachable false branch: the outer driver's own `g` walker hits it exactly
// once per file, at the last group. A `go`-side call (always made only after
// `g` has just confirmed a next group exists) never takes it — the two
// walkers process the same number of groups by construction, so xdiffi.c
// guards that call with `BUG("group sync broken...")` instead of branching on
// it; that check is omitted here as it can never fire.
function groupNext(changed: Uint8Array, g: Group): boolean {
  if (g.end === changed.length) return false;
  g.start = g.end + 1;
  g.end = g.start;
  while (isChanged(changed, g.end)) g.end++;
  return true;
}

// Only ever called on the OTHER file's walker (`go`), never on `g` itself —
// xdiffi.c does the same. Its own BUG-guarded start-of-file case is therefore
// omitted for the same reason as groupNext's: sync with `g`'s walk guarantees
// a previous group always exists when this is called.
function groupPrevious(changed: Uint8Array, g: Group): void {
  g.end = g.start - 1;
  g.start = g.end;
  while (isChanged(changed, g.start - 1)) g.start--;
}

function groupSlideDown(side: CompactionSide, g: Group): boolean {
  const { changed, ids } = side;
  if (g.end >= changed.length || ids[g.start] !== ids[g.end]) return false;
  changed[g.start++] = 0;
  changed[g.end++] = 1;
  while (isChanged(changed, g.end)) g.end++;
  return true;
}

function groupSlideUp(side: CompactionSide, g: Group): boolean {
  const { changed, ids } = side;
  if (g.start === 0 || ids[g.start - 1] !== ids[g.end - 1]) return false;
  changed[--g.start] = 1;
  changed[--g.end] = 0;
  while (isChanged(changed, g.start - 1)) g.start--;
  return true;
}

const MAX_INDENT = 200;
const SPACE = 0x20;
const TAB = 0x09;

function isSpaceByte(byte: number): boolean {
  return (
    byte === SPACE ||
    byte === TAB ||
    byte === 0x0a ||
    byte === 0x0b ||
    byte === 0x0c ||
    byte === 0x0d
  );
}

/** git's `get_indent`: tabs advance to the next multiple of 8, clamped at
 *  MAX_INDENT; a whitespace-only (or empty) line reports -1. */
function getIndent(line: Uint8Array): number {
  let indent = 0;
  for (let i = 0; i < line.length; i++) {
    const byte = line[i]!;
    if (!isSpaceByte(byte)) return indent;
    if (byte === SPACE) indent += 1;
    else if (byte === TAB) indent += 8 - (indent % 8);
    if (indent >= MAX_INDENT) return MAX_INDENT;
  }
  return -1;
}

const MAX_BLANKS = 20;

interface BlankRun {
  readonly blank: number;
  readonly indent: number;
}

/** Walks `lines` from `start` in `step` direction counting consecutive blank
 *  lines, stopping at the first non-blank line's indent, an array bound, or
 *  MAX_BLANKS (which reports indent 0, git's O(N^2) guard). */
function scanBlankRun(lines: ReadonlyArray<Uint8Array>, start: number, step: number): BlankRun {
  let blank = 0;
  let indent = -1;
  for (let i = start; i >= 0 && i < lines.length; i += step) {
    indent = getIndent(lines[i]!);
    if (indent !== -1) return { blank, indent };
    blank++;
    if (blank === MAX_BLANKS) return { blank, indent: 0 };
  }
  return { blank, indent };
}

interface SplitMeasurement {
  readonly endOfFile: boolean;
  readonly indent: number;
  readonly preBlank: number;
  readonly preIndent: number;
  readonly postBlank: number;
  readonly postIndent: number;
}

/** git's `measure_split`: characterises a hypothetical split of `lines`
 *  above index `split`, independent of which lines are marked changed. */
function measureSplit(lines: ReadonlyArray<Uint8Array>, split: number): SplitMeasurement {
  const endOfFile = split >= lines.length;
  const indent = endOfFile ? -1 : getIndent(lines[split]!);
  const pre = scanBlankRun(lines, split - 1, -1);
  const post = scanBlankRun(lines, split + 1, 1);
  return {
    endOfFile,
    indent,
    preBlank: pre.blank,
    preIndent: pre.indent,
    postBlank: post.blank,
    postIndent: post.indent,
  };
}

interface SplitScore {
  readonly effectiveIndent: number;
  readonly penalty: number;
}

const START_OF_FILE_PENALTY = 1;
const END_OF_FILE_PENALTY = 21;
const TOTAL_BLANK_WEIGHT = -30;
const POST_BLANK_WEIGHT = 6;
const RELATIVE_INDENT_PENALTY = -4;
const RELATIVE_INDENT_WITH_BLANK_PENALTY = 10;
const RELATIVE_OUTDENT_PENALTY = 24;
const RELATIVE_OUTDENT_WITH_BLANK_PENALTY = 17;
const RELATIVE_DEDENT_PENALTY = 23;
const RELATIVE_DEDENT_WITH_BLANK_PENALTY = 17;
const INDENT_WEIGHT = 60;
const INDENT_HEURISTIC_MAX_SLIDING = 100;

function postBlankCount(m: SplitMeasurement): number {
  return m.indent === -1 ? 1 + m.postBlank : 0;
}

function effectiveIndentOf(m: SplitMeasurement): number {
  return m.indent !== -1 ? m.indent : m.postIndent;
}

function startOfFilePenalty(m: SplitMeasurement): number {
  return m.preIndent === -1 && m.preBlank === 0 ? START_OF_FILE_PENALTY : 0;
}

function endOfFilePenalty(m: SplitMeasurement): number {
  return m.endOfFile ? END_OF_FILE_PENALTY : 0;
}

function blankLinePenalty(preBlank: number, postBlank: number): number {
  const totalBlank = preBlank + postBlank;
  return TOTAL_BLANK_WEIGHT * totalBlank + POST_BLANK_WEIGHT * postBlank;
}

/** Penalty for a line indented relative to its predecessor and successor —
 *  git's three-way indent/outdent/dedent split of `score_add_split`. */
function relativeIndentPenalty(indent: number, m: SplitMeasurement, anyBlanks: boolean): number {
  if (indent === -1 || m.preIndent === -1 || indent === m.preIndent) return 0;
  if (indent > m.preIndent) {
    return anyBlanks ? RELATIVE_INDENT_WITH_BLANK_PENALTY : RELATIVE_INDENT_PENALTY;
  }
  const isOutdent = m.postIndent !== -1 && m.postIndent > indent;
  if (isOutdent) return anyBlanks ? RELATIVE_OUTDENT_WITH_BLANK_PENALTY : RELATIVE_OUTDENT_PENALTY;
  return anyBlanks ? RELATIVE_DEDENT_WITH_BLANK_PENALTY : RELATIVE_DEDENT_PENALTY;
}

/** git's `score_add_split`: accumulates one split's badness onto `score`. */
function addSplitScore(score: SplitScore, m: SplitMeasurement): SplitScore {
  const postBlank = postBlankCount(m);
  const indent = effectiveIndentOf(m);
  const anyBlanks = m.preBlank + postBlank !== 0;
  const penalty =
    score.penalty +
    startOfFilePenalty(m) +
    endOfFilePenalty(m) +
    blankLinePenalty(m.preBlank, postBlank) +
    relativeIndentPenalty(indent, m, anyBlanks);
  return { effectiveIndent: score.effectiveIndent + indent, penalty };
}

function compareIndent(a: number, b: number): number {
  return (a > b ? 1 : 0) - (a < b ? 1 : 0);
}

/** git's `score_cmp`: negative means `s1` is the better split. */
function scoreCmp(s1: SplitScore, s2: SplitScore): number {
  return (
    INDENT_WEIGHT * compareIndent(s1.effectiveIndent, s2.effectiveIndent) +
    (s1.penalty - s2.penalty)
  );
}

function scoreForShift(
  lines: ReadonlyArray<Uint8Array>,
  shift: number,
  groupSize: number,
): SplitScore {
  const afterGroup = addSplitScore({ effectiveIndent: 0, penalty: 0 }, measureSplit(lines, shift));
  return addSplitScore(afterGroup, measureSplit(lines, shift - groupSize));
}

/** The `end` position (within [earliestEnd, latestEnd]) whose two split
 *  scores sum to the lowest badness; ties favour the larger (later) shift,
 *  matching git's `<= 0` replace condition. */
function bestIndentShift(
  lines: ReadonlyArray<Uint8Array>,
  groupSize: number,
  earliestEnd: number,
  latestEnd: number,
): number {
  const lowerBound = Math.max(
    earliestEnd,
    latestEnd - groupSize - 1,
    latestEnd - INDENT_HEURISTIC_MAX_SLIDING,
  );
  let bestShift = lowerBound;
  let bestScore = scoreForShift(lines, lowerBound, groupSize);
  for (let shift = lowerBound + 1; shift <= latestEnd; shift++) {
    const score = scoreForShift(lines, shift, groupSize);
    if (scoreCmp(score, bestScore) <= 0) {
      bestScore = score;
      bestShift = shift;
    }
  }
  return bestShift;
}

interface SlideResult {
  readonly earliestEnd: number;
  readonly matchesOtherGroup: boolean;
}

function slideUpFully(side: CompactionSide, otherChanged: Uint8Array, g: Group, go: Group): void {
  while (groupSlideUp(side, g)) groupPrevious(otherChanged, go);
}

function slideDownFully(
  side: CompactionSide,
  otherChanged: Uint8Array,
  g: Group,
  go: Group,
): boolean {
  let matchesOtherGroup = false;
  while (groupSlideDown(side, g)) {
    groupNext(otherChanged, go);
    if (go.end > go.start) matchesOtherGroup = true;
  }
  return matchesOtherGroup;
}

/** Slides `g` up then down as far as it goes, merging into any group it
 *  bumps into and restarting until a stable size is reached — git's
 *  `xdl_change_compact` do/while loop. */
function slideGroupToExtremes(
  side: CompactionSide,
  otherChanged: Uint8Array,
  g: Group,
  go: Group,
): SlideResult {
  let earliestEnd = g.end;
  let matchesOtherGroup = false;
  let groupSize: number;
  do {
    groupSize = g.end - g.start;
    slideUpFully(side, otherChanged, g, go);
    earliestEnd = g.end;
    const matchesAtEarliest = go.end > go.start;
    const matchesWhileSlidingDown = slideDownFully(side, otherChanged, g, go);
    matchesOtherGroup = matchesAtEarliest || matchesWhileSlidingDown;
  } while (groupSize !== g.end - g.start);
  return { earliestEnd, matchesOtherGroup };
}

/** Slides `g` back up until the other file's group at the same position is
 *  non-empty again — avoids splitting a change that lines up across files. */
function slideUpToMatch(side: CompactionSide, otherChanged: Uint8Array, g: Group, go: Group): void {
  while (go.end === go.start) {
    groupSlideUp(side, g);
    groupPrevious(otherChanged, go);
  }
}

function slideToIndentHeuristic(
  side: CompactionSide,
  otherChanged: Uint8Array,
  lines: ReadonlyArray<Uint8Array>,
  g: Group,
  go: Group,
  earliestEnd: number,
): void {
  const groupSize = g.end - g.start;
  const bestShift = bestIndentShift(lines, groupSize, earliestEnd, g.end);
  while (g.end > bestShift) {
    groupSlideUp(side, g);
    groupPrevious(otherChanged, go);
  }
}

// The histogram-diff re-diff fallback (xdiffi.c :940-958, gated on
// XDF_HISTOGRAM_DIFF) is omitted: this engine only ever runs Myers, so that
// branch's condition is always false here.
function compactGroup(
  side: CompactionSide,
  otherChanged: Uint8Array,
  lines: ReadonlyArray<Uint8Array>,
  g: Group,
  go: Group,
): void {
  const { earliestEnd, matchesOtherGroup } = slideGroupToExtremes(side, otherChanged, g, go);
  if (g.end === earliestEnd) return;
  if (matchesOtherGroup) {
    slideUpToMatch(side, otherChanged, g, go);
    return;
  }
  slideToIndentHeuristic(side, otherChanged, lines, g, go, earliestEnd);
}

/**
 * git's `xdl_change_compact`: slides each maximal run of changed lines in
 * `changed` up or down to align with matching content, merging runs it bumps
 * into, then places any still-free run by the indent heuristic. Mutates
 * `changed` in place — the hot path this module exists for, and the one
 * documented exception to this codebase's immutability rule.
 */
export function compactChanges(
  changed: Uint8Array,
  otherChanged: Uint8Array,
  ids: Int32Array,
  lines: ReadonlyArray<Uint8Array>,
): void {
  const side: CompactionSide = { changed, ids };
  const g: Group = { start: 0, end: 0 };
  const go: Group = { start: 0, end: 0 };
  groupInit(changed, g);
  groupInit(otherChanged, go);

  while (true) {
    if (g.end !== g.start) compactGroup(side, otherChanged, lines, g, go);
    if (!groupNext(changed, g)) break;
    groupNext(otherChanged, go);
  }
}
