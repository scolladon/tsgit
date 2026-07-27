/**
 * Streaming drop-pass predicate for the whitespace/CR-at-eol diff modes.
 *
 * Answers "does any significant change survive normalization?" for one
 * `modify` change WITHOUT the full materialise-blobs + line-diff pass: both
 * blobs are streamed via `streamBlob`, scanned raw-byte line-by-line, and
 * folded into a `LineDigest` per line (see `whitespace.ts`) — no string
 * decode, no line-array materialisation. Comparison is positional (line i of
 * old vs line i of new, skipping blank lines under `ignoreBlankLines`) and
 * exits the moment a significant mismatch is found.
 */
import type { ModifyChange } from '../../../domain/diff/diff-change.js';
import {
  BINARY_DETECTION_BYTES,
  MAX_LINE_BYTES,
  MAX_LINES,
} from '../../../domain/diff/line-diff.js';
import {
  digestIsBlank,
  digestNormalizedLine,
  digestsEqual,
  type LineDigest,
  type LineKey,
} from '../../../domain/diff/whitespace.js';
import type { Context } from '../../../ports/context.js';
import { streamBlob } from '../stream-blob.js';

const LF = 0x0a;
const NUL = 0x00;
const EMPTY = new Uint8Array(0);

/** Mutable per-side streaming state: buffered bytes, binary-detection progress. */
interface LineSourceState {
  readonly iterator: AsyncIterator<Uint8Array>;
  buffer: Uint8Array;
  exhausted: boolean;
  nulScanOffset: number;
  currentLineBytes: number;
  lineCount: number;
  binary: boolean;
}

function createLineSourceState(stream: AsyncIterable<Uint8Array>): LineSourceState {
  return {
    iterator: stream[Symbol.asyncIterator](),
    buffer: EMPTY,
    exhausted: false,
    nulScanOffset: 0,
    currentLineBytes: 0,
    lineCount: 0,
    binary: false,
  };
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// Mirrors line-diff.ts's hasNulInWindow, applied incrementally across chunks.
function scanForNul(state: LineSourceState, chunk: Uint8Array): void {
  if (state.nulScanOffset < BINARY_DETECTION_BYTES) {
    const end = Math.min(chunk.length, BINARY_DETECTION_BYTES - state.nulScanOffset);
    for (let i = 0; i < end; i++) {
      if (chunk[i] === NUL) {
        state.binary = true;
        break;
      }
    }
  }
  state.nulScanOffset += chunk.length;
}

// Mirrors line-diff.ts's exceedsLineCaps, aggregated per completed line.
function trackLineCaps(state: LineSourceState, lineLength: number, terminated: boolean): void {
  state.currentLineBytes += lineLength;
  if (state.currentLineBytes >= MAX_LINE_BYTES) state.binary = true;
  state.lineCount++;
  if (state.lineCount >= MAX_LINES) state.binary = true;
  if (terminated) state.currentLineBytes = 0;
}

function takeLine(state: LineSourceState, length: number, terminated: boolean): Uint8Array {
  const line = state.buffer.subarray(0, length);
  state.buffer = state.buffer.subarray(length);
  trackLineCaps(state, line.length, terminated);
  return line;
}

/** Pull the next complete line (LF included) from the stream, or `undefined` at EOF. */
async function nextLine(state: LineSourceState): Promise<Uint8Array | undefined> {
  for (;;) {
    const lfAt = state.buffer.indexOf(LF);
    if (lfAt !== -1) return takeLine(state, lfAt + 1, true);
    if (state.exhausted) {
      return state.buffer.length > 0 ? takeLine(state, state.buffer.length, false) : undefined;
    }
    const step = await state.iterator.next();
    if (step.done === true) {
      state.exhausted = true;
      continue;
    }
    scanForNul(state, step.value);
    state.buffer = concatBytes(state.buffer, step.value);
  }
}

/** Next digest that counts under `ignoreBlankLines` (skipping blank lines), or `undefined` at EOF/binary. */
async function nextSignificantDigest(
  state: LineSourceState,
  key: LineKey,
  ignoreBlankLines: boolean,
): Promise<LineDigest | undefined> {
  for (;;) {
    const line = await nextLine(state);
    if (state.binary || line === undefined) return undefined;
    const digest = digestNormalizedLine(line, key);
    if (!ignoreBlankLines || !digestIsBlank(digest)) return digest;
  }
}

/**
 * `true` when `change` has zero significant lines added/deleted under `key`
 * (and `ignoreBlankLines`) — the streaming equivalent of `shouldDrop` fed by
 * `computeStatFields`. A binary side (NUL-in-window or over the line-count/
 * length caps, matching `isBinary`) is never dropped.
 */
export async function isWhitespaceOnlyModify(
  ctx: Context,
  change: ModifyChange,
  lineKey: LineKey,
  ignoreBlankLines: boolean,
): Promise<boolean> {
  const [oldStream, newStream] = await Promise.all([
    streamBlob(ctx, change.oldId),
    streamBlob(ctx, change.newId),
  ]);
  const oldState = createLineSourceState(oldStream);
  const newState = createLineSourceState(newStream);

  for (;;) {
    const [oldDigest, newDigest] = await Promise.all([
      nextSignificantDigest(oldState, lineKey, ignoreBlankLines),
      nextSignificantDigest(newState, lineKey, ignoreBlankLines),
    ]);
    if (oldState.binary || newState.binary) return false;
    if (oldDigest === undefined && newDigest === undefined) return true;
    if (oldDigest === undefined || newDigest === undefined) return false;
    if (!digestsEqual(oldDigest, newDigest)) return false;
  }
}
