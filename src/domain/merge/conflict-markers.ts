import { concatBytes } from '../objects/encoding.js';
import { invalidMergeInput } from './error.js';
import type { ConflictMarkerOptions } from './merge-types.js';
import { MAX_CONFLICT_OUTPUT_BYTES } from './merge-types.js';

/** git's `DEFAULT_CONFLICT_MARKER_SIZE` — the marker run length when none is given. */
const DEFAULT_MARKER_SIZE = 7;

const encoder = new TextEncoder();
const LF = 0x0a;

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

/** One marker line: the run, then ` <label>` when the label is non-empty (git's `marker_size`). */
const markerLine = (char: string, size: number, label: string): Uint8Array =>
  encoder.encode(`${char.repeat(size)}${label === '' ? '' : ` ${label}`}\n`);

/** The base section a base-showing style writes between ours and the separator. */
interface BaseSection {
  readonly lines: ReadonlyArray<Uint8Array>;
  readonly label: string;
}

function assertWithinCap(blocks: ReadonlyArray<ReadonlyArray<Uint8Array>>): void {
  const contentSize = blocks.reduce((total, lines) => total + sumBytes(lines), 0);
  if (contentSize > MAX_CONFLICT_OUTPUT_BYTES) {
    throw invalidMergeInput('conflict output exceeds MAX_CONFLICT_OUTPUT_BYTES');
  }
}

/** git's `fill_conflict_hunk`: ours, the base section when shown, then theirs, each fenced. */
function conflictHunk(
  oursLines: ReadonlyArray<Uint8Array>,
  theirsLines: ReadonlyArray<Uint8Array>,
  options: ConflictMarkerOptions,
  base: BaseSection | undefined,
): Uint8Array {
  const size = options.markerSize ?? DEFAULT_MARKER_SIZE;
  const parts = [
    markerLine('<', size, options.labels?.ours ?? 'ours'),
    concatEnsuringTrailingLf(oursLines),
  ];
  if (base !== undefined) {
    parts.push(markerLine('|', size, base.label), concatEnsuringTrailingLf(base.lines));
  }
  parts.push(
    encoder.encode(`${'='.repeat(size)}\n`),
    concatEnsuringTrailingLf(theirsLines),
    markerLine('>', size, options.labels?.theirs ?? 'theirs'),
  );
  return concatBytes(parts);
}

/**
 * Serialise a two-way conflict region. Labels are written **verbatim**, exactly
 * as git does — the library emits the bytes git would and leaves any display-time
 * sanitisation to the consumer (ADR-249). Only the content-size cap and a
 * base-showing style (which needs the base lines this writer is not given) are
 * refused; the markers scale to `options.markerSize` (git's `conflict-marker-size`, default 7).
 */
export function writeConflictMarkers(
  oursLines: ReadonlyArray<Uint8Array>,
  theirsLines: ReadonlyArray<Uint8Array>,
  options: ConflictMarkerOptions = {},
): Uint8Array {
  if (options.conflictStyle === 'diff3' || options.conflictStyle === 'zdiff3') {
    throw invalidMergeInput(`${options.conflictStyle} conflict style requires base lines`);
  }
  assertWithinCap([oursLines, theirsLines]);
  return conflictHunk(oursLines, theirsLines, options, undefined);
}

/** A conflict region of a base-showing style: the base lines sit under a `|||||||` marker. */
export function writeBaseShowingConflictMarkers(
  oursLines: ReadonlyArray<Uint8Array>,
  baseLines: ReadonlyArray<Uint8Array>,
  theirsLines: ReadonlyArray<Uint8Array>,
  options: ConflictMarkerOptions,
): Uint8Array {
  assertWithinCap([oursLines, baseLines, theirsLines]);
  return conflictHunk(oursLines, theirsLines, options, {
    lines: baseLines,
    label: options.labels?.base ?? '',
  });
}
