/**
 * Combined merge diff (`-c` / `--cc`), a port of git's `combine-diff.c`. For a
 * merge result `R` and parents `P0..Pn-1`, each parent is line-diffed against
 * `R`: result lines gain a `+` column where they were added relative to a
 * parent, and deleted parent lines become `lost` rows with a `-` column. Rows
 * are grouped into `@@@` hunks with 3 lines of context; in dense (`--cc`) mode a
 * hunk whose changes involve fewer than two parents is dropped (the merge took
 * it verbatim from one side), which also drops files identical to a parent.
 */

import { diffLines, splitLines } from '../diff/index.js';
import { decode } from '../objects/encoding.js';
import type { FileMode, ObjectId } from '../objects/index.js';
import { assertSafePath } from './safe-path.js';

const CONTEXT = 3;
const OID_ABBREV = 7;

export interface CombinedFile {
  readonly path: string;
  readonly resultContent: Uint8Array;
  readonly resultBlob: ObjectId;
  readonly resultMode: FileMode;
  readonly parents: ReadonlyArray<{
    readonly content: Uint8Array;
    readonly blob: ObjectId;
    readonly mode: FileMode;
  }>;
}

type Column = ' ' | '+' | '-';

// Mutated during the build phase (lost-line merging); not exposed.
interface CombinedLine {
  readonly text: string;
  readonly inResult: boolean;
  columns: Column[];
  changeMask: number;
}

const occupiesParent = (line: CombinedLine, parent: number): boolean =>
  line.inResult ? line.columns[parent] === ' ' : line.columns[parent] === '-';

/**
 * Per-parent alignment of `R`: which result lines are added relative to each
 * parent, and the parent lines lost before each result position.
 */
interface Alignment {
  readonly added: ReadonlyArray<boolean>; // per result line
  readonly lostBefore: ReadonlyArray<ReadonlyArray<string>>; // per result position 0..cnt
}

const alignParent = (parent: Uint8Array, result: Uint8Array, resultCount: number): Alignment => {
  const diff = diffLines(parent, result);
  const added = new Array<boolean>(resultCount).fill(false);
  const lostBefore: string[][] = Array.from({ length: resultCount + 1 }, () => []);
  for (const hunk of diff.hunks) {
    if (hunk.kind === 'theirs-only') {
      for (let r = hunk.theirsStart; r < hunk.theirsEnd; r += 1) added[r] = true;
    } else if (hunk.kind === 'ours-only') {
      const lost = lostBefore[hunk.theirsStart] as string[];
      for (let p = hunk.oursStart; p < hunk.oursEnd; p += 1) {
        lost.push(decode(diff.oursLines[p] as Uint8Array));
      }
    }
  }
  return { added, lostBefore };
};

/** Merge a parent's lost lines into the accumulated rows for one result position. */
const mergeLost = (
  rows: CombinedLine[],
  texts: ReadonlyArray<string>,
  parent: number,
  parentCount: number,
): void => {
  for (const text of texts) {
    const existing = rows.find((row) => row.text === text && row.columns[parent] === ' ');
    if (existing !== undefined) {
      existing.columns[parent] = '-';
      existing.changeMask |= 1 << parent;
    } else {
      const columns = Array.from(
        { length: parentCount },
        (_, i): Column => (i === parent ? '-' : ' '),
      );
      rows.push({ text, inResult: false, columns, changeMask: 1 << parent });
    }
  }
};

const buildCombinedLines = (file: CombinedFile): CombinedLine[] => {
  const resultLines = splitLines(file.resultContent).map(decode);
  const parentCount = file.parents.length;
  const alignments = file.parents.map((p) =>
    alignParent(p.content, file.resultContent, resultLines.length),
  );

  const lines: CombinedLine[] = [];
  for (let r = 0; r <= resultLines.length; r += 1) {
    const lostRows: CombinedLine[] = [];
    for (let i = 0; i < parentCount; i += 1) {
      // r ∈ [0, resultCount] and lostBefore has length resultCount + 1, so the index is in range.
      const lost = (alignments[i] as Alignment).lostBefore[r] as ReadonlyArray<string>;
      mergeLost(lostRows, lost, i, parentCount);
    }
    lines.push(...lostRows);
    if (r === resultLines.length) break;
    const columns = alignments.map((a): Column => (a.added[r] ? '+' : ' '));
    const changeMask = columns.reduce((mask, col, i) => (col === '+' ? mask | (1 << i) : mask), 0);
    lines.push({ text: resultLines[r] as string, inResult: true, columns, changeMask });
  }
  return lines;
};

interface Hunk {
  readonly start: number;
  readonly end: number;
}

/** Group interesting rows (changeMask ≠ 0) into hunks padded with CONTEXT lines. */
const buildHunks = (lines: ReadonlyArray<CombinedLine>): Hunk[] => {
  const hunks: Hunk[] = [];
  let current: { start: number; end: number } | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    if ((lines[i] as CombinedLine).changeMask === 0) continue;
    const start = Math.max(0, i - CONTEXT);
    const end = Math.min(lines.length, i + CONTEXT + 1);
    if (current !== undefined && start <= current.end) {
      current.end = Math.max(current.end, end);
    } else {
      if (current !== undefined) hunks.push(current);
      current = { start, end };
    }
  }
  if (current !== undefined) hunks.push(current);
  return hunks;
};

/**
 * In dense (`--cc`) mode a hunk is kept only when the result differs from
 * *every* parent within it (`union === all`). If some parent matches the result
 * over the hunk, the merge took that side verbatim — git omits it (this also
 * drops a file identical to a parent, and the trivial-merge "no patch" case).
 */
const isInteresting = (
  lines: ReadonlyArray<CombinedLine>,
  hunk: Hunk,
  dense: boolean,
  parentCount: number,
): boolean => {
  if (!dense) return true;
  const all = (1 << parentCount) - 1;
  let union = 0;
  for (let i = hunk.start; i < hunk.end; i += 1) union |= (lines[i] as CombinedLine).changeMask;
  return union === all;
};

const abbreviate = (oid: ObjectId): string => oid.slice(0, OID_ABBREV);

const hunkHeader = (
  lines: ReadonlyArray<CombinedLine>,
  hunk: Hunk,
  parentCount: number,
  before: { result: number; parents: number[] },
): string => {
  const at = '@'.repeat(parentCount + 1);
  const parentRanges = Array.from({ length: parentCount }, (_, i) => {
    let count = 0;
    for (let k = hunk.start; k < hunk.end; k += 1) {
      if (occupiesParent(lines[k] as CombinedLine, i)) count += 1;
    }
    return ` -${(before.parents[i] as number) + 1},${count}`;
  }).join('');
  let resultCount = 0;
  for (let k = hunk.start; k < hunk.end; k += 1) {
    if ((lines[k] as CombinedLine).inResult) resultCount += 1;
  }
  return `${at}${parentRanges} +${before.result + 1},${resultCount} ${at}`;
};

const renderHunkLines = (lines: ReadonlyArray<CombinedLine>, hunk: Hunk): string =>
  Array.from({ length: hunk.end - hunk.start }, (_, k) => {
    const line = lines[hunk.start + k] as CombinedLine;
    return `${line.columns.join('')}${line.text}`;
  }).join('');

const renderFile = (file: CombinedFile, dense: boolean): string => {
  assertSafePath(file.path);
  const lines = buildCombinedLines(file);
  const hunks = buildHunks(lines).filter((hunk) =>
    isInteresting(lines, hunk, dense, file.parents.length),
  );
  if (hunks.length === 0) return '';

  const marker = dense ? '--cc' : '--combined';
  const parentIndexes = file.parents.map((p) => abbreviate(p.blob)).join(',');
  const header = `diff ${marker} ${file.path}\nindex ${parentIndexes}..${abbreviate(file.resultBlob)}\n--- a/${file.path}\n+++ b/${file.path}\n`;

  // Running 0-based counts of lines occupying each file before a given row.
  const beforeResult: number[] = [];
  const beforeParents: number[][] = [];
  let result = 0;
  let parents = new Array<number>(file.parents.length).fill(0);
  for (const line of lines) {
    beforeResult.push(result);
    beforeParents.push(parents);
    if (line.inResult) result += 1;
    parents = parents.map((count, i) => (occupiesParent(line, i) ? count + 1 : count));
  }

  const body = hunks
    .map((hunk) => {
      const head = hunkHeader(lines, hunk, file.parents.length, {
        result: beforeResult[hunk.start] as number,
        parents: beforeParents[hunk.start] as number[],
      });
      return `${head}\n${renderHunkLines(lines, hunk)}`;
    })
    .join('');
  return `${header}${body}`;
};

/** Render the combined diff for every file; an empty string means the merge took a parent verbatim. */
export const renderCombinedDiff = (files: ReadonlyArray<CombinedFile>, dense: boolean): string =>
  files.map((file) => renderFile(file, dense)).join('');
