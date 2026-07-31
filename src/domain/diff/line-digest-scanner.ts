import { BINARY_DETECTION_BYTES } from './line-diff.js';
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
}

export type ScanStep =
  | { readonly kind: 'digest'; readonly digest: LineDigest }
  | { readonly kind: 'needs-input' } // only reachable before end()
  | { readonly kind: 'exhausted' }; // EOF *or* binary — the caller reads `.binary`

/** Mutable scanner state: the current chunk reference and per-side scan
 *  progress. */
interface ScannerState {
  chunk: Uint8Array;
  cursor: number;
  ended: boolean;
  nulScanOffset: number;
  binary: boolean;
}

function createScannerState(): ScannerState {
  return {
    chunk: EMPTY_CHUNK,
    cursor: 0,
    ended: false,
    nulScanOffset: 0,
    binary: false,
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

function emitLine(fold: LineDigestFold): ScanStep {
  return { kind: 'digest', digest: fold.endLine() };
}

// Advances the fold from the cursor to the next LF, to the end of the
// current chunk, or — once ended() — to the final unterminated line.
function advanceLine(state: ScannerState, fold: LineDigestFold): ScanStep {
  while (state.cursor < state.chunk.length) {
    const byte = state.chunk[state.cursor]!;
    state.cursor++;
    if (fold.push(byte)) return emitLine(fold);
  }
  if (!state.ended) return { kind: 'needs-input' };
  return fold.lineHasBytes ? emitLine(fold) : { kind: 'exhausted' };
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
    if (!ignoreBlankLines || !digestIsBlank(outcome.digest)) return outcome;
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
  };
}
