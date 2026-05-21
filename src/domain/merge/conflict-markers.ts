import { invalidMergeInput } from './error.js';
import type { ConflictMarkerOptions } from './merge-types.js';
import { MAX_CONFLICT_OUTPUT_BYTES } from './merge-types.js';

const OURS_MARKER = '<<<<<<<';
const BASE_MARKER = '|||||||';
const SEPARATOR_MARKER = '=======';
const THEIRS_MARKER = '>>>>>>>';
const FORBIDDEN_SUBSTRINGS = [OURS_MARKER, SEPARATOR_MARKER, THEIRS_MARKER, BASE_MARKER];
const MAX_LABEL_LENGTH = 255;

const encoder = new TextEncoder();
const LF = 0x0a;

type LabelSide = 'ours' | 'base' | 'theirs';

function isControlCode(code: number): boolean {
  // C0 controls U+0000–U+001F, plus DEL and C1 controls U+007F–U+009F.
  // `code` comes from charCodeAt so it is always >= 0 (or NaN, for which every
  // comparison is false) — the lower `>= 0x00` bound is redundant and omitted.
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function isBidiOrInvisible(code: number): boolean {
  // Unicode bidi overrides U+202A–U+202E, bidi isolates U+2066–U+2069,
  // and invisible formatting: ZWNJ U+200C, ZWJ U+200D, WORD JOINER U+2060.
  return (
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x200b ||
    code === 0x200c ||
    code === 0x200d ||
    code === 0x2060 ||
    code === 0xfeff
  );
}

function hasForbiddenChar(label: string): boolean {
  // Stryker disable next-line EqualityOperator: equivalent — at i === label.length, charCodeAt returns NaN; isControlCode/isBidiOrInvisible(NaN) are both false, so the extra iteration changes nothing
  for (let i = 0; i < label.length; i++) {
    const code = label.charCodeAt(i);
    if (isControlCode(code) || isBidiOrInvisible(code)) return true;
  }
  return false;
}

function hasMarkerSubstring(label: string): boolean {
  for (const marker of FORBIDDEN_SUBSTRINGS) {
    if (label.includes(marker)) return true;
  }
  return false;
}

function validateLabel(label: string, which: LabelSide): void {
  if (label.length > MAX_LABEL_LENGTH) {
    throw invalidMergeInput(`conflict marker ${which} label exceeds maximum length`);
  }
  if (label.trim() === '') {
    throw invalidMergeInput(`conflict marker ${which} label is empty or whitespace-only`);
  }
  if (hasForbiddenChar(label)) {
    throw invalidMergeInput(`conflict marker ${which} label contains forbidden control character`);
  }
  if (hasMarkerSubstring(label)) {
    throw invalidMergeInput(`conflict marker ${which} label contains forbidden marker substring`);
  }
}

function sumBytes(lines: ReadonlyArray<Uint8Array>): number {
  let total = 0;
  for (const line of lines) total += line.length;
  return total;
}

function concatEnsuringTrailingLf(lines: ReadonlyArray<Uint8Array>): Uint8Array {
  if (lines.length === 0) return new Uint8Array(0);
  const inner = sumBytes(lines);
  const last = lines[lines.length - 1]!;
  // Stryker disable next-line ConditionalExpression: equivalent — when last.length === 0, last[-1] is undefined and undefined !== LF is true, so the right operand already yields true
  const needsLf = last.length === 0 || last[last.length - 1] !== LF;
  const block = new Uint8Array(inner + (needsLf ? 1 : 0));
  let offset = 0;
  for (const line of lines) {
    block.set(line, offset);
    offset += line.length;
  }
  // Stryker disable next-line ConditionalExpression: equivalent — when needsLf is false, offset === block.length, so the out-of-bounds typed-array write is a silent no-op
  if (needsLf) block[offset] = LF;
  return block;
}

export function writeConflictMarkers(
  oursLines: ReadonlyArray<Uint8Array>,
  theirsLines: ReadonlyArray<Uint8Array>,
  options: ConflictMarkerOptions = {},
): Uint8Array {
  if (options.conflictStyle === 'diff3') {
    throw invalidMergeInput('diff3 conflict style requires base lines — not supported in v1');
  }

  const oursLabel = options.labels?.ours ?? 'ours';
  const theirsLabel = options.labels?.theirs ?? 'theirs';
  validateLabel(oursLabel, 'ours');
  validateLabel(theirsLabel, 'theirs');
  if (options.labels?.base !== undefined) {
    validateLabel(options.labels.base, 'base');
  }

  const contentSize = sumBytes(oursLines) + sumBytes(theirsLines);
  if (contentSize > MAX_CONFLICT_OUTPUT_BYTES) {
    throw invalidMergeInput('conflict output exceeds MAX_CONFLICT_OUTPUT_BYTES');
  }

  const openMarker = encoder.encode(`<<<<<<< ${oursLabel}\n`);
  const separator = encoder.encode('=======\n');
  const closeMarker = encoder.encode(`>>>>>>> ${theirsLabel}\n`);
  const oursBlock = concatEnsuringTrailingLf(oursLines);
  const theirsBlock = concatEnsuringTrailingLf(theirsLines);

  const total =
    openMarker.length +
    oursBlock.length +
    separator.length +
    theirsBlock.length +
    closeMarker.length;
  const output = new Uint8Array(total);
  let offset = 0;
  output.set(openMarker, offset);
  offset += openMarker.length;
  output.set(oursBlock, offset);
  offset += oursBlock.length;
  output.set(separator, offset);
  offset += separator.length;
  output.set(theirsBlock, offset);
  offset += theirsBlock.length;
  output.set(closeMarker, offset);
  return output;
}
