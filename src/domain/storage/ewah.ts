import { invalidPackBitmap } from './error.js';

const EWAH_STREAM_HEADER_SIZE = 8; // u32 bitSize + u32 wordCount
const EWAH_WORD_SIZE = 8; // one 64-bit word, stored as two big-endian u32 halves
// Trailing rlwPosition (u32). A decoder never reads its VALUE — decoding
// walks the stream sequentially from the first word — only its presence is
// bounds-proved, which is why the empty stream is 20 bytes, not 12.
const EWAH_POSITION_WORD_SIZE = 4;
const LANES_PER_WORD = 2; // a 64-bit EWAH word maps to two 32-bit destination lanes
const LANE_BITS = 32;
const FULL_LANE = 0xffffffff;
/** `maxSetBitPosition`'s answer for a stream that sets no bit at all. */
const NO_SET_BIT = -1;

export interface EwahStream {
  /**
   * The bit count the stream DECLARES, surfaced verbatim as part of the
   * decoded descriptor — never a checked bound, and no decoder in this
   * module reads it. Both walks below derive their real limit from the
   * buffer (`availableWordCount`) instead, and a caller range-checking a
   * stream against an object count asks `maxSetBitPosition`, because a
   * hostile artefact is free to declare a `bitSize` that agrees with
   * nothing its words actually set.
   */
  readonly bitSize: number;
  readonly wordCount: number;
  /** Byte offset of the first 64-bit word. */
  readonly wordsOffset: number;
  /** Byte offset one past the stream's trailing position word. */
  readonly endOffset: number;
}

type EwahFoldOp = 'or' | 'xor';

/**
 * Reads and bounds-proves one EWAH stream descriptor at `at`. Every declared
 * length is validated against the REMAINING BUFFER before it is used for
 * anything — git's own end-of-data check, where the mapped file length is
 * the bound. The empty stream is `bitSize=0, wordCount=1` with a single
 * all-zero word — 20 bytes, not 12 — and needs no special case: the same
 * arithmetic that proves any other word count in bounds proves this one.
 */
export function readEwahStream(bytes: Uint8Array, view: DataView, at: number): EwahStream {
  if (at + EWAH_STREAM_HEADER_SIZE > bytes.length) {
    throw invalidPackBitmap('stream', `truncated stream descriptor at offset ${at}`);
  }

  const bitSize = view.getUint32(at);
  const wordCount = view.getUint32(at + 4);
  const wordsOffset = at + EWAH_STREAM_HEADER_SIZE;
  const endOffset = wordsOffset + wordCount * EWAH_WORD_SIZE + EWAH_POSITION_WORD_SIZE;

  if (endOffset > bytes.length) {
    throw invalidPackBitmap(
      'stream',
      `stream at offset ${at} declares ${wordCount} word(s), which overruns the buffer`,
    );
  }

  return { bitSize, wordCount, wordsOffset, endOffset };
}

interface RunLengthWord {
  readonly runValue: 0 | 1;
  readonly cleanWordCount: number;
  readonly literalWordCount: number;
}

/**
 * Decodes one 64-bit run-length word from its big-endian halves. Bit 0 is
 * the run's value; bits 1-32 (crossing the half boundary) are the clean-word
 * count; bits 33-63 are the following literal-word count.
 */
function decodeRunLengthWord(high: number, low: number): RunLengthWord {
  return {
    runValue: (low & 1) as 0 | 1,
    cleanWordCount: ((low >>> 1) | ((high & 1) << 31)) >>> 0,
    literalWordCount: high >>> 1,
  };
}

function readWordHalves(view: DataView, offset: number): readonly [number, number] {
  return [view.getUint32(offset), view.getUint32(offset + 4)];
}

function applyFold(current: number, value: number, op: EwahFoldOp): number {
  return (op === 'or' ? current | value : current ^ value) >>> 0;
}

/** Fills `count` destination lanes with all-ones, clamped at `into`'s end —
 *  the only loop whose length is attacker-influenced, and the one the
 *  clamp defuses. */
function fillClean(into: Uint32Array, from: number, count: number, op: EwahFoldOp): number {
  const to = Math.min(from + count, into.length);
  for (let lane = from; lane < to; lane += 1) {
    into[lane] = applyFold(into[lane]!, FULL_LANE, op);
  }
  return to;
}

/** Folds one literal 32-bit lane in, or skips it once `into` is exhausted. */
function foldLiteralLane(into: Uint32Array, lane: number, value: number, op: EwahFoldOp): number {
  if (lane < into.length) {
    into[lane] = applyFold(into[lane]!, value, op);
  }
  return Math.min(lane + 1, into.length);
}

/** How many whole 64-bit words `bytes` can actually back, from
 *  `wordsOffset` — re-derived from the buffer rather than trusted from
 *  `stream` alone, so a `RangeError` cannot escape even given a
 *  hand-built descriptor. */
function availableWordCount(bytes: Uint8Array, wordsOffset: number): number {
  return Math.max(0, Math.floor((bytes.length - wordsOffset) / EWAH_WORD_SIZE));
}

/**
 * Folds one stream into a CALLER-OWNED destination with the given
 * operation. Never allocates, never materialises a run: a clean run's
 * writes are clamped at the destination's end, so a run-length word
 * declaring 2^32 clean words costs a bounded number of writes and then
 * returns.
 */
export function foldEwahStream(
  bytes: Uint8Array,
  view: DataView,
  stream: EwahStream,
  into: Uint32Array,
  op: EwahFoldOp,
): void {
  const wordLimit = Math.min(stream.wordCount, availableWordCount(bytes, stream.wordsOffset));

  let wordIndex = 0;
  let lane = 0;

  while (wordIndex < wordLimit) {
    const [high, low] = readWordHalves(view, stream.wordsOffset + wordIndex * EWAH_WORD_SIZE);
    wordIndex += 1;
    const rlw = decodeRunLengthWord(high, low);

    lane =
      rlw.runValue === 1
        ? fillClean(into, lane, rlw.cleanWordCount * LANES_PER_WORD, op)
        : Math.min(lane + rlw.cleanWordCount * LANES_PER_WORD, into.length);

    for (let i = 0; i < rlw.literalWordCount && wordIndex < wordLimit; i += 1) {
      const [literalHigh, literalLow] = readWordHalves(
        view,
        stream.wordsOffset + wordIndex * EWAH_WORD_SIZE,
      );
      wordIndex += 1;
      lane = foldLiteralLane(into, lane, literalLow, op);
      lane = foldLiteralLane(into, lane, literalHigh, op);
    }
  }
}

/** The absolute position of `word`'s highest set bit within lane `lane`, or
 *  `NO_SET_BIT` when the lane carries none. */
function highestSetBitInLane(lane: number, word: number): number {
  if (word === 0) return NO_SET_BIT;
  return lane * LANE_BITS + (LANE_BITS - 1 - Math.clz32(word));
}

/**
 * The highest bit position `stream` sets, or `NO_SET_BIT` when it sets none.
 * Walks the run-length words ONCE and allocates nothing — the answer a
 * caller range-checking a stream against an object count needs, without
 * paying a full-width fold per stream just to throw the fold away. A clean
 * run of ones contributes its own last bit, a literal word its own highest
 * set bit, a clean run of zeroes nothing but the positions it advances past.
 * Unlike `foldEwahStream` the walk is not clamped to a destination, so a bit
 * declared far beyond the artefact's own bit space is observed rather than
 * silently truncated.
 */
export function maxSetBitPosition(bytes: Uint8Array, view: DataView, stream: EwahStream): number {
  const wordLimit = Math.min(stream.wordCount, availableWordCount(bytes, stream.wordsOffset));

  let wordIndex = 0;
  let lane = 0;
  let max = NO_SET_BIT;

  while (wordIndex < wordLimit) {
    const [high, low] = readWordHalves(view, stream.wordsOffset + wordIndex * EWAH_WORD_SIZE);
    wordIndex += 1;
    const rlw = decodeRunLengthWord(high, low);

    const cleanLanes = rlw.cleanWordCount * LANES_PER_WORD;
    // Positions only ever grow across the walk, so the newest run's last bit
    // is the new maximum outright — no comparison needed.
    if (rlw.runValue === 1 && cleanLanes > 0) max = (lane + cleanLanes) * LANE_BITS - 1;
    lane += cleanLanes;

    for (let i = 0; i < rlw.literalWordCount && wordIndex < wordLimit; i += 1) {
      const [literalHigh, literalLow] = readWordHalves(
        view,
        stream.wordsOffset + wordIndex * EWAH_WORD_SIZE,
      );
      wordIndex += 1;
      max = Math.max(
        max,
        highestSetBitInLane(lane, literalLow),
        highestSetBitInLane(lane + 1, literalHigh),
      );
      lane += LANES_PER_WORD;
    }
  }

  return max;
}
