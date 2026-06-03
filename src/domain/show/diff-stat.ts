/**
 * `--stat` / `--numstat` rendering, faithful to `git show`'s diffstat. Per-file
 * added/deleted line counts come from the line diff; binary files render as
 * `Bin <old> -> <new> bytes` (stat) or `-\t-` (numstat). The `--stat` graph
 * scales with git's `scale_linear` once the busiest file exceeds the available
 * graph width (default terminal width 80).
 */
import type { DiffChange } from '../diff/index.js';
import { diffLines, isBinary, type PatchFile } from '../diff/index.js';
import { assertSafePath } from './safe-path.js';

export interface StatEntry {
  /** Display path (`old => new` for renames). */
  readonly path: string;
  readonly added: number;
  readonly deleted: number;
  readonly binary: boolean;
  readonly oldSize: number;
  readonly newSize: number;
}

const EMPTY = new Uint8Array(0);
const DEFAULT_WIDTH = 80;
const LAYOUT_OVERHEAD = 6; // leading space + " | " + space before graph + git's reserved column

const displayPath = (change: DiffChange): string => {
  switch (change.type) {
    case 'add':
      return change.newPath;
    case 'delete':
      return change.oldPath;
    case 'rename':
      return `${change.oldPath} => ${change.newPath}`;
    default:
      return change.path;
  }
};

const countLines = (old: Uint8Array, next: Uint8Array): { added: number; deleted: number } => {
  const diff = diffLines(old, next);
  let added = 0;
  let deleted = 0;
  for (const hunk of diff.hunks) {
    if (hunk.kind === 'theirs-only') added += hunk.theirsEnd - hunk.theirsStart;
    else if (hunk.kind === 'ours-only') deleted += hunk.oursEnd - hunk.oursStart;
  }
  return { added, deleted };
};

export const buildStatEntries = (files: ReadonlyArray<PatchFile>): ReadonlyArray<StatEntry> =>
  files.map((file) => {
    const old = file.oldContent ?? EMPTY;
    const next = file.newContent ?? EMPTY;
    const path = displayPath(file.change);
    if (isBinary(old) || isBinary(next)) {
      return {
        path,
        added: 0,
        deleted: 0,
        binary: true,
        oldSize: old.length,
        newSize: next.length,
      };
    }
    const { added, deleted } = countLines(old, next);
    return { path, added, deleted, binary: false, oldSize: old.length, newSize: next.length };
  });

export const renderNumstat = (entries: ReadonlyArray<StatEntry>): string =>
  entries
    .map((e) => {
      assertSafePath(e.path);
      return e.binary ? `-\t-\t${e.path}\n` : `${e.added}\t${e.deleted}\t${e.path}\n`;
    })
    .join('');

const scaleLinear = (it: number, width: number, max: number): number =>
  it === 0 ? 0 : 1 + Math.floor((it * (width - 1)) / max);

const repeat = (char: string, count: number): string => char.repeat(Math.max(0, count));

const pluralUnit = (count: number, singular: string): string =>
  `${count} ${singular}${count === 1 ? '' : 's'}`;

const summaryLine = (entries: ReadonlyArray<StatEntry>): string => {
  const insertions = entries.reduce((sum, e) => sum + e.added, 0);
  const deletions = entries.reduce((sum, e) => sum + e.deleted, 0);
  let line = ` ${pluralUnit(entries.length, 'file')} changed`;
  if (insertions !== 0 || deletions === 0) line += `, ${pluralUnit(insertions, 'insertion')}(+)`;
  if (deletions !== 0 || insertions === 0) line += `, ${pluralUnit(deletions, 'deletion')}(-)`;
  return line;
};

export const renderDiffStat = (
  entries: ReadonlyArray<StatEntry>,
  width: number = DEFAULT_WIDTH,
): string => {
  const maxName = Math.max(...entries.map((e) => e.path.length));
  const maxChange = entries.reduce(
    (max, e) => (e.binary ? max : Math.max(max, e.added + e.deleted)),
    0,
  );
  const numberWidth = String(maxChange).length;
  const graphWidth = width - maxName - numberWidth - LAYOUT_OVERHEAD;
  const scaling = maxChange > graphWidth;
  const lines = entries.map((e) => {
    assertSafePath(e.path);
    const nameCol = ` ${e.path.padEnd(maxName)} | `;
    if (e.binary) return `${nameCol}Bin ${e.oldSize} -> ${e.newSize} bytes`;
    const count = String(e.added + e.deleted).padStart(numberWidth);
    const plus = scaling ? scaleLinear(e.added, graphWidth, maxChange) : e.added;
    const minus = scaling ? scaleLinear(e.deleted, graphWidth, maxChange) : e.deleted;
    const graph = `${repeat('+', plus)}${repeat('-', minus)}`;
    // git omits the space before an empty graph (a zero-change file, e.g. a pure rename).
    return graph === '' ? `${nameCol}${count}` : `${nameCol}${count} ${graph}`;
  });
  return [...lines, summaryLine(entries)].map((line) => `${line}\n`).join('');
};
