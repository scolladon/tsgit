import type { DiffChange } from './diff-change.js';
import { splitLines } from './line-diff.js';

export interface PatchFile {
  readonly change: DiffChange;
  readonly oldContent?: Uint8Array;
  readonly newContent?: Uint8Array;
}

export interface PatchPathPrefix {
  readonly old: string;
  readonly new: string;
}

export interface PatchOptions {
  readonly contextLines?: number;
  readonly pathPrefix?: PatchPathPrefix;
}

const OID_ABBREV_LENGTH = 7;
const ZERO_OID_ABBREV = '0000000';
const DEFAULT_PREFIX: PatchPathPrefix = { old: 'a/', new: 'b/' };
const NO_NEWLINE_MARKER = '\\ No newline at end of file';
const NEWLINE_CODE = 0x0a;

const decoder = new TextDecoder('utf-8', { fatal: false });

interface SplitContent {
  readonly lines: ReadonlyArray<string>;
  readonly hasTrailingNewline: boolean;
}

function splitContentLines(bytes: Uint8Array | undefined): SplitContent {
  if (bytes === undefined || bytes.length === 0) {
    return { lines: [], hasTrailingNewline: true };
  }
  const rawLines = splitLines(bytes);
  const lines = rawLines.map(stripTrailingLf);
  const hasTrailingNewline = bytes[bytes.length - 1] === NEWLINE_CODE;
  return { lines, hasTrailingNewline };
}

function stripTrailingLf(bytes: Uint8Array): string {
  const end =
    bytes.length > 0 && bytes[bytes.length - 1] === NEWLINE_CODE ? bytes.length - 1 : bytes.length;
  return decoder.decode(bytes.subarray(0, end));
}

function shortOid(oid: string): string {
  return oid.slice(0, OID_ABBREV_LENGTH);
}

function diffGitHeader(oldPath: string, newPath: string, prefix: PatchPathPrefix): string {
  return `diff --git ${prefix.old}${oldPath} ${prefix.new}${newPath}`;
}

function renderAddBlock(file: PatchFile, prefix: PatchPathPrefix): string[] {
  const change = file.change;
  if (change.type !== 'add') return [];
  const split = splitContentLines(file.newContent);
  const out: string[] = [];
  out.push(diffGitHeader(change.newPath, change.newPath, prefix));
  out.push(`new file mode ${change.newMode}`);
  out.push(`index ${ZERO_OID_ABBREV}..${shortOid(change.newId)}`);
  out.push('--- /dev/null');
  out.push(`+++ ${prefix.new}${change.newPath}`);
  if (split.lines.length === 0) return out;
  out.push(formatHunkHeader(0, 0, 1, split.lines.length));
  for (const line of split.lines) {
    out.push(`+${line}`);
  }
  if (!split.hasTrailingNewline) out.push(NO_NEWLINE_MARKER);
  return out;
}

function renderDeleteBlock(file: PatchFile, prefix: PatchPathPrefix): string[] {
  const change = file.change;
  if (change.type !== 'delete') return [];
  const split = splitContentLines(file.oldContent);
  const out: string[] = [];
  out.push(diffGitHeader(change.oldPath, change.oldPath, prefix));
  out.push(`deleted file mode ${change.oldMode}`);
  out.push(`index ${shortOid(change.oldId)}..${ZERO_OID_ABBREV}`);
  out.push(`--- ${prefix.old}${change.oldPath}`);
  out.push('+++ /dev/null');
  if (split.lines.length === 0) return out;
  out.push(formatHunkHeader(1, split.lines.length, 0, 0));
  for (const line of split.lines) {
    out.push(`-${line}`);
  }
  if (!split.hasTrailingNewline) out.push(NO_NEWLINE_MARKER);
  return out;
}

function formatHunkHeader(
  oldStart: number,
  oldLen: number,
  newStart: number,
  newLen: number,
): string {
  const oldRange = oldLen === 1 ? `${oldStart}` : `${oldStart},${oldLen}`;
  const newRange = newLen === 1 ? `${newStart}` : `${newStart},${newLen}`;
  return `@@ -${oldRange} +${newRange} @@`;
}

function renderFile(file: PatchFile, prefix: PatchPathPrefix): string[] {
  switch (file.change.type) {
    case 'add':
      return renderAddBlock(file, prefix);
    case 'delete':
      return renderDeleteBlock(file, prefix);
    default:
      return [];
  }
}

export function renderPatch(files: ReadonlyArray<PatchFile>, opts?: PatchOptions): string {
  if (files.length === 0) return '';
  const prefix = opts?.pathPrefix ?? DEFAULT_PREFIX;
  const lines: string[] = [];
  for (const file of files) {
    const block = renderFile(file, prefix);
    for (const line of block) lines.push(line);
  }
  if (lines.length === 0) return '';
  lines.push('');
  return lines.join('\n');
}
