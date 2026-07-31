import { BINARY_DETECTION_BYTES, MAX_LINE_BYTES, MAX_LINES } from './line-diff.js';
import {
  createLineDigestFold,
  digestIsBlank,
  type LineDigest,
  type LineDigestFold,
  type LineKey,
} from './whitespace.js';

const NUL = 0x00;
const EMPTY_CHUNK = new Uint8Array(0);

export interface LineDigestScanner {
  /** Feed the next chunk. Legal before the first `next()` or after a
   *  `needs-input` step — at most one chunk is ever in flight. Runs the
   *  NUL-window scan, then re-seats the fold cursor. The scanner holds a
   *  *reference* to `chunk` until it is consumed; it never copies,
   *  concatenates or accumulates. */
  push(chunk: Uint8Array): void;
  /** No more chunks will arrive. */
  end(): void;
  /** Next significant digest, or why not. Never throws. */
  next(): ScanStep;
  /** NUL in the first BINARY_DETECTION_BYTES — the ONLY binary rule. Once
   *  set, `next()` answers `exhausted`. */
  readonly binary: boolean;
  /** Temporary: today's line-length/line-count rule, applied by the CALLER,
   *  so the performance commit reproduces today's verdicts exactly.
   *  Deliberately does NOT stop `next()`. */
  readonly capsExceeded: boolean;
}

export type ScanStep =
  | { readonly kind: 'digest'; readonly digest: LineDigest }
  | { readonly kind: 'needs-input' } // only reachable before end()
  | { readonly kind: 'exhausted' }; // EOF *or* binary — the caller reads `.binary`

/** Mutable scanner state: the current chunk reference, per-side scan
 *  progress and the temporary cap-observation counters. */
interface ScannerState {
  chunk: Uint8Array;
  cursor: number;
  ended: boolean;
  nulScanOffset: number;
  binary: boolean;
  lineRawLength: number;
  currentLineBytes: number;
  lineCount: number;
  capsExceeded: boolean;
}

function createScannerState(): ScannerState {
  return {
    chunk: EMPTY_CHUNK,
    cursor: 0,
    ended: false,
    nulScanOffset: 0,
    binary: false,
    lineRawLength: 0,
    currentLineBytes: 0,
    lineCount: 0,
    capsExceeded: false,
  };
}

// Mirrors line-diff.ts's hasNulInWindow, applied incrementally across chunks.
function scanForNul(state: ScannerState, chunk: Uint8Array): void {
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

// Reproduces today's line-length/line-count cap verdicts, applied once per
// completed line (at emit, not at the first over-cap byte). Temporary — see
// the `capsExceeded` doc comment above.
function updateCaps(state: ScannerState, lineLength: number, terminated: boolean): void {
  state.currentLineBytes += lineLength;
  if (state.currentLineBytes >= MAX_LINE_BYTES) state.capsExceeded = true;
  state.lineCount++;
  if (state.lineCount >= MAX_LINES) state.capsExceeded = true;
  if (terminated) state.currentLineBytes = 0;
}

type AdvanceOutcome =
  | {
      readonly kind: 'digest';
      readonly digest: LineDigest;
      readonly rawLength: number;
      /** Whether this line actually ended in an LF byte — the raw boundary
       *  signal, independent of `digest.terminated` (which C4 suppresses
       *  under an active key for equality purposes only). The cap tracker
       *  needs the true boundary to know when a logical line ended. */
      readonly rawTerminated: boolean;
    }
  | { readonly kind: 'needs-input' }
  | { readonly kind: 'exhausted' };

function emitLine(
  state: ScannerState,
  fold: LineDigestFold,
  rawTerminated: boolean,
): AdvanceOutcome {
  const digest = fold.endLine();
  const rawLength = state.lineRawLength;
  state.lineRawLength = 0;
  return { kind: 'digest', digest, rawLength, rawTerminated };
}

// Advances the fold from the cursor to the next LF, to the end of the
// current chunk, or — once ended() — to the final unterminated line.
function advanceLine(state: ScannerState, fold: LineDigestFold): AdvanceOutcome {
  while (state.cursor < state.chunk.length) {
    const byte = state.chunk[state.cursor]!;
    state.cursor++;
    state.lineRawLength++;
    if (fold.push(byte)) return emitLine(state, fold, true);
  }
  if (!state.ended) return { kind: 'needs-input' };
  return fold.lineHasBytes ? emitLine(state, fold, false) : { kind: 'exhausted' };
}

function computeNextStep(
  state: ScannerState,
  fold: LineDigestFold,
  ignoreBlankLines: boolean,
): ScanStep {
  for (;;) {
    if (state.binary) return { kind: 'exhausted' };
    const outcome = advanceLine(state, fold);
    if (outcome.kind !== 'digest') return outcome;
    updateCaps(state, outcome.rawLength, outcome.rawTerminated);
    if (!ignoreBlankLines || !digestIsBlank(outcome.digest)) {
      return { kind: 'digest', digest: outcome.digest };
    }
  }
}

/**
 * A synchronous, chunk-fed scanner over one blob's significant line digests.
 * Feeds chunks through the incremental digest fold (`whitespace.ts`) and the
 * NUL-window binary check, never buffering or accumulating the blob.
 */
export function createLineDigestScanner(
  key: LineKey,
  ignoreBlankLines: boolean,
): LineDigestScanner {
  const fold = createLineDigestFold(key);
  const state = createScannerState();

  return {
    push(chunk: Uint8Array): void {
      scanForNul(state, chunk);
      state.chunk = chunk;
      state.cursor = 0;
    },
    end(): void {
      state.ended = true;
    },
    next(): ScanStep {
      return computeNextStep(state, fold, ignoreBlankLines);
    },
    get binary(): boolean {
      return state.binary;
    },
    get capsExceeded(): boolean {
      return state.capsExceeded;
    },
  };
}
