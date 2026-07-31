import { type BinaryOverride, forcesBinary, sniffDecides } from './binary-decision.js';
import { BINARY_DETECTION_BYTES, splitLines } from './line-diff.js';
import {
  createLineDigestFold,
  digestIsBlank,
  digestsEqual,
  isBlankLine,
  type LineDigest,
  type LineDigestFold,
  type LineKey,
  linesEqualUnder,
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
  /** The side's binary verdict: the path's `diff` attribute when it decided
   *  one (`binary-decision.ts`), otherwise NUL in the first
   *  BINARY_DETECTION_BYTES. Once set, `next()` answers `exhausted`. */
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

function createScannerState(binaryOverride: BinaryOverride | undefined): ScannerState {
  return {
    chunk: EMPTY_CHUNK,
    cursor: 0,
    ended: false,
    nulScanOffset: 0,
    binary: forcesBinary(binaryOverride),
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
 *
 * `binaryOverride` carries the path's `diff` attribute verdict: a forced-binary
 * side is binary before a byte is read, and a forced-text side never runs the
 * NUL scan at all — the sniff is suppressed here, not merely second-guessed by
 * a caller, so a forced-text NUL-bearing blob really does compare as text.
 */
export function createLineDigestScanner(
  key: LineKey,
  ignoreBlankLines: boolean,
  binaryOverride?: BinaryOverride,
): LineDigestScanner {
  const fold = createLineDigestFold(key);
  const state = createScannerState(binaryOverride);
  const sniffs = sniffDecides(binaryOverride);

  return {
    push(chunk: Uint8Array): void {
      if (sniffs) scanForNul(state, chunk);
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

export type LadderVerdict = boolean | 'continue';

/**
 * The shared verdict ladder every drop-verdict comparison drives — the
 * predicate's buffered and streamed arms, and the stat path's `scanEqual`.
 * Binary precedes the digest comparison on purpose: an emitted-then-flagged
 * line must never let a `true` verdict slip through before the flag is
 * observed. One ladder, one place, so the different comparison shapes that
 * feed it cannot answer differently for the same bytes.
 *
 * `false` is FINAL — a digest mismatch, a binary side or a line-count mismatch
 * each prove a difference outright. `true` is NOT: it rests on digest evidence,
 * which chosen input can forge. Every caller owes a `true` an exact
 * confirmation over the real bytes before it drops anything from a diff
 * (`contentsEqualUnder` here; `confirmStreamedEqual` on the streamed arm).
 */
export function applyLadder(
  oldScanner: LineDigestScanner,
  newScanner: LineDigestScanner,
  oldStep: ScanStep,
  newStep: ScanStep,
): LadderVerdict {
  if (oldScanner.binary || newScanner.binary) {
    return false;
  }
  const oldDigest = oldStep.kind === 'digest' ? oldStep.digest : undefined;
  const newDigest = newStep.kind === 'digest' ? newStep.digest : undefined;
  if (oldDigest === undefined && newDigest === undefined) return true;
  if (oldDigest === undefined || newDigest === undefined) return false;
  if (!digestsEqual(oldDigest, newDigest)) return false;
  return 'continue';
}

// Index of the next line at or after `from` that the key counts as
// significant. With ignoreBlankLines off every line counts, so the scan is
// skipped entirely rather than run over a predicate that can never fire.
function nextSignificant(
  lines: ReadonlyArray<Uint8Array>,
  from: number,
  key: LineKey,
  ignoreBlankLines: boolean,
): number {
  if (!ignoreBlankLines) return from;
  let index = from;
  while (index < lines.length && isBlankLine(lines[index] as Uint8Array, key)) index++;
  return index;
}

/**
 * What "equal" actually means for a drop verdict: the two sides' significant
 * lines, compared as NORMALIZED BYTES, in order. The digest ladder above only
 * ever proves a DIFFERENCE cheaply; a genuinely changed file must never
 * disappear from a diff because two narrow FNV chains were made to agree, and
 * a chosen-input multicollision over them costs an attacker seconds.
 *
 * Reached only when the ladder is about to answer `true`, so the dominant
 * "differs" path never pays for it and still returns on the first mismatching
 * digest.
 */
function contentsEqualUnder(
  oldContent: Uint8Array,
  newContent: Uint8Array,
  key: LineKey,
  ignoreBlankLines: boolean,
): boolean {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  let oldIndex = nextSignificant(oldLines, 0, key, ignoreBlankLines);
  let newIndex = nextSignificant(newLines, 0, key, ignoreBlankLines);
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    const oldLine = oldLines[oldIndex] as Uint8Array;
    const newLine = newLines[newIndex] as Uint8Array;
    if (!linesEqualUnder(oldLine, newLine, key)) return false;
    oldIndex = nextSignificant(oldLines, oldIndex + 1, key, ignoreBlankLines);
    newIndex = nextSignificant(newLines, newIndex + 1, key, ignoreBlankLines);
  }
  return oldIndex === oldLines.length && newIndex === newLines.length;
}

/**
 * Fully synchronous whole-buffer comparison: pushes each side's entire
 * content into its own scanner, then drives the shared ladder to a verdict.
 * The predicate's buffered arm and the stat path's drop verdict both call
 * this directly, so a pair of blobs compares identically however it was
 * reached — one function, not two independently maintained copies.
 * `binaryOverride` is threaded into both scanners, so an attribute-decided
 * path is answered by the same single binary decision the counts use.
 *
 * Both blobs are already resident here, so the ladder's `true` is confirmed
 * against their bytes on the spot — no re-read, and nothing extra on the
 * "differs" path.
 */
export function scanEqual(
  oldContent: Uint8Array,
  newContent: Uint8Array,
  key: LineKey,
  ignoreBlankLines: boolean,
  binaryOverride?: BinaryOverride,
): boolean {
  const oldScanner = createLineDigestScanner(key, ignoreBlankLines, binaryOverride);
  const newScanner = createLineDigestScanner(key, ignoreBlankLines, binaryOverride);
  oldScanner.push(oldContent);
  oldScanner.end();
  newScanner.push(newContent);
  newScanner.end();

  for (;;) {
    const verdict = applyLadder(oldScanner, newScanner, oldScanner.next(), newScanner.next());
    if (verdict === 'continue') continue;
    return verdict && contentsEqualUnder(oldContent, newContent, key, ignoreBlankLines);
  }
}
