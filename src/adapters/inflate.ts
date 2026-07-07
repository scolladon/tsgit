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

/** LSB-first bit cursor over a byte array, starting at a given byte offset. */
class BitReader {
  private bytePos: number;
  private bitPos = 0;

  constructor(
    private readonly bytes: Uint8Array,
    offset: number,
  ) {
    this.bytePos = offset;
  }

  get position(): number {
    return this.bytePos;
  }

  readBits(count: number): number {
    let result = 0;
    for (let i = 0; i < count; i += 1) {
      result |= this.readBit() << i;
    }
    return result;
  }

  alignToByte(): void {
    if (this.bitPos === 0) return;
    this.bitPos = 0;
    this.bytePos += 1;
  }

  readBytes(count: number): Uint8Array {
    if (this.bytePos + count > this.bytes.length) {
      throw decompressFailed('unexpected end of deflate stream');
    }
    const slice = this.bytes.subarray(this.bytePos, this.bytePos + count);
    this.bytePos += count;
    return slice;
  }

  private readBit(): number {
    const byte = this.currentByte();
    const bit = (byte >> this.bitPos) & 1;
    this.advance();
    return bit;
  }

  private currentByte(): number {
    if (this.bytePos >= this.bytes.length) {
      throw decompressFailed('unexpected end of deflate stream');
    }
    return this.bytes[this.bytePos] as number;
  }

  private advance(): void {
    this.bitPos += 1;
    if (this.bitPos === BITS_PER_BYTE) {
      this.bitPos = 0;
      this.bytePos += 1;
    }
  }
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

  /** Copy `length` bytes starting `distance` bytes back from the current end
   * (byte-by-byte, so overlapping runs where `distance < length` replicate). */
  copyBackReference(distance: number, length: number): void {
    if (distance > this.length) {
      throw decompressFailed('distance exceeds output');
    }
    this.ensureCapacity(this.length + length);
    let readIndex = this.length - distance;
    for (let i = 0; i < length; i += 1) {
      this.buffer[this.length] = this.buffer[readIndex] as number;
      this.length += 1;
      readIndex += 1;
    }
  }

  toUint8Array(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }

  private ensureCapacity(required: number): void {
    if (required > this.maxBytes) {
      throw decompressFailed('inflated output exceeds safety cap');
    }
    if (required <= this.buffer.length) return;
    const grown = new Uint8Array(this.nextCapacity(required));
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }

  private nextCapacity(required: number): number {
    let capacity = this.buffer.length;
    while (capacity < required) {
      capacity *= BUFFER_GROWTH_FACTOR;
    }
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
 * ordered by (length, symbol), as built by `buildHuffmanTable`. */
interface HuffmanTable {
  readonly counts: Uint16Array;
  readonly symbols: Uint16Array;
}

/** Build a canonical Huffman decode table from per-symbol code lengths
 * (0 = symbol unused). Throws on an over-subscribed code (more codes of a
 * given length than the bit width allows). */
function buildHuffmanTable(codeLengths: ReadonlyArray<number>): HuffmanTable {
  const counts = countCodeLengths(codeLengths);
  assertNotOverSubscribed(counts);
  const symbols = orderSymbolsByLength(codeLengths, counts);
  return { counts, symbols };
}

function countCodeLengths(codeLengths: ReadonlyArray<number>): Uint16Array {
  const counts = new Uint16Array(MAX_HUFFMAN_CODE_BITS + 1);
  for (const length of codeLengths) {
    if (length > 0) counts[length] = (counts[length] as number) + 1;
  }
  return counts;
}

/** An over-subscribed code claims more codes of some length than the bit
 * width allows (e.g. three 1-bit codes, when only two 1-bit codes exist). */
function assertNotOverSubscribed(counts: Uint16Array): void {
  let unusedCodes = 1;
  for (let length = 1; length <= MAX_HUFFMAN_CODE_BITS; length += 1) {
    unusedCodes = unusedCodes * 2 - (counts[length] as number);
    if (unusedCodes < 0) {
      throw decompressFailed('invalid huffman code lengths');
    }
  }
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
  for (let length = 1; length <= MAX_HUFFMAN_CODE_BITS; length += 1) {
    offsets[length + 1] = (offsets[length] as number) + (counts[length] as number);
  }
  return offsets;
}

/** Decode one symbol by walking the bitstream one bit at a time against the
 * canonical table (bit-at-a-time is simplest and mutation-clean; no fast
 * lookup table to keep magic constants down). */
function decodeSymbol(reader: BitReader, table: HuffmanTable): number {
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

const FIXED_LITLEN_TABLE = buildHuffmanTable(buildFixedLiteralLengthCodeLengths());
const FIXED_DIST_TABLE = buildHuffmanTable(buildFixedDistanceCodeLengths());

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
  const clTable = buildHuffmanTable(clLengths);

  const codeLengths = decodeCodeLengths(reader, clTable, hlit + hdist);
  return {
    litLenTable: buildHuffmanTable(codeLengths.slice(0, hlit)),
    distTable: buildHuffmanTable(codeLengths.slice(hlit)),
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
