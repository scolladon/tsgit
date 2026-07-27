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
  lfScanFrom: number;
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
    lfScanFrom: 0,
    currentLineBytes: 0,
    lineCount: 0,
    binary: false,
  };
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  // NOTE: the ConditionalExpression variant forcing this guard to `false` is
  // equivalent — skipping the shortcut still produces byte-identical output:
  // `out.set(a, 0)` is a no-op when a.length===0, so `out` ends up holding
  // exactly b's bytes either way. Left unannotated because the opposite
  // variant (`true`) is a real, killed mutant on this same line (it would
  // always return `b`, including when `a` is non-empty), and Stryker's
  // next-line disable matches by mutator+line, not by which boolean value.
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// Mirrors line-diff.ts's hasNulInWindow, applied incrementally across chunks.
function scanForNul(state: LineSourceState, chunk: Uint8Array): void {
  // NOTE: forcing this guard's ConditionalExpression to `true`, or relaxing
  // its EqualityOperator to `<=`, are both equivalent once nulScanOffset
  // reaches BINARY_DETECTION_BYTES: `end` below becomes
  // `Math.min(chunk.length, <= 0)`, which is <= 0 either way, so the scan
  // loop never executes regardless of whether this guard fired. Left
  // unannotated because the opposite-direction variants (`false`, `>=`) are
  // real, killed mutants on this same line, and Stryker's next-line disable
  // matches by mutator+line, not by which variant.
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
  // NOTE: forcing this guard's ConditionalExpression to `true` is
  // equivalent — this call is always the LAST trackLineCaps invocation for
  // a given line (only the final, unterminated line reaches it via the
  // exhausted branch below), so currentLineBytes is never read again
  // regardless of whether it's reset here. Left unannotated because the
  // opposite variant (`false`, never resetting) is a real, killed mutant on
  // this same line (it lets multiple SHORT terminated lines' bytes
  // accumulate past MAX_LINE_BYTES), and Stryker's next-line disable
  // matches by mutator+line, not by which variant.
  if (terminated) state.currentLineBytes = 0;
}

function takeLine(state: LineSourceState, length: number, terminated: boolean): Uint8Array {
  const line = state.buffer.subarray(0, length);
  state.buffer = state.buffer.subarray(length);
  state.lfScanFrom = 0;
  trackLineCaps(state, line.length, terminated);
  return line;
}

/** Pull the next complete line (LF included) from the stream, or `undefined` at EOF. */
async function nextLine(state: LineSourceState): Promise<Uint8Array | undefined> {
  for (;;) {
    // Resume the LF scan where the last one stopped — never rescan bytes a
    // previous chunk already cleared, or a long line degrades to O(n²).
    const lfAt = state.buffer.indexOf(LF, state.lfScanFrom);
    if (lfAt !== -1) return takeLine(state, lfAt + 1, true);
    state.lfScanFrom = state.buffer.length;
    // Enforce the line cap on the PENDING unterminated bytes, not only at
    // line completion: a single multi-MB line (minified bundle, one-line
    // JSON) would otherwise buffer the whole blob before the cap could
    // fire. The final line would exceed the cap anyway, so the binary
    // verdict is unchanged — this only fires it early.
    // Stryker disable next-line ArithmeticOperator,BlockStatement: equivalent — this whole check is a pending-bytes short-circuit only (see above): disabling it via either mutator just delays the cap to the completed line's own trackLineCaps call, since `buffer.length` only grows until the line completes (LF found or EOF); the final verdict is unchanged, exactly as this function's own comment documents.
    // NOTE: the same reasoning makes the ConditionalExpression (`false`) and EqualityOperator (`>`) variants on this line equivalent too, but they're left unannotated because their opposite-direction siblings (`true`, `<`) are real, killed mutants, and Stryker's next-line disable matches by mutator+line, not by which variant.
    if (state.currentLineBytes + state.buffer.length >= MAX_LINE_BYTES) {
      state.binary = true;
      return undefined;
    }
    if (state.exhausted) {
      // Stryker disable next-line BooleanLiteral: equivalent — this `terminated` argument only feeds trackLineCaps' reset-after-terminated-line branch, and this call is always the LAST line ever returned (the exhausted-EOF branch); currentLineBytes is never read again afterward, so mislabeling it `true` has no observable effect.
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
