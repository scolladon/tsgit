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

const LENGTH_FIELD_BYTES = 2;
const NLEN_MASK = 0xffff;

const ADLER_BYTES = 4;

const INITIAL_BUFFER_CAPACITY = 64;
const BUFFER_GROWTH_FACTOR = 2;

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

  append(chunk: Uint8Array): void {
    this.ensureCapacity(this.length + chunk.length);
    this.buffer.set(chunk, this.length);
    this.length += chunk.length;
  }

  toUint8Array(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }

  private ensureCapacity(required: number): void {
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
    return capacity;
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
): { output: Uint8Array; bytesConsumed: number } {
  const reader = new BitReader(bytes, offset);
  parseZlibHeader(reader);

  const output = new GrowableBuffer();
  decodeBlocks(reader, output);

  const result = output.toUint8Array();
  verifyTrailer(reader, result);

  return { output: result, bytesConsumed: reader.position - offset };
}
