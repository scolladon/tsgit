import { invalidPackBitmap } from './error.js';

const EWAH_STREAM_HEADER_SIZE = 8; // u32 bitSize + u32 wordCount
const EWAH_WORD_SIZE = 8; // one 64-bit word, stored as two big-endian u32 halves
// Trailing rlwPosition (u32). A decoder never reads its VALUE — decoding
// walks the stream sequentially from the first word — only its presence is
// bounds-proved, which is why the empty stream is 20 bytes, not 12.
const EWAH_POSITION_WORD_SIZE = 4;
const LANES_PER_WORD = 2; // a 64-bit EWAH word maps to two 32-bit destination lanes
const FULL_LANE = 0xffffffff;

export interface EwahStream {
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
