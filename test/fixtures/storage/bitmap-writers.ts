/**
 * Hand-built-bytes writers for the on-disk EWAH stream and pack-bitmap
 * container formats — tsgit has no production writer for either artefact, so
 * every suite that needs a bitmap on disk builds one here.
 *
 * Kept free of `fast-check` (and of any other test-only dependency) on
 * purpose: the parity scenarios reach these writers, and the Deno, Bun and
 * `workerd` drivers resolve the whole scenario graph strictly from source —
 * a dev-dependency anywhere in that graph fails the run before a single
 * assertion executes. The generators that DO need `fast-check`
 * (`arbBitmapSpec` and friends) live in `test/unit/domain/storage`, which
 * re-exports these writers so existing importers keep one entry point.
 *
 * Imports carry explicit `.ts` extensions, the convention of every
 * parity-reachable module.
 */
import { encode } from '../../../src/domain/objects/encoding.ts';

// --- EWAH streams ---------------------------------------------------------

const EWAH_WORD_BITS = 64;
const EWAH_LOW_HALF_BITS = 32;
const EWAH_CLEAN_COUNT_BITS = 31;

interface EwahWord {
  readonly high: number;
  readonly low: number;
}

function classifyEwahWord(
  bitSet: ReadonlySet<number>,
  wordIndex: number,
): 'clean0' | 'clean1' | 'literal' {
  const base = wordIndex * EWAH_WORD_BITS;
  let setCount = 0;
  for (let p = 0; p < EWAH_WORD_BITS; p += 1) {
    if (bitSet.has(base + p)) setCount += 1;
  }
  if (setCount === 0) return 'clean0';
  if (setCount === EWAH_WORD_BITS) return 'clean1';
  return 'literal';
}

function ewahLiteralWordAt(bitSet: ReadonlySet<number>, wordIndex: number): EwahWord {
  const base = wordIndex * EWAH_WORD_BITS;
  let low = 0;
  let high = 0;
  for (let p = 0; p < EWAH_LOW_HALF_BITS; p += 1) {
    if (bitSet.has(base + p)) low |= 1 << p;
  }
  for (let p = 0; p < EWAH_LOW_HALF_BITS; p += 1) {
    if (bitSet.has(base + EWAH_LOW_HALF_BITS + p)) high |= 1 << p;
  }
  return { high: high >>> 0, low: low >>> 0 };
}

/** Inverse of `readEwahStream`'s run-length decode: bit 0 is the run value,
 *  bits 1-32 (crossing the half boundary) are the clean-word count, bits
 *  33-63 are the following literal-word count. */
function encodeRunLengthWord(runValue: 0 | 1, cleanCount: number, literalCount: number): EwahWord {
  const low = (((cleanCount & 0x7fffffff) << 1) | runValue) >>> 0;
  const high = ((literalCount << 1) | ((cleanCount >>> EWAH_CLEAN_COUNT_BITS) & 1)) >>> 0;
  return { high, low };
}

function writeEwahStreamBytes(bitSize: number, words: ReadonlyArray<EwahWord>): Uint8Array {
  const bytes = new Uint8Array(8 + words.length * 8 + 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bitSize);
  view.setUint32(4, words.length);
  words.forEach((word, i) => {
    view.setUint32(8 + i * 8, word.high);
    view.setUint32(8 + i * 8 + 4, word.low);
  });
  // Trailing rlwPosition (u32): a decoder never reads its value, so this
  // writer never computes one — left as zero bytes.
  return bytes;
}

/**
 * Writer for the on-disk EWAH stream format — the model for
 * `readEwahStream`/`foldEwahStream`'s round-trip oracle. Clusters the bit
 * set into runs of same-valued 64-bit words (clean words) interleaved with
 * literal words, the same clustering git's own writer performs, so a sparse
 * input exercises both run-length and literal words rather than only ever
 * emitting literals. `bitSize = 0` writes git's own empty encoding — one
 * all-zero word, never zero words.
 */
export function encodeEwah(bits: ReadonlyArray<number>, bitSize: number): Uint8Array {
  const bitSet = new Set(bits);
  const wordSpan = Math.ceil(bitSize / EWAH_WORD_BITS);
  const words: EwahWord[] = [];

  let i = 0;
  while (i < wordSpan) {
    const startKind = classifyEwahWord(bitSet, i);
    let cleanEnd = i;
    if (startKind !== 'literal') {
      while (cleanEnd < wordSpan && classifyEwahWord(bitSet, cleanEnd) === startKind) {
        cleanEnd += 1;
      }
    }
    let literalEnd = cleanEnd;
    while (literalEnd < wordSpan && classifyEwahWord(bitSet, literalEnd) === 'literal') {
      literalEnd += 1;
    }

    words.push(
      encodeRunLengthWord(startKind === 'clean1' ? 1 : 0, cleanEnd - i, literalEnd - cleanEnd),
    );
    for (let k = cleanEnd; k < literalEnd; k += 1) {
      words.push(ewahLiteralWordAt(bitSet, k));
    }
    i = literalEnd;
  }

  if (words.length === 0) {
    words.push(encodeRunLengthWord(0, 0, 0));
  }

  return writeEwahStreamBytes(bitSize, words);
}

// --- Pack bitmap: container -----------------------------------------------

const BITMAP_HEADER_SIZE = 12;
const BITMAP_ENTRY_FIXED_SIZE = 6;

export interface BitmapStreamSpec {
  readonly bits: ReadonlyArray<number>;
  readonly bitSize: number;
}

export interface BitmapEntrySpec extends BitmapStreamSpec {
  readonly position: number;
  readonly xorOffset: number;
  readonly flags: number;
}

export interface BitmapSpec {
  readonly optionFlags: number;
  readonly digestLength: number;
  readonly checksum: Uint8Array;
  readonly typeStreams: readonly [
    BitmapStreamSpec,
    BitmapStreamSpec,
    BitmapStreamSpec,
    BitmapStreamSpec,
  ];
  readonly entries: ReadonlyArray<BitmapEntrySpec>;
  /** Bytes appended after the last entry — stands in for the hash cache,
   *  lookup table, pseudo-merge table and the file's own trailing digest,
   *  none of which the parser reads. */
  readonly trailingBytes: number;
}

/**
 * Writer for the on-disk pack (or midx) bitmap container layout — the model
 * for `parsePackBitmap`/`bitmapEntryHeaders`'s round-trip oracle. Reuses
 * `encodeEwah` for every stream, so a fixture that exercises EWAH's clean
 * and literal words also exercises the container's own offset arithmetic.
 */
export function buildBitmap(spec: BitmapSpec): Uint8Array {
  const { optionFlags, digestLength, checksum, typeStreams, entries, trailingBytes } = spec;

  const streamBytes = typeStreams.map((stream) => encodeEwah(stream.bits, stream.bitSize));
  const entryBytes = entries.map((entry) => {
    const fixed = new Uint8Array(BITMAP_ENTRY_FIXED_SIZE);
    const fixedView = new DataView(fixed.buffer);
    fixedView.setUint32(0, entry.position);
    fixedView.setUint8(4, entry.xorOffset);
    fixedView.setUint8(5, entry.flags);
    return { fixed, stream: encodeEwah(entry.bits, entry.bitSize) };
  });

  const totalSize =
    BITMAP_HEADER_SIZE +
    digestLength +
    streamBytes.reduce((sum, streamPart) => sum + streamPart.length, 0) +
    entryBytes.reduce((sum, entry) => sum + entry.fixed.length + entry.stream.length, 0) +
    trailingBytes;

  const bytes = new Uint8Array(totalSize);
  const view = new DataView(bytes.buffer);

  bytes.set(encode('BITM'), 0);
  view.setUint16(4, 1);
  view.setUint16(6, optionFlags);
  view.setUint32(8, entries.length);
  bytes.set(checksum, BITMAP_HEADER_SIZE);

  let cursor = BITMAP_HEADER_SIZE + digestLength;
  for (const streamPart of streamBytes) {
    bytes.set(streamPart, cursor);
    cursor += streamPart.length;
  }
  for (const entry of entryBytes) {
    bytes.set(entry.fixed, cursor);
    cursor += entry.fixed.length;
    bytes.set(entry.stream, cursor);
    cursor += entry.stream.length;
  }

  return bytes;
}
