/**
 * Range validation for a parsed pack bitmap — every position the artefact
 * decodes, in BOTH position spaces (per-commit entry headers, an index
 * position checked as a scalar; and every set bit any of its streams
 * declares), checked against the pack's own object count before `bitmap-binding.ts`
 * ever resolves a decoded position to an oid. A violation declines the
 * whole artefact, never just the offending entry or stream — the caller
 * never learns which one was at fault, matching git's own "lose the
 * bitmap entirely" degradation.
 */
import {
  type BitmapEntryHeader,
  type EwahStream,
  foldEwahStream,
  maxSetBitPosition,
  type PackBitmap,
} from '../../../domain/storage/index.js';

const WORD_BITS = 32;

export function laneCountFor(bitCount: number): number {
  return Math.ceil(bitCount / WORD_BITS);
}

/** One 32-bit lane of headroom past `laneCountFor(objectCount)` — enough to
 *  observe a stream that declares a bit at (or just past) `objectCount`
 *  without materialising an unboundedly large scratch buffer for a stream
 *  that declares a huge, harmless `bitSize`: the fold still clamps at the
 *  scratch's own length, so a run that would land far beyond this margin is
 *  silently — and correctly — truncated away, exactly as a fold sized to
 *  `objectCount` alone would truncate it during real use. */
const VALIDATION_MARGIN_LANES = 1;

function hasSetBitAtOrAfter(words: Uint32Array, limit: number): boolean {
  const limitLane = Math.floor(limit / WORD_BITS);
  const bitInLane = limit % WORD_BITS;
  if (limitLane < words.length) {
    const mask = (0xffffffff << bitInLane) >>> 0;
    if ((words[limitLane]! & mask) >>> 0 !== 0) return true;
  }
  for (let lane = limitLane + 1; lane < words.length; lane += 1) {
    if (words[lane] !== 0) return true;
  }
  return false;
}

/** Folds one TYPE stream (never XOR-chained) into a cleared `scratch`,
 *  declines on any bit `>= objectCount`, else returns the fold truncated to
 *  `laneCount` — the artefact's own bit space, no headroom. Only the four
 *  type streams come through here: their bits are RETAINED (`typeOfPosition`
 *  reads them for the artefact's whole life), so the fold is work the
 *  artefact needs anyway. An entry stream's bits are never retained and are
 *  range-proved by `maxSetBitPosition` instead. */
function foldAndCheckRange(
  bitmap: PackBitmap,
  stream: EwahStream,
  scratch: Uint32Array,
  laneCount: number,
  objectCount: number,
): Uint32Array | undefined {
  scratch.fill(0);
  foldEwahStream(bitmap._bytes, bitmap._view, stream, scratch, 'or');
  if (hasSetBitAtOrAfter(scratch, objectCount)) return undefined;
  return scratch.slice(0, laneCount);
}

export interface ValidatedStreams {
  readonly typeBits: readonly [Uint32Array, Uint32Array, Uint32Array, Uint32Array];
}

/**
 * Range-validates every position the artefact decodes — the four type
 * streams and every per-commit entry header plus its own stream — against
 * `objectCount`, both position spaces, before anything is resolved to an
 * oid. Declines the whole artefact (returns `undefined`) on the first
 * violation, in either space. Cost is one full-width fold for each of the
 * four type streams (whose bits the artefact keeps) plus one allocation-free
 * word walk per entry stream (whose bits it does not).
 */
export function validateBitmapRanges(
  bitmap: PackBitmap,
  headers: ReadonlyArray<BitmapEntryHeader>,
  objectCount: number,
): ValidatedStreams | undefined {
  const laneCount = laneCountFor(objectCount);
  const scratch = new Uint32Array(laneCount + VALIDATION_MARGIN_LANES);

  const commitBits = foldAndCheckRange(
    bitmap,
    bitmap.typeStreams[0],
    scratch,
    laneCount,
    objectCount,
  );
  if (commitBits === undefined) return undefined;
  const treeBits = foldAndCheckRange(
    bitmap,
    bitmap.typeStreams[1],
    scratch,
    laneCount,
    objectCount,
  );
  if (treeBits === undefined) return undefined;
  const blobBits = foldAndCheckRange(
    bitmap,
    bitmap.typeStreams[2],
    scratch,
    laneCount,
    objectCount,
  );
  if (blobBits === undefined) return undefined;
  const tagBits = foldAndCheckRange(bitmap, bitmap.typeStreams[3], scratch, laneCount, objectCount);
  if (tagBits === undefined) return undefined;

  for (const header of headers) {
    if (header.position >= objectCount) return undefined;
    // Allocation-free: an entry stream's bits are never RETAINED — only
    // range-proved — so folding one into a full-width scratch (and clearing
    // that scratch) per entry would cost O(entryCount × objectCount) memory
    // traffic before a single oid is resolved. The stream's own highest set
    // bit is the whole check, and XOR never moves WHICH position a stream
    // addresses, so proving each stream in isolation proves every chain it
    // takes part in.
    if (maxSetBitPosition(bitmap._bytes, bitmap._view, header.stream) >= objectCount) {
      return undefined;
    }
  }

  return { typeBits: [commitBits, treeBits, blobBits, tagBits] };
}
