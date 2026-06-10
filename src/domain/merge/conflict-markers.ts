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

/**
 * Serialise a two-way conflict region. Labels are written **verbatim**, exactly
 * as git does — the library emits the bytes git would and leaves any display-time
 * sanitisation to the consumer (ADR-249). Only the content-size cap and the
 * unsupported `diff3` style are refused; the markers scale to `options.markerSize`
 * (git's `conflict-marker-size`, default 7).
 */
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

  const contentSize = sumBytes(oursLines) + sumBytes(theirsLines);
  if (contentSize > MAX_CONFLICT_OUTPUT_BYTES) {
    throw invalidMergeInput('conflict output exceeds MAX_CONFLICT_OUTPUT_BYTES');
  }

  const size = options.markerSize ?? DEFAULT_MARKER_SIZE;
  const openMarker = encoder.encode(`${'<'.repeat(size)} ${oursLabel}\n`);
  const separator = encoder.encode(`${'='.repeat(size)}\n`);
  const closeMarker = encoder.encode(`${'>'.repeat(size)} ${theirsLabel}\n`);
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
