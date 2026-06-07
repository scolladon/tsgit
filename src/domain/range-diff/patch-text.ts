/**
 * Render git's `range-diff.c` `read_patches` per-commit `## ` text — the form
 * the matcher hashes (exact match), measures (`diffsize` cost), compares
 * (`=`/`!` status), and diffs (the diff-of-diffs). Two strings are produced: the
 * full `patch` (` ## Metadata ##` + 4-space message + ` ## file ## ` diffs) and
 * the `diff` slice from the first file header (git's `diff_offset`). `diffsize`
 * counts the diff-slice lines (file headers + `@@` + body), not the metadata or
 * message. Hunk headers drop the `-a,b +c,d` line numbers and carry the default
 * funcname section heading; blob oids, index lines and `±`-path headers are
 * stripped, exactly as git does.
 */

import {
  type BodyLine,
  computeHunks,
  type DiffChange,
  isBinary,
  type OutputHunk,
  type PatchFile,
} from '../diff/index.js';
import { splitLines } from '../diff/line-diff.js';
import type { ObjectId } from '../objects/index.js';
import { findFuncLine } from './funcname.js';

const CONTEXT_LINES = 3;
const EMPTY = new Uint8Array();

export interface CommitPatchInput {
  readonly id: ObjectId;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly subject: string;
  readonly message: string;
  readonly files: ReadonlyArray<PatchFile>;
}

export interface RenderedPatch {
  readonly id: ObjectId;
  readonly subject: string;
  readonly patch: string;
  readonly diff: string;
  readonly diffsize: number;
}

/** Strip trailing ASCII whitespace (git's `isspace`), Unicode-blind. */
const trimTrailingAsciiWs = (text: string): string => text.replace(/[\t\n\v\f\r ]+$/u, '');

/** The medium-format message body: every line 4-space-indented, trailing ws
 *  stripped (so a blank line becomes empty), the final newline not doubled. */
const messageLines = (message: string): ReadonlyArray<string> => {
  if (message === '') return [];
  const body = message.endsWith('\n') ? message.slice(0, -1) : message;
  return body.split('\n').map((line) => trimTrailingAsciiWs(`    ${line}`));
};

const renderHead = (input: CommitPatchInput): string => {
  const header = ` ## Metadata ##\nAuthor: ${input.authorName} <${input.authorEmail}>\n\n ## Commit message ##\n`;
  const body = messageLines(input.message)
    .map((line) => `${line}\n`)
    .join('');
  return header + body;
};

/** The file's ` ## … ## ` header body (git's status description). */
const fileHeader = (change: DiffChange): string => {
  if (change.type === 'add') return `${change.newPath} (new)`;
  if (change.type === 'delete') return `${change.oldPath} (deleted)`;
  if (change.type === 'rename') return `${change.oldPath} => ${change.newPath}`;
  return change.oldMode === change.newMode
    ? change.path
    : `${change.path} (mode change ${change.oldMode} => ${change.newMode})`;
};

/** git's `current_filename`: the new name (old name for a deletion). */
const displayName = (change: DiffChange): string => {
  if (change.type === 'delete') return change.oldPath;
  if (change.type === 'add' || change.type === 'rename') return change.newPath;
  return change.path;
};

const prefixOf = (kind: BodyLine['kind']): string =>
  kind === 'context' ? ' ' : kind === 'delete' ? '-' : '+';

const NO_NEWLINE = ' \\ No newline at end of file';

const renderBodyLine = (line: BodyLine): ReadonlyArray<string> => {
  const rendered = `${prefixOf(line.kind)}${line.text}`;
  return line.trailingNoNewline ? [rendered, NO_NEWLINE] : [rendered];
};

/** git's hunk old-start (0-based): the first old line of the emitted hunk. */
const hunkOldStart = (hunk: OutputHunk): number =>
  hunk.oldLen > 0 ? hunk.oldStart - 1 : hunk.oldStart;

interface FileLines {
  readonly lines: ReadonlyArray<string>;
  readonly count: number;
}

/** Render one file's `@@`-stripped hunks, threading the funcname heading across
 *  hunks (retained when a hunk's scan finds none, like git's `func_line`). */
const renderHunks = (
  oldBytes: Uint8Array,
  hunks: ReadonlyArray<OutputHunk>,
  name: string,
): FileLines => {
  const oldLines = splitLines(oldBytes);
  const lines: string[] = [];
  let funcLinePrev = -1;
  let heading = '';
  for (const hunk of hunks) {
    const start = hunkOldStart(hunk);
    const found = findFuncLine(oldLines, start - 1, funcLinePrev);
    funcLinePrev = start - 1;
    if (found !== undefined) heading = found.heading;
    lines.push(heading === '' ? '@@' : `@@ ${name}: ${heading}`);
    for (const body of hunk.body) for (const rendered of renderBodyLine(body)) lines.push(rendered);
  }
  return { lines, count: lines.length };
};

const renderFileDiff = (file: PatchFile): FileLines => {
  const oldBytes = file.oldContent ?? EMPTY;
  const newBytes = file.newContent ?? EMPTY;
  if (isBinary(oldBytes) || isBinary(newBytes)) {
    return { lines: [renderBinary(file, oldBytes, newBytes)], count: 1 };
  }
  return renderHunks(
    oldBytes,
    computeHunks(oldBytes, newBytes, CONTEXT_LINES),
    displayName(file.change),
  );
};

const renderBinary = (file: PatchFile, oldBytes: Uint8Array, newBytes: Uint8Array): string => {
  const oldLabel = oldBytes.length === 0 ? '/dev/null' : displayName(file.change);
  const newLabel = newBytes.length === 0 ? '/dev/null' : displayName(file.change);
  return ` Binary files ${oldLabel} and ${newLabel} differ`;
};

export const renderRangePatch = (input: CommitPatchInput): RenderedPatch => {
  const head = renderHead(input);
  let patch = head;
  let diffsize = 0;
  for (const file of input.files) {
    const header = ` ## ${fileHeader(file.change)} ##`;
    const { lines, count } = renderFileDiff(file);
    patch += `\n${header}\n${lines.map((line) => `${line}\n`).join('')}`;
    diffsize += 1 + count; // the file header line plus every rendered diff line
  }
  const diffOffset = input.files.length > 0 ? head.length + 1 : 0;
  return {
    id: input.id,
    subject: input.subject,
    patch,
    diff: patch.slice(diffOffset),
    diffsize,
  };
};
