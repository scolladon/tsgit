import type {
  AddChange,
  DeleteChange,
  DiffChange,
  ModifyChange,
  RenameChange,
  TypeChangeChange,
} from './diff-change.js';
import { invalidDiffInput } from './error.js';
import { diffLines, isBinary, type LineHunk, splitLines } from './line-diff.js';

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
const DEFAULT_CONTEXT_LINES = 3;
const NO_NEWLINE_MARKER = '\\ No newline at end of file';
const NEWLINE_CODE = 0x0a;

const decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Reject paths and path-prefixes that would break the unified-diff grammar.
 * Tree-object parsers accept any non-`/` byte sequence as an entry name, so
 * a malicious tree could carry a path containing `\n` or `\0`. Without this
 * guard the rendered headers would smuggle extra lines into the document
 * that downstream patch parsers would interpret as forged hunks.
 */
function rejectUnsafePathChars(label: string, value: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x0a || code === 0x0d || code === 0x00) {
      throw invalidDiffInput(`${label} contains control character (code ${code}) at index ${i}`);
    }
  }
}

function assertSafePaths(change: DiffChange, prefix: PatchPathPrefix): void {
  rejectUnsafePathChars('pathPrefix.old', prefix.old);
  rejectUnsafePathChars('pathPrefix.new', prefix.new);
  if (change.type === 'rename') {
    rejectUnsafePathChars('oldPath', change.oldPath);
    rejectUnsafePathChars('newPath', change.newPath);
    return;
  }
  if (change.type === 'add') {
    rejectUnsafePathChars('newPath', change.newPath);
    return;
  }
  if (change.type === 'delete') {
    rejectUnsafePathChars('oldPath', change.oldPath);
    return;
  }
  rejectUnsafePathChars('path', change.path);
}

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

type EditKind = 'context' | 'delete' | 'insert';

interface Edit {
  readonly kind: EditKind;
  readonly oldIndex: number;
  readonly newIndex: number;
  readonly text: string;
}

interface BodyLine {
  readonly kind: EditKind;
  readonly text: string;
  readonly trailingNoNewline: boolean;
}

interface OutputHunk {
  readonly oldStart: number;
  readonly oldLen: number;
  readonly newStart: number;
  readonly newLen: number;
  readonly body: ReadonlyArray<BodyLine>;
}

function commonEditsFrom(hunk: LineHunk, oldLines: ReadonlyArray<string>): Edit[] {
  const edits: Edit[] = [];
  for (let i = hunk.oursStart; i < hunk.oursEnd; i++) {
    // LineHunk indices are produced by buildHunks against the same line array,
    // so oldLines[i] is always defined; the non-null assertion mirrors
    // `line-diff.ts`'s own conventions.
    edits.push({
      kind: 'context',
      oldIndex: i,
      newIndex: hunk.theirsStart + (i - hunk.oursStart),
      text: oldLines[i]!,
    });
  }
  return edits;
}

function deleteEditsFrom(hunk: LineHunk, oldLines: ReadonlyArray<string>): Edit[] {
  const edits: Edit[] = [];
  for (let i = hunk.oursStart; i < hunk.oursEnd; i++) {
    edits.push({
      kind: 'delete',
      oldIndex: i,
      newIndex: hunk.theirsStart,
      text: oldLines[i]!,
    });
  }
  return edits;
}

function insertEditsFrom(hunk: LineHunk, newLines: ReadonlyArray<string>): Edit[] {
  const edits: Edit[] = [];
  for (let i = hunk.theirsStart; i < hunk.theirsEnd; i++) {
    edits.push({
      kind: 'insert',
      oldIndex: hunk.oursEnd,
      newIndex: i,
      text: newLines[i]!,
    });
  }
  return edits;
}

function editsFromHunk(
  hunk: LineHunk,
  oldLines: ReadonlyArray<string>,
  newLines: ReadonlyArray<string>,
): Edit[] {
  if (hunk.kind === 'common') return commonEditsFrom(hunk, oldLines);
  if (hunk.kind === 'ours-only') return deleteEditsFrom(hunk, oldLines);
  return insertEditsFrom(hunk, newLines);
}

function buildEdits(
  oldLines: ReadonlyArray<string>,
  newLines: ReadonlyArray<string>,
  oldBytes: Uint8Array,
  newBytes: Uint8Array,
): ReadonlyArray<Edit> {
  const ld = diffLines(oldBytes, newBytes);
  const edits: Edit[] = [];
  for (const hunk of ld.hunks) {
    for (const edit of editsFromHunk(hunk, oldLines, newLines)) edits.push(edit);
  }
  return edits;
}

function isChange(kind: EditKind): boolean {
  return kind !== 'context';
}

interface Group {
  readonly first: number;
  readonly last: number;
}

function groupChangeIndices(edits: ReadonlyArray<Edit>, minGap: number): ReadonlyArray<Group> {
  const groups: Group[] = [];
  edits.forEach((edit, idx) => {
    if (!isChange(edit.kind)) return;
    const last = groups[groups.length - 1];
    if (last !== undefined && idx - last.last <= minGap) {
      groups[groups.length - 1] = { first: last.first, last: idx };
    } else {
      groups.push({ first: idx, last: idx });
    }
  });
  return groups;
}

interface HunkRange {
  readonly oldStart: number;
  readonly oldLen: number;
  readonly newStart: number;
  readonly newLen: number;
  readonly lastOldIdx: number;
  readonly lastNewIdx: number;
}

function computeRange(slice: ReadonlyArray<Edit>): HunkRange {
  let oldStart = 0;
  let newStart = 0;
  let oldLen = 0;
  let newLen = 0;
  let firstOldSeen = false;
  let firstNewSeen = false;
  let lastOldIdx = -1;
  let lastNewIdx = -1;
  for (const edit of slice) {
    const touchesOld = edit.kind !== 'insert';
    const touchesNew = edit.kind !== 'delete';
    if (touchesOld) {
      if (!firstOldSeen) {
        oldStart = edit.oldIndex + 1;
        firstOldSeen = true;
      }
      oldLen++;
      lastOldIdx = edit.oldIndex;
    }
    if (touchesNew) {
      if (!firstNewSeen) {
        newStart = edit.newIndex + 1;
        firstNewSeen = true;
      }
      newLen++;
      lastNewIdx = edit.newIndex;
    }
  }
  // A group always has at least one change edit, so `slice` is non-empty here.
  if (oldLen === 0) oldStart = slice[0]!.oldIndex;
  if (newLen === 0) newStart = slice[0]!.newIndex;
  return { oldStart, oldLen, newStart, newLen, lastOldIdx, lastNewIdx };
}

interface NoNewlineCtx {
  readonly lastOldIdx: number;
  readonly lastNewIdx: number;
  readonly oldTotal: number;
  readonly newTotal: number;
  readonly oldHasTrailingNewline: boolean;
  readonly newHasTrailingNewline: boolean;
}

function trailingNoNewline(edit: Edit, ctx: NoNewlineCtx): boolean {
  const isLastOld =
    edit.kind !== 'insert' &&
    edit.oldIndex === ctx.lastOldIdx &&
    ctx.lastOldIdx === ctx.oldTotal - 1;
  const isLastNew =
    edit.kind !== 'delete' &&
    edit.newIndex === ctx.lastNewIdx &&
    ctx.lastNewIdx === ctx.newTotal - 1;
  if (edit.kind === 'context') {
    return (isLastOld && !ctx.oldHasTrailingNewline) || (isLastNew && !ctx.newHasTrailingNewline);
  }
  if (edit.kind === 'delete') return isLastOld && !ctx.oldHasTrailingNewline;
  return isLastNew && !ctx.newHasTrailingNewline;
}

function buildHunkFromGroup(
  group: Group,
  edits: ReadonlyArray<Edit>,
  contextLines: number,
  noNewlineCtx: Omit<NoNewlineCtx, 'lastOldIdx' | 'lastNewIdx'>,
): OutputHunk {
  const startIdx = Math.max(0, group.first - contextLines);
  const endIdx = Math.min(edits.length, group.last + contextLines + 1);
  const slice = edits.slice(startIdx, endIdx);
  const range = computeRange(slice);
  const fullCtx: NoNewlineCtx = {
    ...noNewlineCtx,
    lastOldIdx: range.lastOldIdx,
    lastNewIdx: range.lastNewIdx,
  };
  const body: BodyLine[] = slice.map((edit) => ({
    kind: edit.kind,
    text: edit.text,
    trailingNoNewline: trailingNoNewline(edit, fullCtx),
  }));
  return {
    oldStart: range.oldStart,
    oldLen: range.oldLen,
    newStart: range.newStart,
    newLen: range.newLen,
    body,
  };
}

function groupHunks(
  edits: ReadonlyArray<Edit>,
  contextLines: number,
  noNewlineCtx: Omit<NoNewlineCtx, 'lastOldIdx' | 'lastNewIdx'>,
): ReadonlyArray<OutputHunk> {
  if (edits.length === 0) return [];
  const minGap = 2 * contextLines + 1;
  const groups = groupChangeIndices(edits, minGap);
  if (groups.length === 0) return [];
  return groups.map((group) => buildHunkFromGroup(group, edits, contextLines, noNewlineCtx));
}

function prefixOf(kind: EditKind): string {
  if (kind === 'context') return ' ';
  if (kind === 'delete') return '-';
  return '+';
}

function renderHunkBody(body: ReadonlyArray<BodyLine>): string[] {
  const out: string[] = [];
  for (const line of body) {
    out.push(`${prefixOf(line.kind)}${line.text}`);
    if (line.trailingNoNewline) out.push(NO_NEWLINE_MARKER);
  }
  return out;
}

function renderAddBlock(
  change: AddChange,
  content: Uint8Array | undefined,
  prefix: PatchPathPrefix,
): string[] {
  const split = splitContentLines(content);
  const out: string[] = [];
  out.push(diffGitHeader(change.newPath, change.newPath, prefix));
  out.push(`new file mode ${change.newMode}`);
  out.push(`index ${ZERO_OID_ABBREV}..${shortOid(change.newId)}`);
  out.push('--- /dev/null');
  out.push(`+++ ${prefix.new}${change.newPath}`);
  if (split.lines.length === 0) return out;
  out.push(formatHunkHeader(0, 0, 1, split.lines.length));
  for (const line of split.lines) out.push(`+${line}`);
  if (!split.hasTrailingNewline) out.push(NO_NEWLINE_MARKER);
  return out;
}

function renderDeleteBlock(
  change: DeleteChange,
  content: Uint8Array | undefined,
  prefix: PatchPathPrefix,
): string[] {
  const split = splitContentLines(content);
  const out: string[] = [];
  out.push(diffGitHeader(change.oldPath, change.oldPath, prefix));
  out.push(`deleted file mode ${change.oldMode}`);
  out.push(`index ${shortOid(change.oldId)}..${ZERO_OID_ABBREV}`);
  out.push(`--- ${prefix.old}${change.oldPath}`);
  out.push('+++ /dev/null');
  if (split.lines.length === 0) return out;
  out.push(formatHunkHeader(1, split.lines.length, 0, 0));
  for (const line of split.lines) out.push(`-${line}`);
  if (!split.hasTrailingNewline) out.push(NO_NEWLINE_MARKER);
  return out;
}

interface SameKindChange {
  readonly path: string;
  readonly oldId: string;
  readonly newId: string;
  readonly oldMode: string;
  readonly newMode: string;
}

function changeToCommon(change: ModifyChange | TypeChangeChange): SameKindChange {
  return {
    path: change.path,
    oldId: change.oldId,
    newId: change.newId,
    oldMode: change.oldMode,
    newMode: change.newMode,
  };
}

function modePreamble(common: SameKindChange): string[] {
  if (common.oldMode === common.newMode) {
    return [`index ${shortOid(common.oldId)}..${shortOid(common.newId)} ${common.newMode}`];
  }
  return [
    `old mode ${common.oldMode}`,
    `new mode ${common.newMode}`,
    `index ${shortOid(common.oldId)}..${shortOid(common.newId)}`,
  ];
}

function renderBinaryBody(
  common: SameKindChange,
  prefix: PatchPathPrefix,
  oldBytes: Uint8Array,
  newBytes: Uint8Array,
): string[] {
  const oldLabel = oldBytes.length === 0 ? '/dev/null' : `${prefix.old}${common.path}`;
  const newLabel = newBytes.length === 0 ? '/dev/null' : `${prefix.new}${common.path}`;
  return [`Binary files ${oldLabel} and ${newLabel} differ`];
}

function renderTextBody(
  common: SameKindChange,
  prefix: PatchPathPrefix,
  oldBytes: Uint8Array,
  newBytes: Uint8Array,
  contextLines: number,
): string[] {
  const oldSplit = splitContentLines(oldBytes);
  const newSplit = splitContentLines(newBytes);
  const edits = buildEdits(oldSplit.lines, newSplit.lines, oldBytes, newBytes);
  const hunks = groupHunks(edits, contextLines, {
    oldTotal: oldSplit.lines.length,
    newTotal: newSplit.lines.length,
    oldHasTrailingNewline: oldSplit.hasTrailingNewline,
    newHasTrailingNewline: newSplit.hasTrailingNewline,
  });
  const out: string[] = [];
  out.push(`--- ${prefix.old}${common.path}`);
  out.push(`+++ ${prefix.new}${common.path}`);
  for (const hunk of hunks) {
    out.push(formatHunkHeader(hunk.oldStart, hunk.oldLen, hunk.newStart, hunk.newLen));
    for (const line of renderHunkBody(hunk.body)) out.push(line);
  }
  return out;
}

function renderSameKindBlock(
  common: SameKindChange,
  prefix: PatchPathPrefix,
  oldBytes: Uint8Array,
  newBytes: Uint8Array,
  contextLines: number,
): string[] {
  const out: string[] = [];
  out.push(diffGitHeader(common.path, common.path, prefix));
  for (const line of modePreamble(common)) out.push(line);
  if (common.oldId === common.newId) return out;
  if (isBinary(oldBytes) || isBinary(newBytes)) {
    for (const line of renderBinaryBody(common, prefix, oldBytes, newBytes)) out.push(line);
    return out;
  }
  for (const line of renderTextBody(common, prefix, oldBytes, newBytes, contextLines))
    out.push(line);
  return out;
}

function renderModifyOrTypeChangeBlock(
  change: ModifyChange | TypeChangeChange,
  oldBytes: Uint8Array,
  newBytes: Uint8Array,
  prefix: PatchPathPrefix,
  contextLines: number,
): string[] {
  return renderSameKindBlock(changeToCommon(change), prefix, oldBytes, newBytes, contextLines);
}

function renderRenameBlock(change: RenameChange, prefix: PatchPathPrefix): string[] {
  return [
    diffGitHeader(change.oldPath, change.newPath, prefix),
    'similarity index 100%',
    `rename from ${change.oldPath}`,
    `rename to ${change.newPath}`,
  ];
}

function renderAddBinary(change: AddChange, prefix: PatchPathPrefix): string[] {
  return [
    diffGitHeader(change.newPath, change.newPath, prefix),
    `new file mode ${change.newMode}`,
    `index ${ZERO_OID_ABBREV}..${shortOid(change.newId)}`,
    `Binary files /dev/null and ${prefix.new}${change.newPath} differ`,
  ];
}

function renderDeleteBinary(change: DeleteChange, prefix: PatchPathPrefix): string[] {
  return [
    diffGitHeader(change.oldPath, change.oldPath, prefix),
    `deleted file mode ${change.oldMode}`,
    `index ${shortOid(change.oldId)}..${ZERO_OID_ABBREV}`,
    `Binary files ${prefix.old}${change.oldPath} and /dev/null differ`,
  ];
}

function renderFile(file: PatchFile, prefix: PatchPathPrefix, contextLines: number): string[] {
  const change = file.change;
  if (change.type === 'add') {
    const newBytes = file.newContent ?? new Uint8Array(0);
    if (isBinary(newBytes)) return renderAddBinary(change, prefix);
    return renderAddBlock(change, file.newContent, prefix);
  }
  if (change.type === 'delete') {
    const oldBytes = file.oldContent ?? new Uint8Array(0);
    if (isBinary(oldBytes)) return renderDeleteBinary(change, prefix);
    return renderDeleteBlock(change, file.oldContent, prefix);
  }
  if (change.type === 'rename') return renderRenameBlock(change, prefix);
  // `modify` and `type-change` share the same body shape (mode preamble +
  // optional content body); the discriminated union is exhaustive — no
  // fallthrough branch exists for the type system to flag.
  return renderModifyOrTypeChangeBlock(
    change,
    file.oldContent ?? new Uint8Array(0),
    file.newContent ?? new Uint8Array(0),
    prefix,
    contextLines,
  );
}

function resolveContextLines(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CONTEXT_LINES;
  if (!Number.isInteger(value) || value < 0) {
    throw invalidDiffInput(`contextLines must be a non-negative integer; got ${value}`);
  }
  return value;
}

export function renderPatch(files: ReadonlyArray<PatchFile>, opts?: PatchOptions): string {
  const contextLines = resolveContextLines(opts?.contextLines);
  if (files.length === 0) return '';
  const prefix = opts?.pathPrefix ?? DEFAULT_PREFIX;
  for (const file of files) assertSafePaths(file.change, prefix);
  const lines: string[] = [];
  for (const file of files) {
    const block = renderFile(file, prefix, contextLines);
    for (const line of block) lines.push(line);
  }
  // Every render*Block produces at least the `diff --git` header line, so by
  // the time we reach here `lines` is non-empty whenever `files` is non-empty.
  lines.push('');
  return lines.join('\n');
}
