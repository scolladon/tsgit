/**
 * Pure-JS DEFLATE/zlib decoder (RFC 1950 zlib framing, RFC 1951 DEFLATE
 * blocks). Whole-member decode: takes a zlib member starting at `offset` and
 * returns its uncompressed payload plus the exact number of bytes the member
 * occupied (header + blocks + adler32 trailer).
 *
 * Platform-free: no Node/DOM APIs, only pure byte arithmetic. Owns all error
 * mapping to `decompressFailed` — no raw `RangeError`/`TypeError` escapes.
 */

import { decompressFailed } from '../domain/index.js';
import { adler32 } from './adler32.js';

const BITS_PER_BYTE = 8;
const BYTE_SHIFT = 8;

const ZLIB_HEADER_BYTES = 2;
const ZLIB_CM_DEFLATE = 8;
const CM_MASK = 0x0f;
const CINFO_SHIFT = 4;
const WINDOW_MAX_CINFO = 7;
const FCHECK_MOD = 31;
const FCHECK_MULTIPLIER = 256;
const FDICT_SHIFT = 5;

const BFINAL_BITS = 1;
const BTYPE_BITS = 2;
const BLOCK_FINAL = 1;
const STORED_BLOCK_TYPE = 0;
const FIXED_BLOCK_TYPE = 1;
const DYNAMIC_BLOCK_TYPE = 2;

const LENGTH_FIELD_BYTES = 2;
const NLEN_MASK = 0xffff;

const ADLER_BYTES = 4;

const INITIAL_BUFFER_CAPACITY = 64;
const BUFFER_GROWTH_FACTOR = 2;

/**
 * Cap on inflated output to defeat decompression-bomb amplification. Mirrors
 * NodeCompressor's 2 GiB output cap so all three adapters refuse the same
 * malicious member with the same error, instead of exhausting memory.
 */
const MAX_INFLATED_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;

/** RFC 1951: DEFLATE Huffman codes are at most 15 bits long. */
const MAX_HUFFMAN_CODE_BITS = 15;

/**
 * Width of the root Huffman lookup table: peeking this many bits resolves
 * any code of at most this length in one step (table index -> symbol + code
 * length), instead of walking the canonical tree bit by bit. Codes longer
 * than this (up to the RFC 1951 maximum of 15 bits) fall back to the
 * canonical bit-walk. 9 covers every code-length-alphabet code (whose
 * lengths are capped at 7 by their own 3-bit encoding) and the common case
 * for literal/length and distance codes, while keeping the table itself
 * small (512 entries).
 */
const ROOT_BITS = 9;
const ROOT_TABLE_SIZE = 1 << ROOT_BITS;
/** Root-table sentinel meaning "not resolvable from the root window alone"
 * -- either the code is longer than ROOT_BITS, or no code uses this prefix
 * at all. Both cases defer to the canonical bit-walk, which already handles
 * long codes and correctly rejects unmatched prefixes. Reuses the same
 * "0 = absent" convention as an unused code length. */
const ROOT_UNRESOLVED_LENGTH = 0;

/** RFC 1951 length codes 257-285 (index 0 is symbol 257). */
const LENGTH_BASE: ReadonlyArray<number> = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LENGTH_EXTRA: ReadonlyArray<number> = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const MIN_LENGTH_SYMBOL = 257;
const END_OF_BLOCK_SYMBOL = 256;

/** RFC 1951 distance codes 0-29. */
const DIST_BASE: ReadonlyArray<number> = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA: ReadonlyArray<number> = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

/** RFC 1951 fixed literal/length code lengths, grouped by symbol range. */
const FIXED_LITLEN_RANGES: ReadonlyArray<readonly [count: number, bits: number]> = [
  [144, 8], // symbols 0-143
  [112, 9], // symbols 144-255
  [24, 7], // symbols 256-279
  [8, 8], // symbols 280-287
];
const FIXED_DIST_CODE_COUNT = 30; // RFC 1951: distance symbols 0-29, 5 bits each
const FIXED_DIST_BITS = 5;

/** RFC 1951 order in which code-length code lengths are transmitted. */
const CL_ORDER: ReadonlyArray<number> = [
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];
const CL_ALPHABET_SIZE = CL_ORDER.length;
const CL_LENGTH_BITS = 3;

const HLIT_EXTRA_BITS = 5;
const HLIT_BASE = 257;
const HDIST_EXTRA_BITS = 5;
const HDIST_BASE = 1;
const HCLEN_EXTRA_BITS = 4;
const HCLEN_BASE = 4;

/** RFC 1951 code-length alphabet: 0-15 are literal lengths; 16-18 are RLE runs. */
const REPEAT_PREVIOUS_SYMBOL = 16;
const REPEAT_PREVIOUS_EXTRA_BITS = 2;
const REPEAT_PREVIOUS_BASE = 3;
const REPEAT_ZERO_SHORT_SYMBOL = 17;
const REPEAT_ZERO_SHORT_EXTRA_BITS = 3;
const REPEAT_ZERO_SHORT_BASE = 3;
const REPEAT_ZERO_LONG_EXTRA_BITS = 7;
const REPEAT_ZERO_LONG_BASE = 11;

/**
 * LSB-first bit cursor over a byte array, starting at a given byte offset.
 *
 * Bits are served from a plain-number accumulator (`bitBuffer`, low-bit-first;
 * `bitCount` valid bits) instead of one bit at a time: `fill` tops the
 * accumulator up a whole byte at a time only when the current request needs
 * more bits than are already buffered, so a physical byte is fetched (and
 * bounds-checked) once per 8 bits consumed rather than once per bit. Consuming
 * bits is then a mask + shift, no per-bit function-call chain.
 *
 * `peekBits`/`dropBits` split that fill-then-consume pair so a caller can look
 * ahead before deciding how much to consume (the root Huffman lookup table
 * peeks a fixed window, then drops only the resolved code's length). Unlike
 * `readBits`, `peekBits` never throws on a shortfall: it fills as many whole
 * bytes as remain and reports how many of the peeked bits are backed by real
 * input, so a caller can tell a genuine resolution (using only real bits)
 * from one that would depend on invented zero padding -- see `PeekResult`.
 * `dropBits` reconciles a peek that fetched whole bytes ahead of a shorter
 * actual code by giving back any now-spare ones (`ungetSpareBytes`), which
 * restores the invariant below and keeps `readBits` (a peek immediately
 * followed by a matching drop, throwing if that shortfall check fails)
 * behaviourally identical to before.
 *
 * Invariant: after every public call, `bitCount` is strictly less than
 * `BITS_PER_BYTE`. That keeps the byte-fetch cadence (and therefore the exact
 * physical byte at which an out-of-input error fires) identical to a
 * bit-at-a-time reader.
 */
class BitReader {
  private bytePos: number;
  private bitBuffer = 0;
  private bitCount = 0;

  constructor(
    private readonly bytes: Uint8Array,
    offset: number,
  ) {
    this.bytePos = offset;
  }

  /** Byte index of the next bit to decode. Only read after `alignToByte`
   * (via `verifyTrailer`), which zeroes `bitCount`, so the physical read
   * cursor is always already byte-aligned at that point. */
  get position(): number {
    return this.bytePos;
  }

  /** Consume exactly `count` bits, throwing if that many aren't available.
   * Every caller that unconditionally needs `count` real bits next (header
   * fields, extra bits, the canonical bit-walk's one-bit steps) uses this. */
  readBits(count: number): number {
    const peeked = this.peekBits(count);
    if (peeked.availableBits < count) {
      throw decompressFailed('unexpected end of deflate stream');
    }
    this.dropBits(count);
    return peeked.value;
  }

  /** Look at the next `count` bits without consuming them and without
   * requiring that many actually exist in the input: fills the accumulator
   * with as many whole bytes as remain (at most enough for `count` bits),
   * then returns them low-bit-first, alongside how many of those low
   * `count` bits are backed by real input (`availableBits`) -- any bits
   * beyond that are zero only because there was nothing left to load, not a
   * genuine zero. A resolution that depends only on the bits within
   * `availableBits` is exact; pair with `dropBits` to consume it. One that
   * needs more must fall back to `readBits`, which throws exactly where a
   * bit-at-a-time reader would. */
  peekBits(count: number): PeekResult {
    this.fill(count);
    return {
      value: this.bitBuffer & ((1 << count) - 1),
      availableBits: Math.min(this.bitCount, count),
    };
  }

  /** Consume `count` bits already confirmed available (via `peekBits` or
   * `readBits`). Restores the class invariant afterward via
   * `ungetSpareBytes`. */
  dropBits(count: number): void {
    this.bitBuffer >>>= count;
    this.bitCount -= count;
    this.ungetSpareBytes();
  }

  /** Discard any sub-byte remainder from the accumulator. Safe to zero both
   * fields directly: the class invariant keeps `bitCount` below a full byte,
   * so the discarded remainder is always the whole accumulator. */
  alignToByte(): void {
    this.bitBuffer = 0;
    this.bitCount = 0;
  }

  readBytes(count: number): Uint8Array {
    if (this.bytePos + count > this.bytes.length) {
      throw decompressFailed('unexpected end of deflate stream');
    }
    const slice = this.bytes.subarray(this.bytePos, this.bytePos + count);
    this.bytePos += count;
    return slice;
  }

  /** Load whole bytes into the accumulator until it holds at least `count`
   * bits or the input is exhausted. Never throws: a genuine shortfall is
   * reported via `PeekResult.availableBits` and raised by callers that
   * require it (`readBits`), not by this fill step itself. */
  private fill(count: number): void {
    // equivalent-mutant: bitCount<=count would fetch one extra byte at the
    // bitCount===count boundary, but every reader masks to the low `count`
    // bits and the paired dropBits->ungetSpareBytes gives the extra byte
    // back, so bytePos/bitBuffer converge identically either way.
    while (this.bitCount < count && this.bytePos < this.bytes.length) {
      this.bitBuffer |= (this.bytes[this.bytePos] as number) << this.bitCount;
      this.bitCount += BITS_PER_BYTE;
      this.bytePos += 1;
    }
  }

  /** Give back whole bytes buffered ahead of actual need -- e.g. a root-table
   * peek that filled a full extra byte to reach `ROOT_BITS`, when the code
   * it resolved to was shorter. Restores `bitCount < BITS_PER_BYTE`, so the
   * byte-fetch cadence (and therefore the exact physical byte at which a
   * later out-of-input error fires) matches a bit-at-a-time reader. */
  private ungetSpareBytes(): void {
    const spareBytes = Math.floor(this.bitCount / BITS_PER_BYTE);
    // equivalent-mutant: when spareBytes===0 the three statements below are
    // no-ops (subtract 0, mask to the same already-zero-padded width,
    // subtract 0), so skipping this early return changes nothing.
    if (spareBytes === 0) return;
    this.bitCount -= spareBytes * BITS_PER_BYTE;
    this.bitBuffer &= (1 << this.bitCount) - 1;
    this.bytePos -= spareBytes;
  }
}

/** Result of a non-throwing bit peek: `value` holds the requested bit
 * window (zero-padded beyond `availableBits` when the input ran out);
 * `availableBits` is how many of its low bits are backed by real input. */
interface PeekResult {
  readonly value: number;
  readonly availableBits: number;
}

/** Growable byte accumulator: doubles capacity on overflow, trims on read-out. */
class GrowableBuffer {
  private buffer = new Uint8Array(INITIAL_BUFFER_CAPACITY);
  private length = 0;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Uint8Array): void {
    this.ensureCapacity(this.length + chunk.length);
    this.buffer.set(chunk, this.length);
    this.length += chunk.length;
  }

  appendByte(byte: number): void {
    this.ensureCapacity(this.length + 1);
    this.buffer[this.length] = byte;
    this.length += 1;
  }

  /** Copy `length` bytes starting `distance` bytes back from the current end.
   * Non-overlapping runs (`distance >= length`) bulk-copy in one pass;
   * overlapping runs (`distance < length`) replicate byte-by-byte, since each
   * source byte may itself have just been written by this same call. */
  copyBackReference(distance: number, length: number): void {
    if (distance > this.length) {
      throw decompressFailed('distance exceeds output');
    }
    this.ensureCapacity(this.length + length);
    const readIndex = this.length - distance;
    // equivalent-mutant: copyOverlapping's byte-by-byte loop is correct for
    // every distance/length combo, including distance>=length; weakening or
    // dropping this guard only routes more calls through that slower-but-
    // equivalent general path instead of the copyWithin fast path -- same
    // resulting bytes.
    if (distance >= length) {
      this.buffer.copyWithin(this.length, readIndex, readIndex + length);
      this.length += length;
      return;
    }
    this.copyOverlapping(readIndex, length);
  }

  private copyOverlapping(readIndex: number, length: number): void {
    let read = readIndex;
    for (let i = 0; i < length; i += 1) {
      this.buffer[this.length] = this.buffer[read] as number;
      this.length += 1;
      read += 1;
    }
  }

  toUint8Array(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }

  private ensureCapacity(required: number): void {
    if (required > this.maxBytes) {
      throw decompressFailed('inflated output exceeds safety cap');
    }
    // equivalent-mutant: skipping this guard forces a redundant reallocation
    // (nextCapacity/grown.set below faithfully copies the used prefix into a
    // fresh zeroed buffer); toUint8Array only ever exposes [0, length), so
    // the extra reallocation is unobservable.
    if (required <= this.buffer.length) return;
    const grown = new Uint8Array(this.nextCapacity(required));
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }

  private nextCapacity(required: number): number {
    let capacity = this.buffer.length;
    // equivalent-mutant: capacity<=required would double once more than
    // needed at the capacity===required boundary, but the internal buffer's
    // physical size is never observable (toUint8Array exposes only
    // subarray(0, length)), so over-allocating one extra doubling is inert.
    while (capacity < required) {
      capacity *= BUFFER_GROWTH_FACTOR;
    }
    // equivalent-mutant: Math.max here would let capacity exceed maxBytes,
    // but ensureCapacity's independent required>maxBytes guard already
    // bounds every value that reaches this function, and the returned
    // buffer's physical size is never observable, so an oversized capacity
    // is inert.
    return Math.min(capacity, this.maxBytes);
  }
}

function readUint16LE(bytes: Uint8Array): number {
  return (bytes[0] as number) | ((bytes[1] as number) << BYTE_SHIFT);
}

function readUint32BE(bytes: Uint8Array): number {
  return (
    (((bytes[0] as number) << (3 * BYTE_SHIFT)) |
      ((bytes[1] as number) << (2 * BYTE_SHIFT)) |
      ((bytes[2] as number) << BYTE_SHIFT) |
      (bytes[3] as number)) >>>
    0
  );
}

function parseZlibHeader(reader: BitReader): void {
  const header = reader.readBytes(ZLIB_HEADER_BYTES);
  const cmf = header[0] as number;
  const flg = header[1] as number;

  if ((cmf & CM_MASK) !== ZLIB_CM_DEFLATE) {
    throw decompressFailed('unsupported compression method');
  }
  if (cmf >> CINFO_SHIFT > WINDOW_MAX_CINFO) {
    throw decompressFailed('invalid window size');
  }
  if ((cmf * FCHECK_MULTIPLIER + flg) % FCHECK_MOD !== 0) {
    throw decompressFailed('invalid zlib header checksum');
  }
  if (((flg >> FDICT_SHIFT) & 1) !== 0) {
    throw decompressFailed('preset dictionary not supported');
  }
}

function decodeStoredBlock(reader: BitReader, output: GrowableBuffer): void {
  reader.alignToByte();
  const len = readUint16LE(reader.readBytes(LENGTH_FIELD_BYTES));
  const nlen = readUint16LE(reader.readBytes(LENGTH_FIELD_BYTES));
  if (nlen !== (~len & NLEN_MASK)) {
    throw decompressFailed('stored block length mismatch');
  }
  output.append(reader.readBytes(len));
}

/** Canonical Huffman decode structure: per-length code counts plus symbols
 * ordered by (length, symbol), as built by `buildHuffmanTable`, plus a root
 * lookup table for one-step decoding of codes up to `ROOT_BITS` long. */
interface HuffmanTable {
  readonly counts: Uint16Array;
  readonly symbols: Uint16Array;
  readonly root: RootTable;
}

/** Root Huffman lookup table: indexed by the next `ROOT_BITS` bits read in
 * natural (LSB-first) order, each slot resolves either to a code's length
 * and symbol (for codes of at most `ROOT_BITS` bits) or to
 * `ROOT_UNRESOLVED_LENGTH`, meaning the canonical bit-walk must be used
 * instead (a longer code, or no code at all for that prefix). */
interface RootTable {
  readonly lengths: Uint8Array;
  readonly symbols: Uint16Array;
}

/**
 * Which alphabet a table decodes, governing how strictly RFC 1951
 * completeness is enforced (mirrors zlib's `inftrees.c`, pinned empirically
 * against `node:zlib`):
 * - 'fixed': the two RFC-hardcoded tables, built once at module load and
 *   never checked for completeness — the fixed distance table is
 *   intentionally Kraft-incomplete (30 length-5 codes, sum 30/32).
 * - 'code-length': the CL table must always be complete.
 * - 'literal-length' / 'distance': dynamic-header tables must be complete,
 *   except for the degenerate single-code case (exactly one used symbol, at
 *   length 1) that real zlib also accepts.
 */
type HuffmanTableRole = 'fixed' | 'code-length' | 'literal-length' | 'distance';

/** Build a canonical Huffman decode table from per-symbol code lengths
 * (0 = symbol unused). Throws on an over-subscribed code (more codes of a
 * given length than the bit width allows) or, depending on `role`, an
 * incomplete one. */
function buildHuffmanTable(
  codeLengths: ReadonlyArray<number>,
  role: HuffmanTableRole,
): HuffmanTable {
  const counts = countCodeLengths(codeLengths);
  assertComplete(analyzeCodeLengths(counts), role);
  const symbols = orderSymbolsByLength(codeLengths, counts);
  return { counts, symbols, root: buildRootTable(counts, symbols) };
}

function countCodeLengths(codeLengths: ReadonlyArray<number>): Uint16Array {
  const counts = new Uint16Array(MAX_HUFFMAN_CODE_BITS + 1);
  for (const length of codeLengths) {
    // equivalent-mutant: widening this guard (true, or length>=0) would also
    // write counts[0], but every downstream reader (firstIndexByLength,
    // buildRootTable, ...) only iterates lengths 1..MAX_HUFFMAN_CODE_BITS,
    // so counts[0] is dead storage regardless of its value.
    if (length > 0) counts[length] = (counts[length] as number) + 1;
  }
  return counts;
}

interface CodeLengthSummary {
  readonly unusedCodes: number;
  readonly maxUsedLength: number;
}

/** Walk code-length counts per RFC 1951 canonical construction, throwing on
 * an over-subscribed code (more codes of some length than the bit width
 * allows — e.g. three 1-bit codes, when only two exist). Returns the
 * Kraft-inequality leftover and highest used length, both needed to judge
 * completeness. */
function analyzeCodeLengths(counts: Uint16Array): CodeLengthSummary {
  let unusedCodes = 1;
  let maxUsedLength = 0;
  for (let length = 1; length <= MAX_HUFFMAN_CODE_BITS; length += 1) {
    const count = counts[length] as number;
    if (count > 0) maxUsedLength = length;
    unusedCodes = unusedCodes * 2 - count;
    if (unusedCodes < 0) {
      throw decompressFailed('invalid huffman code lengths');
    }
  }
  return { unusedCodes, maxUsedLength };
}

/** RFC 1951 permits an incomplete literal/length or distance code only in the
 * degenerate one-symbol case (a single length-1 code); a code-length table
 * must always be complete. Both rules pinned against real zlib. */
function assertComplete(summary: CodeLengthSummary, role: HuffmanTableRole): void {
  if (role === 'fixed') return;
  // zlib inftrees.c: a table with no symbols at all (max == 0) is accepted
  // at build time for every role -- zlib builds a table that only errors if
  // a decode ever reads a symbol from it, so an unused table (e.g. a
  // literal-only block's distance table) never trips this check.
  if (summary.maxUsedLength === 0) return;
  if (summary.unusedCodes === 0) return;
  if (role !== 'code-length' && summary.maxUsedLength === 1) return;
  throw decompressFailed(incompleteCodeReason(role));
}

function incompleteCodeReason(role: 'code-length' | 'literal-length' | 'distance'): string {
  if (role === 'code-length') return 'invalid code lengths set';
  if (role === 'literal-length') return 'invalid literal/lengths set';
  return 'invalid distances set';
}

function orderSymbolsByLength(
  codeLengths: ReadonlyArray<number>,
  counts: Uint16Array,
): Uint16Array {
  const offsets = firstIndexByLength(counts);
  const symbols = new Uint16Array(codeLengths.length);
  codeLengths.forEach((length, symbol) => {
    if (length === 0) return;
    const offset = offsets[length] as number;
    symbols[offset] = symbol;
    offsets[length] = offset + 1;
  });
  return symbols;
}

function firstIndexByLength(counts: Uint16Array): Uint16Array {
  const offsets = new Uint16Array(MAX_HUFFMAN_CODE_BITS + 2);
  // equivalent-mutant: length<MAX_HUFFMAN_CODE_BITS would drop the final
  // iteration (offsets[MAX_HUFFMAN_CODE_BITS + 1]), but orderSymbolsByLength
  // only ever reads offsets[length] for real code lengths (<=
  // MAX_HUFFMAN_CODE_BITS), so that slot is never read.
  for (let length = 1; length <= MAX_HUFFMAN_CODE_BITS; length += 1) {
    offsets[length + 1] = (offsets[length] as number) + (counts[length] as number);
  }
  return offsets;
}

/** Build the root lookup table from a canonical (length, symbol)-ordered
 * Huffman table: walks the same per-length code assignment
 * `decodeSymbolByWalk` would (`first`/`index` running per length), and for
 * every code of at most `ROOT_BITS` bits, fills every root-table slot whose
 * next `ROOT_BITS`-bit window could hold it — i.e. every value of the
 * "don't care" bits beyond the code's own length. */
function buildRootTable(counts: Uint16Array, symbols: Uint16Array): RootTable {
  const lengths = new Uint8Array(ROOT_TABLE_SIZE);
  const rootSymbols = new Uint16Array(ROOT_TABLE_SIZE);
  let first = 0;
  let index = 0;
  // equivalent-mutant: this loop (and the inner one below) only populate the
  // root-table performance shortcut; decodeSymbol falls back to the always-
  // correct decodeSymbolByWalk whenever a code isn't resolved here, so
  // shrinking, inverting, or emptying either loop just routes more decodes
  // through that slower-but-equivalent walk -- same decoded output.
  for (let length = 1; length <= ROOT_BITS; length += 1) {
    const count = counts[length] as number;
    for (let offset = 0; offset < count; offset += 1) {
      const symbol = symbols[index + offset] as number;
      fillRootEntries(lengths, rootSymbols, first + offset, length, symbol);
    }
    index += count;
    first += count;
    first <<= 1;
  }
  return { lengths, symbols: rootSymbols };
}

/** Fill every root-table slot whose low `length` bits equal `code`'s bits in
 * natural (LSB-first) reading order. `code` is the canonical, MSB-first
 * value `decodeSymbolByWalk` would accumulate; reversing it converts to the
 * order a root-window peek delivers, then every combination of the
 * remaining `ROOT_BITS - length` "don't care" bits is a valid slot. */
function fillRootEntries(
  lengths: Uint8Array,
  symbols: Uint16Array,
  code: number,
  length: number,
  symbol: number,
): void {
  // equivalent-mutant: an entirely no-op body (or a loop that never fills a
  // slot) leaves those root-table entries at their zero-initialized
  // ROOT_UNRESOLVED_LENGTH, so decodeSymbol falls back to the always-correct
  // decodeSymbolByWalk for every affected code -- same decoded output, just
  // slower. A one-past-the-end iteration (entry===ROOT_TABLE_SIZE) writes
  // lengths[ROOT_TABLE_SIZE]/symbols[ROOT_TABLE_SIZE], a silently-dropped
  // out-of-bounds typed-array write per spec -- no valid slot is affected.
  const naturalPrefix = reverseBits(code, length);
  const step = 1 << length;
  for (let entry = naturalPrefix; entry < ROOT_TABLE_SIZE; entry += step) {
    lengths[entry] = length;
    symbols[entry] = symbol;
  }
}

/** Reverse the low `bitCount` bits of `value` (MSB-first <-> LSB-first). */
function reverseBits(value: number, bitCount: number): number {
  let reversed = 0;
  for (let bit = 0; bit < bitCount; bit += 1) {
    reversed = (reversed << 1) | ((value >> bit) & 1);
  }
  return reversed;
}

/** Decode one symbol: peek the next `ROOT_BITS` bits and resolve via the
 * precomputed root table in one step for codes of at most `ROOT_BITS` bits;
 * fall back to the canonical bit-walk for longer codes, a peek window no
 * code uses at all, or a resolution that would depend on padding bits
 * invented because the input ran out before a full `ROOT_BITS` window was
 * available (the walk throws `'unexpected end of deflate stream'` or
 * `'invalid huffman code'` for those cases, exactly as it did before the
 * root table existed). */
function decodeSymbol(reader: BitReader, table: HuffmanTable): number {
  const peeked = reader.peekBits(ROOT_BITS);
  const length = table.root.lengths[peeked.value] as number;
  // equivalent-mutant: forcing this guard true (always) or tightening it to
  // >= (also at length===availableBits) both push more calls through
  // decodeSymbolByWalk instead of the root-table fast path; the walk is the
  // always-correct canonical decoder, so decoded output is identical either
  // way, just slower.
  if (length === ROOT_UNRESOLVED_LENGTH || length > peeked.availableBits) {
    return decodeSymbolByWalk(reader, table);
  }
  reader.dropBits(length);
  return table.root.symbols[peeked.value] as number;
}

/** Canonical Huffman decode by walking the bitstream one bit at a time
 * against the canonical table — the root table's fallback for codes longer
 * than `ROOT_BITS`, and for peek windows no code resolves to at all. */
function decodeSymbolByWalk(reader: BitReader, table: HuffmanTable): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let length = 1; length <= MAX_HUFFMAN_CODE_BITS; length += 1) {
    code |= reader.readBits(1);
    const count = table.counts[length] as number;
    if (code - first < count) {
      return table.symbols[index + (code - first)] as number;
    }
    index += count;
    first += count;
    first <<= 1;
    code <<= 1;
  }
  throw decompressFailed('invalid huffman code');
}

function buildFixedLiteralLengthCodeLengths(): number[] {
  return FIXED_LITLEN_RANGES.flatMap(([count, bits]) => Array(count).fill(bits) as number[]);
}

function buildFixedDistanceCodeLengths(): number[] {
  return Array(FIXED_DIST_CODE_COUNT).fill(FIXED_DIST_BITS) as number[];
}

const FIXED_LITLEN_TABLE = buildHuffmanTable(buildFixedLiteralLengthCodeLengths(), 'fixed');
const FIXED_DIST_TABLE = buildHuffmanTable(buildFixedDistanceCodeLengths(), 'fixed');

function decodeLength(reader: BitReader, symbol: number): number {
  const index = symbol - MIN_LENGTH_SYMBOL;
  if (index >= LENGTH_BASE.length) {
    throw decompressFailed('invalid length code');
  }
  const base = LENGTH_BASE[index] as number;
  const extraBits = LENGTH_EXTRA[index] as number;
  return base + reader.readBits(extraBits);
}

function decodeDistance(reader: BitReader, symbol: number): number {
  if (symbol >= DIST_BASE.length) {
    throw decompressFailed('invalid distance code');
  }
  const base = DIST_BASE[symbol] as number;
  const extraBits = DIST_EXTRA[symbol] as number;
  return base + reader.readBits(extraBits);
}

function decodeBackReference(
  reader: BitReader,
  output: GrowableBuffer,
  distTable: HuffmanTable,
  lengthSymbol: number,
): void {
  const length = decodeLength(reader, lengthSymbol);
  const distanceSymbol = decodeSymbol(reader, distTable);
  const distance = decodeDistance(reader, distanceSymbol);
  output.copyBackReference(distance, length);
}

/** Shared block-body loop: decode symbols against a lit/len + distance table
 * pair until end-of-block. Used by both fixed and dynamic Huffman blocks. */
function decodeBlockBody(
  reader: BitReader,
  output: GrowableBuffer,
  litLenTable: HuffmanTable,
  distTable: HuffmanTable,
): void {
  for (;;) {
    const symbol = decodeSymbol(reader, litLenTable);
    if (symbol < END_OF_BLOCK_SYMBOL) {
      output.appendByte(symbol);
      continue;
    }
    if (symbol === END_OF_BLOCK_SYMBOL) return;
    decodeBackReference(reader, output, distTable, symbol);
  }
}

/** Canonical tables for a dynamic-Huffman block, built fresh per block. */
interface DynamicTables {
  readonly litLenTable: HuffmanTable;
  readonly distTable: HuffmanTable;
}

/** Read the HCLEN code-length-code lengths (3 bits each) in RFC transmission
 * order, scattering them back into alphabet-symbol order (0-18). */
function readCodeLengthCodeLengths(reader: BitReader, hclen: number): number[] {
  // equivalent-mutant: dropping the size argument (new Array().fill(0), a
  // no-op fill on an empty array) still grows to length 19 -- hclen is
  // always >= HCLEN_MINIMUM (4), so the loop below always assigns index 18
  // (CL_ORDER[2] === 18) -- but leaves untouched indices as holes instead of
  // explicit 0. Every downstream reader either uses for...of (holes yield
  // undefined, and undefined>0 is false, same as 0>0) or .forEach (which
  // skips holes entirely, same effect as an explicit-0 early return), so the
  // two representations are indistinguishable to every consumer.
  const lengths = new Array<number>(CL_ALPHABET_SIZE).fill(0);
  for (let i = 0; i < hclen; i += 1) {
    lengths[CL_ORDER[i] as number] = reader.readBits(CL_LENGTH_BITS);
  }
  return lengths;
}

/** Resolve one RLE repeat symbol (16/17/18) to its fill value and run count. */
function readRepeatSpec(
  reader: BitReader,
  lengths: ReadonlyArray<number>,
  symbol: number,
): { readonly value: number; readonly count: number } {
  if (symbol === REPEAT_PREVIOUS_SYMBOL) {
    if (lengths.length === 0) {
      throw decompressFailed('code-length repeat with no previous length');
    }
    const previous = lengths[lengths.length - 1] as number;
    return {
      value: previous,
      count: reader.readBits(REPEAT_PREVIOUS_EXTRA_BITS) + REPEAT_PREVIOUS_BASE,
    };
  }
  if (symbol === REPEAT_ZERO_SHORT_SYMBOL) {
    return {
      value: 0,
      count: reader.readBits(REPEAT_ZERO_SHORT_EXTRA_BITS) + REPEAT_ZERO_SHORT_BASE,
    };
  }
  return { value: 0, count: reader.readBits(REPEAT_ZERO_LONG_EXTRA_BITS) + REPEAT_ZERO_LONG_BASE };
}

function appendRepeatedLengths(
  reader: BitReader,
  lengths: number[],
  symbol: number,
  total: number,
): void {
  const { value, count } = readRepeatSpec(reader, lengths, symbol);
  if (lengths.length + count > total) {
    throw decompressFailed('invalid code-length run');
  }
  for (let i = 0; i < count; i += 1) lengths.push(value);
}

/** Decode `total` code lengths against the code-length table, expanding the
 * RLE symbols (16 = repeat previous, 17/18 = repeat zero) as encountered. */
function decodeCodeLengths(reader: BitReader, table: HuffmanTable, total: number): number[] {
  const lengths: number[] = [];
  while (lengths.length < total) {
    const symbol = decodeSymbol(reader, table);
    if (symbol < REPEAT_PREVIOUS_SYMBOL) {
      lengths.push(symbol);
      continue;
    }
    appendRepeatedLengths(reader, lengths, symbol, total);
  }
  return lengths;
}

/** Read a dynamic-Huffman block header (HLIT/HDIST/HCLEN + code-length table
 * + RLE-expanded lit/len and distance code lengths) and build both tables. */
function decodeDynamicHeader(reader: BitReader): DynamicTables {
  const hlit = reader.readBits(HLIT_EXTRA_BITS) + HLIT_BASE;
  const hdist = reader.readBits(HDIST_EXTRA_BITS) + HDIST_BASE;
  const hclen = reader.readBits(HCLEN_EXTRA_BITS) + HCLEN_BASE;

  const clLengths = readCodeLengthCodeLengths(reader, hclen);
  const clTable = buildHuffmanTable(clLengths, 'code-length');

  const codeLengths = decodeCodeLengths(reader, clTable, hlit + hdist);
  return {
    litLenTable: buildHuffmanTable(codeLengths.slice(0, hlit), 'literal-length'),
    distTable: buildHuffmanTable(codeLengths.slice(hlit), 'distance'),
  };
}

function decodeBlocks(reader: BitReader, output: GrowableBuffer): void {
  let isFinal = false;
  while (!isFinal) {
    const bfinal = reader.readBits(BFINAL_BITS);
    const btype = reader.readBits(BTYPE_BITS);
    isFinal = bfinal === BLOCK_FINAL;
    switch (btype) {
      case STORED_BLOCK_TYPE:
        decodeStoredBlock(reader, output);
        break;
      case FIXED_BLOCK_TYPE:
        decodeBlockBody(reader, output, FIXED_LITLEN_TABLE, FIXED_DIST_TABLE);
        break;
      case DYNAMIC_BLOCK_TYPE: {
        const { litLenTable, distTable } = decodeDynamicHeader(reader);
        decodeBlockBody(reader, output, litLenTable, distTable);
        break;
      }
      default:
        throw decompressFailed('reserved block type');
    }
  }
}

function verifyTrailer(reader: BitReader, output: Uint8Array): void {
  reader.alignToByte();
  const expected = readUint32BE(reader.readBytes(ADLER_BYTES));
  if (expected !== adler32(output)) {
    throw decompressFailed('adler32 checksum mismatch');
  }
}

/**
 * Decode a single zlib member (RFC 1950 header + RFC 1951 blocks + adler32
 * trailer) starting at `offset`. Synchronous, whole-member: the entire
 * decoded output is buffered before return. `bytesConsumed` is the exact
 * byte length of the member (header through trailer), matching
 * `node:zlib`'s `createInflate().bytesWritten` for the same input.
 */
export function inflateZlibMember(
  bytes: Uint8Array,
  offset: number,
  maxOutputBytes: number = MAX_INFLATED_OUTPUT_BYTES,
): { output: Uint8Array; bytesConsumed: number } {
  const reader = new BitReader(bytes, offset);
  parseZlibHeader(reader);

  const output = new GrowableBuffer(maxOutputBytes);
  decodeBlocks(reader, output);

  const result = output.toUint8Array();
  verifyTrailer(reader, result);

  return { output: result, bytesConsumed: reader.position - offset };
}
