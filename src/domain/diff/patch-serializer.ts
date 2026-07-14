import type {
  AddChange,
  CopyChange,
  DeleteChange,
  DiffChange,
  ModifyChange,
  RenameChange,
  TypeChangeChange,
} from './diff-change.js';
import { invalidDiffInput } from './error.js';
import { diffLines, isBinary, type LineHunk, splitLines } from './line-diff.js';
import { MAX_SCORE, toSimilarityPercent } from './similarity.js';
import { isBlankLine, type LineKey, NONE_KEY } from './whitespace.js';

export interface PatchFile {
  readonly change: DiffChange;
  readonly oldContent?: Uint8Array;
  readonly newContent?: Uint8Array;
  /** Override the binary-vs-text decision for the PATCH surface. `'binary'` forces the
   *  `Binary files … differ` / binary-body branch; `'text'` forces the text-hunk branch
   *  even over NUL content; `undefined` uses the default `isBinary` content-sniff. */
  readonly patchBinaryOverride?: 'binary' | 'text';
  /** Override the numstat decision (consumed by computeStatFields via diff-trees, NOT by
   *  this serializer). Carried on PatchFile so a single resolve pass attaches both. */
  readonly numstatBinaryOverride?: 'binary' | 'text';
}

export interface PatchPathPrefix {
  readonly old: string;
  readonly new: string;
}

export interface PatchOptions {
  readonly contextLines?: number;
  readonly pathPrefix?: PatchPathPrefix;
  readonly lineKey?: LineKey;
  readonly ignoreBlankLines?: boolean;
}

interface EmitOptions {
  readonly lineKey?: LineKey;
  readonly ignoreBlankLines?: boolean;
}

const OID_ABBREV_LENGTH = 7;
const ZERO_OID_ABBREV = '0000000';
const DEFAULT_PREFIX: PatchPathPrefix = { old: 'a/', new: 'b/' };
const DEFAULT_CONTEXT_LINES = 3;
const NO_NEWLINE_MARKER = '\\ No newline at end of file';
const NEWLINE_CODE = 0x0a;

/** Resolve the binary verdict for one side, honouring an optional patch override. */
const sideIsBinary = (bytes: Uint8Array, override: 'binary' | 'text' | undefined): boolean =>
  override === undefined ? isBinary(bytes) : override === 'binary';

// Stryker disable next-line ObjectLiteral: equivalent — TextDecoder's default `fatal` option is already `false`, so `{}` behaves identically to `{ fatal: false }`.
const decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Reject paths and path-prefixes that would break the unified-diff grammar.
 * Tree-object parsers accept any non-`/` byte sequence as an entry name, so
 * a malicious tree could carry a path containing `\n` or `\0`. Without this
 * guard the rendered headers would smuggle extra lines into the document
 * that downstream patch parsers would interpret as forged hunks.
 */
function rejectUnsafePathChars(label: string, value: string): void {
  // Stryker disable next-line EqualityOperator: equivalent — `i <= value.length` adds one extra iteration at `i === value.length`, where `value.charCodeAt(value.length)` is NaN, which never equals any control-character code, so the extra pass is a no-op.
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
  if (change.type === 'rename' || change.type === 'copy') {
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
    // Stryker disable next-line BooleanLiteral: equivalent — `oldTotal`/`newTotal` is 0 whenever this branch runs, so no edit can ever satisfy `oldIndex === oldTotal - 1` (index -1 is impossible); the flag is only read behind that comparison, so its value here is unobservable.
    return { lines: [], hasTrailingNewline: true };
  }
  const rawLines = splitLines(bytes);
  const lines = rawLines.map(stripTrailingLf);
  const hasTrailingNewline = bytes[bytes.length - 1] === NEWLINE_CODE;
  return { lines, hasTrailingNewline };
}

function stripTrailingLf(bytes: Uint8Array): string {
  // Stryker disable next-line EqualityOperator: equivalent — `bytes.length` is never negative, so `>= 0` is always true; when `bytes.length === 0` the right operand `bytes[-1] === NEWLINE_CODE` is `undefined === 10`, always false, so `end` still resolves to `bytes.length` exactly as the `> 0` guard gives.
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

export interface BodyLine {
  readonly kind: EditKind;
  readonly text: string;
  readonly trailingNoNewline: boolean;
}

export interface OutputHunk {
  readonly oldStart: number;
  readonly oldLen: number;
  readonly newStart: number;
  readonly newLen: number;
  readonly body: ReadonlyArray<BodyLine>;
}

function commonEditsFrom(hunk: LineHunk, newLines: ReadonlyArray<string>): Edit[] {
  const edits: Edit[] = [];
  for (let i = hunk.oursStart; i < hunk.oursEnd; i++) {
    // A context line is emitted from the post-image: identical to the pre-image
    // for a byte-exact match, but the new-side bytes when the match is only
    // whitespace-equal under a line-key mode (git emits context from the new side).
    const newIndex = hunk.theirsStart + (i - hunk.oursStart);
    edits.push({
      kind: 'context',
      oldIndex: i,
      newIndex,
      text: newLines[newIndex]!,
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
  if (hunk.kind === 'common') return commonEditsFrom(hunk, newLines);
  if (hunk.kind === 'ours-only') return deleteEditsFrom(hunk, oldLines);
  return insertEditsFrom(hunk, newLines);
}

function suppressBlankGroups(
  edits: ReadonlyArray<Edit>,
  ld: {
    readonly oursLines: ReadonlyArray<Uint8Array>;
    readonly theirsLines: ReadonlyArray<Uint8Array>;
  },
  key: LineKey,
): ReadonlyArray<Edit> {
  return edits.filter((edit) => {
    if (edit.kind === 'context') return true;
    const line =
      edit.kind === 'delete' ? ld.oursLines[edit.oldIndex] : ld.theirsLines[edit.newIndex];
    return line === undefined || !isBlankLine(line, key);
  });
}

function buildEdits(
  oldLines: ReadonlyArray<string>,
  newLines: ReadonlyArray<string>,
  oldBytes: Uint8Array,
  newBytes: Uint8Array,
  emit?: EmitOptions,
): ReadonlyArray<Edit> {
  const ld = diffLines(
    oldBytes,
    newBytes,
    emit?.lineKey !== undefined ? { lineKey: emit.lineKey } : undefined,
  );
  const allEdits: Edit[] = [];
  for (const hunk of ld.hunks) {
    for (const edit of editsFromHunk(hunk, oldLines, newLines)) allEdits.push(edit);
  }
  if (emit?.ignoreBlankLines !== true) return allEdits;
  return suppressBlankGroups(allEdits, ld, emit.lineKey ?? NONE_KEY);
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
  // Stryker disable next-line UnaryOperator: equivalent — this sentinel is only compared via `edit.oldIndex === lastOldIdx`; if no edit in `slice` touches the old side, `isLastOld`'s own `edit.kind !== 'insert'` guard is already false for every edit, so the sentinel's value is never read.
  let lastOldIdx = -1;
  // Stryker disable next-line UnaryOperator: equivalent — symmetric to lastOldIdx above: unread whenever no edit touches the new side, since `isLastNew`'s `edit.kind !== 'delete'` guard is already false in that case.
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
  // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent — for a context edit, `isLastOld && !oldHasTrailingNewline` can only be true when the matched line is the file's true terminal on both sides (a byte-identical context match forces equal trailing-newline state), which forces `isLastNew && !newHasTrailingNewline` true too — so skipping straight to `return isLastNew && !ctx.newHasTrailingNewline` yields the same result as the OR below.
  if (edit.kind === 'context') {
    // Stryker disable next-line LogicalOperator,ConditionalExpression: equivalent — per the proof above, the two operands of this OR are always equal for a context edit, so OR, AND-of-both, and either operand alone agree.
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
  // Stryker disable next-line ConditionalExpression: equivalent — when `edits` is empty, `groupChangeIndices`'s `forEach` is a no-op and returns an empty `groups` array, so the `groups.length === 0` guard below returns `[]` regardless of this early return.
  if (edits.length === 0) return [];
  const minGap = 2 * contextLines + 1;
  const groups = groupChangeIndices(edits, minGap);
  // Stryker disable next-line ConditionalExpression: equivalent — `groups.map(...)` on an empty array already evaluates to `[]`, so removing this early return does not change the result.
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

function changeToCommon(change: ModifyChange): SameKindChange {
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

/**
 * Group the line-level diff of two blobs into unified-diff hunks (the shared
 * core behind both the unified-diff serializer and range-diff's `## ` text). Each
 * hunk carries its old/new line spans and a typed body (`context`/`delete`/
 * `insert`). The `@@ -a,b +c,d @@` line numbers and the body prefixes are the
 * caller's to render.
 */
export function computeHunks(
  oldBytes: Uint8Array,
  newBytes: Uint8Array,
  contextLines: number,
  options?: EmitOptions,
): ReadonlyArray<OutputHunk> {
  const oldSplit = splitContentLines(oldBytes);
  const newSplit = splitContentLines(newBytes);
  const edits = buildEdits(oldSplit.lines, newSplit.lines, oldBytes, newBytes, options);
  return groupHunks(edits, contextLines, {
    oldTotal: oldSplit.lines.length,
    newTotal: newSplit.lines.length,
    oldHasTrailingNewline: oldSplit.hasTrailingNewline,
    newHasTrailingNewline: newSplit.hasTrailingNewline,
  });
}

function renderTextBody(
  common: SameKindChange,
  prefix: PatchPathPrefix,
  oldBytes: Uint8Array,
  newBytes: Uint8Array,
  contextLines: number,
  emit?: EmitOptions,
): string[] {
  const hunks = computeHunks(oldBytes, newBytes, contextLines, emit);
  // Every change blank-suppressed: emit no body so the modify caller drops the
  // whole file (empty document). A non-suppressed empty diff still emits ---/+++.
  if (hunks.length === 0 && emit?.ignoreBlankLines === true) return [];
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
  emit?: EmitOptions,
  override?: 'binary' | 'text',
): string[] {
  if (
    common.oldId !== common.newId &&
    !sideIsBinary(oldBytes, override) &&
    !sideIsBinary(newBytes, override)
  ) {
    const body = renderTextBody(common, prefix, oldBytes, newBytes, contextLines, emit);
    if (body.length === 0) return [];
    const out: string[] = [];
    out.push(diffGitHeader(common.path, common.path, prefix));
    for (const line of modePreamble(common)) out.push(line);
    for (const line of body) out.push(line);
    return out;
  }
  const out: string[] = [];
  out.push(diffGitHeader(common.path, common.path, prefix));
  for (const line of modePreamble(common)) out.push(line);
  if (common.oldId === common.newId) return out;
  for (const line of renderBinaryBody(common, prefix, oldBytes, newBytes)) out.push(line);
  return out;
}

/**
 * Render the block for a broken modify (dissimilarity index <p>% in place of
 * the normal index-line predecessor, then the index line and full D/A hunk).
 * A broken modify is one where -B kept it as a modify with a dissimilarity datum.
 */
function renderBrokenModifyBlock(
  change: ModifyChange & { readonly broken: NonNullable<ModifyChange['broken']> },
  oldBytes: Uint8Array,
  newBytes: Uint8Array,
  prefix: PatchPathPrefix,
  contextLines: number,
  emit?: EmitOptions,
  override?: 'binary' | 'text',
): string[] {
  const broken = change.broken;
  const common = changeToCommon(change);
  const out: string[] = [];
  out.push(diffGitHeader(common.path, common.path, prefix));
  out.push(`dissimilarity index ${toSimilarityPercent(broken.score)}%`);
  // Index line: with mode suffix when oldMode === newMode, without when they differ.
  const base = `index ${shortOid(common.oldId)}..${shortOid(common.newId)}`;
  out.push(common.oldMode === common.newMode ? `${base} ${common.newMode}` : base);
  const body =
    sideIsBinary(oldBytes, override) || sideIsBinary(newBytes, override)
      ? renderBinaryBody(common, prefix, oldBytes, newBytes)
      : renderTextBody(common, prefix, oldBytes, newBytes, contextLines, emit);
  for (const line of body) out.push(line);
  return out;
}

function renderModifyBlock(
  change: ModifyChange,
  oldBytes: Uint8Array,
  newBytes: Uint8Array,
  prefix: PatchPathPrefix,
  contextLines: number,
  emit?: EmitOptions,
  override?: 'binary' | 'text',
): string[] {
  if (change.broken !== undefined) {
    return renderBrokenModifyBlock(
      change as ModifyChange & { readonly broken: NonNullable<ModifyChange['broken']> },
      oldBytes,
      newBytes,
      prefix,
      contextLines,
      emit,
      override,
    );
  }
  return renderSameKindBlock(
    changeToCommon(change),
    prefix,
    oldBytes,
    newBytes,
    contextLines,
    emit,
    override,
  );
}

function renderTypeChangeBlock(
  change: TypeChangeChange,
  oldBytes: Uint8Array,
  newBytes: Uint8Array,
  prefix: PatchPathPrefix,
  override?: 'binary' | 'text',
): string[] {
  // Real git renders a type-change as two separate diff --git blocks:
  // a full deletion of the old kind followed by a full addition of the new kind.
  const deleteChange: DeleteChange = {
    type: 'delete',
    oldPath: change.path,
    oldId: change.oldId,
    oldMode: change.oldMode,
  };
  const addChange: AddChange = {
    type: 'add',
    newPath: change.path,
    newId: change.newId,
    newMode: change.newMode,
  };
  const deleteBlock = sideIsBinary(oldBytes, override)
    ? renderDeleteBinary(deleteChange, prefix)
    : renderDeleteBlock(deleteChange, oldBytes, prefix);
  const addBlock = sideIsBinary(newBytes, override)
    ? renderAddBinary(addChange, prefix)
    : renderAddBlock(addChange, newBytes, prefix);
  return [...deleteBlock, ...addBlock];
}

interface TwoPathChange {
  readonly oldPath: string;
  readonly newPath: string;
  readonly oldId: string;
  readonly newId: string;
  readonly oldMode: string;
  readonly newMode: string;
  readonly similarity: { readonly score: number };
}

function twoPathIndexLine(change: TwoPathChange): string {
  const base = `index ${shortOid(change.oldId)}..${shortOid(change.newId)}`;
  // Mode suffix is present ONLY when old and new modes are equal (matrix #4).
  return change.oldMode === change.newMode ? `${base} ${change.newMode}` : base;
}

function renderTwoPathBody(
  change: TwoPathChange,
  oldBytes: Uint8Array,
  newBytes: Uint8Array,
  prefix: PatchPathPrefix,
  contextLines: number,
  emit?: EmitOptions,
  override?: 'binary' | 'text',
): string[] {
  const out: string[] = [];
  out.push(twoPathIndexLine(change));
  if (sideIsBinary(oldBytes, override) || sideIsBinary(newBytes, override)) {
    out.push(
      `Binary files ${prefix.old}${change.oldPath} and ${prefix.new}${change.newPath} differ`,
    );
    return out;
  }
  const hunks = computeHunks(oldBytes, newBytes, contextLines, emit);
  // Blank-suppressed body: keep the index line, omit ---/+++ and hunks (git keeps the
  // rename/copy header + index when the body vanishes). A non-suppressed empty diff
  // still emits ---/+++.
  if (hunks.length === 0 && emit?.ignoreBlankLines === true) return out;
  out.push(`--- ${prefix.old}${change.oldPath}`);
  out.push(`+++ ${prefix.new}${change.newPath}`);
  for (const hunk of hunks) {
    out.push(formatHunkHeader(hunk.oldStart, hunk.oldLen, hunk.newStart, hunk.newLen));
    for (const line of renderHunkBody(hunk.body)) out.push(line);
  }
  return out;
}

function renderTwoPathBlock(
  change: TwoPathChange,
  keyword: 'rename' | 'copy',
  file: PatchFile,
  prefix: PatchPathPrefix,
  contextLines: number,
  emit?: EmitOptions,
): string[] {
  const header: string[] = [];
  header.push(diffGitHeader(change.oldPath, change.newPath, prefix));
  // Mode preamble PRECEDES the similarity line when modes differ (matrix #4).
  if (change.oldMode !== change.newMode) {
    header.push(`old mode ${change.oldMode}`);
    header.push(`new mode ${change.newMode}`);
  }
  header.push(`similarity index ${toSimilarityPercent(change.similarity.score)}%`);
  header.push(`${keyword} from ${change.oldPath}`);
  header.push(`${keyword} to ${change.newPath}`);
  // Exact (100%): stop here — no index line, no hunk (matrix #5 / #C4).
  if (change.similarity.score === MAX_SCORE) return header;
  const body = renderTwoPathBody(
    change,
    file.oldContent ?? new Uint8Array(0),
    file.newContent ?? new Uint8Array(0),
    prefix,
    contextLines,
    emit,
    file.patchBinaryOverride,
  );
  return [...header, ...body];
}

function renderRenameBlock(
  change: RenameChange,
  file: PatchFile,
  prefix: PatchPathPrefix,
  contextLines: number,
  emit?: EmitOptions,
): string[] {
  return renderTwoPathBlock(change, 'rename', file, prefix, contextLines, emit);
}

function renderCopyBlock(
  change: CopyChange,
  file: PatchFile,
  prefix: PatchPathPrefix,
  contextLines: number,
  emit?: EmitOptions,
): string[] {
  return renderTwoPathBlock(change, 'copy', file, prefix, contextLines, emit);
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

function renderFile(
  file: PatchFile,
  prefix: PatchPathPrefix,
  contextLines: number,
  emit?: EmitOptions,
): string[] {
  const change = file.change;
  const override = file.patchBinaryOverride;
  if (change.type === 'add') {
    const newBytes = file.newContent ?? new Uint8Array(0);
    if (sideIsBinary(newBytes, override)) return renderAddBinary(change, prefix);
    return renderAddBlock(change, file.newContent, prefix);
  }
  if (change.type === 'delete') {
    const oldBytes = file.oldContent ?? new Uint8Array(0);
    if (sideIsBinary(oldBytes, override)) return renderDeleteBinary(change, prefix);
    return renderDeleteBlock(change, file.oldContent, prefix);
  }
  if (change.type === 'rename') return renderRenameBlock(change, file, prefix, contextLines, emit);
  if (change.type === 'copy') return renderCopyBlock(change, file, prefix, contextLines, emit);
  if (change.type === 'type-change') {
    return renderTypeChangeBlock(
      change,
      file.oldContent ?? new Uint8Array(0),
      file.newContent ?? new Uint8Array(0),
      prefix,
      override,
    );
  }
  // `modify` is the only remaining case; the discriminated union is exhaustive.
  return renderModifyBlock(
    change,
    file.oldContent ?? new Uint8Array(0),
    file.newContent ?? new Uint8Array(0),
    prefix,
    contextLines,
    emit,
    override,
  );
}

function resolveContextLines(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CONTEXT_LINES;
  if (!Number.isInteger(value) || value < 0) {
    throw invalidDiffInput(`contextLines must be a non-negative integer; got ${value}`);
  }
  return value;
}

function buildEmitOptions(opts: PatchOptions | undefined): EmitOptions | undefined {
  if (opts === undefined) return undefined;
  const lineKey = opts.lineKey;
  const ignoreBlankLines = opts.ignoreBlankLines;
  if (lineKey !== undefined && ignoreBlankLines === true) {
    return { lineKey, ignoreBlankLines: true };
  }
  if (lineKey !== undefined) return { lineKey };
  if (ignoreBlankLines === true) return { ignoreBlankLines: true };
  return undefined;
}

export function renderPatch(files: ReadonlyArray<PatchFile>, opts?: PatchOptions): string {
  const contextLines = resolveContextLines(opts?.contextLines);
  // Stryker disable next-line ConditionalExpression: equivalent — an empty `files` array leaves `lines` empty after the loop below, and the `lines.length === 0` guard further down returns `''` regardless of this early return.
  if (files.length === 0) return '';
  const prefix = opts?.pathPrefix ?? DEFAULT_PREFIX;
  for (const file of files) assertSafePaths(file.change, prefix);
  const emit: EmitOptions | undefined = buildEmitOptions(opts);
  const lines: string[] = [];
  for (const file of files) {
    const block = renderFile(file, prefix, contextLines, emit);
    for (const line of block) lines.push(line);
  }
  // When all file blocks are blank-suppressed, lines stays empty and we return ''.
  // Otherwise push the trailing '' separator and join.
  // Stryker disable next-line ConditionalExpression: equivalent — when `lines` is empty the fallthrough pushes one '' and joins, and [''].join('\n') === '' === [].join('\n'), so both branches return ''.
  if (lines.length === 0) return '';
  lines.push('');
  return lines.join('\n');
}
