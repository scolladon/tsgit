/**
 * Range validation for a parsed pack bitmap — every position the artefact
 * decodes, in BOTH position spaces (per-commit entry headers, an index
 * position checked as a scalar; and every set bit a folded stream yields),
 * checked against the pack's own object count before `bitmap-binding.ts`
 * ever resolves a decoded position to an oid. A violation declines the
 * whole artefact, never just the offending entry or stream — the caller
 * never learns which one was at fault, matching git's own "lose the
 * bitmap entirely" degradation.
 */
import {
  type BitmapEntryHeader,
  type EwahStream,
  foldEwahStream,
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

/** Folds `stream` alone (never XOR-chained) into a cleared `scratch`,
 *  declines on any bit `>= objectCount`, else returns the fold truncated to
 *  `laneCount` — the artefact's own bit space, no headroom. A stream's own
 *  literal bits are unaffected by any XOR chain it participates in (XOR
 *  never changes WHICH position a stream addresses, only the value stored
 *  there), so checking every entry's stream in isolation catches a
 *  violation regardless of where in a chain it was introduced. */
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
 * violation, in either space.
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
    if (foldAndCheckRange(bitmap, header.stream, scratch, laneCount, objectCount) === undefined) {
      return undefined;
    }
  }

  return { typeBits: [commitBits, treeBits, blobBits, tagBits] };
}
