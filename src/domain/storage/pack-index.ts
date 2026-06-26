import { bytesToHex, compareBytes, hexToBytes } from '../objects/encoding.js';
import type { ObjectId } from '../objects/index.js';
import { invalidPackIndex } from './error.js';

const IDX_MAGIC = 0xff744f63;
const IDX_VERSION = 2;
const IDX_HEADER_SIZE = 8;
const IDX_FANOUT_SIZE = 1024;
const IDX_SHA_TABLE_OFFSET = 1032;
const IDX_SHA_LENGTH = 20;

export interface PackIndex {
  readonly objectCount: number;
  readonly crc32TableOffset: number;
  readonly smallOffsetsTableOffset: number;
  readonly largeOffsetsTableOffset: number;
  readonly trailerOffset: number;
  readonly _bytes: Uint8Array;
  readonly _view: DataView;
}

export function parsePackIndex(bytes: Uint8Array): PackIndex {
  const minSize = IDX_HEADER_SIZE + IDX_FANOUT_SIZE;
  if (bytes.length < minSize) {
    throw invalidPackIndex('truncated: file too short for header and fanout');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const magic = view.getUint32(0);
  if (magic !== IDX_MAGIC) {
    throw invalidPackIndex(
      `invalid magic: expected 0xff744f63, got 0x${magic.toString(16).padStart(8, '0')}`,
    );
  }

  const version = view.getUint32(4);
  if (version !== IDX_VERSION) {
    throw invalidPackIndex(`unsupported version: expected 2, got ${version}`);
  }

  validateFanoutMonotonicity(view);

  const objectCount = view.getUint32(IDX_HEADER_SIZE + 255 * 4);

  const crc32TableOffset = IDX_SHA_TABLE_OFFSET + objectCount * IDX_SHA_LENGTH;
  const smallOffsetsTableOffset = crc32TableOffset + objectCount * 4;
  const largeOffsetsTableOffset = smallOffsetsTableOffset + objectCount * 4;
  const trailerOffset = bytes.length - 40;

  const minExpectedSize =
    IDX_SHA_TABLE_OFFSET + objectCount * IDX_SHA_LENGTH + objectCount * 4 + objectCount * 4 + 40;
  if (bytes.length < minExpectedSize) {
    throw invalidPackIndex(
      `truncated: expected at least ${minExpectedSize} bytes for ${objectCount} objects, got ${bytes.length}`,
    );
  }

  return {
    objectCount,
    crc32TableOffset,
    smallOffsetsTableOffset,
    largeOffsetsTableOffset,
    trailerOffset,
    _bytes: bytes,
    _view: view,
  };
}

function validateFanoutMonotonicity(view: DataView): void {
  let prev = 0;
  for (let i = 0; i < 256; i++) {
    const current = view.getUint32(IDX_HEADER_SIZE + i * 4);
    if (current < prev) {
      throw invalidPackIndex(`non-monotonic fanout at index ${i}: ${prev} > ${current}`);
    }
    prev = current;
  }
}

function readFanout(index: PackIndex, byte: number): number {
  return index._view.getUint32(IDX_HEADER_SIZE + byte * 4);
}

function compareShaAtIndex(index: PackIndex, i: number, targetBytes: Uint8Array): number {
  const offset = IDX_SHA_TABLE_OFFSET + i * IDX_SHA_LENGTH;
  const sha = index._bytes.subarray(offset, offset + IDX_SHA_LENGTH);
  return compareBytes(sha, targetBytes);
}

function readOffset(index: PackIndex, i: number): number {
  const raw = index._view.getUint32(index.smallOffsetsTableOffset + i * 4);
  if ((raw & 0x80000000) !== 0) {
    const largeIdx = raw & 0x7fffffff;
    const largeOffset = index.largeOffsetsTableOffset + largeIdx * 8;
    if (largeOffset + 8 > index.trailerOffset) {
      throw invalidPackIndex(`large offset index ${largeIdx} out of range`);
    }
    const high = index._view.getUint32(largeOffset);
    const low = index._view.getUint32(largeOffset + 4);
    if (high > 0x1fffff) {
      throw invalidPackIndex(`pack offset exceeds safe JavaScript number range: high word=${high}`);
    }
    return high * 0x100000000 + low;
  }
  return raw;
}

export function entryOffsets(index: PackIndex): ReadonlyArray<number> {
  const offsets: number[] = [];
  for (let i = 0; i < index.objectCount; i += 1) {
    offsets.push(readOffset(index, i));
  }
  return offsets;
}

export function lookupPackIndex(index: PackIndex, id: ObjectId): number | undefined {
  const targetBytes = hexToBytes(id);
  const firstByte = targetBytes[0]!;
  // Stryker disable next-line ConditionalExpression: equivalent — `lo` only narrows the binary search; the loop over [0, hi) still converges on the same index (the target, if present, lies in [lo, hi) ⊆ [0, hi)), so forcing `lo` to 0 cannot change the looked-up offset.
  const lo = firstByte === 0 ? 0 : readFanout(index, firstByte - 1);
  const hi = readFanout(index, firstByte);

  let low = lo;
  let high = hi;

  while (low < high) {
    const mid = (low + high) >>> 1;
    const cmp = compareShaAtIndex(index, mid, targetBytes);
    if (cmp < 0) {
      low = mid + 1;
    } else if (cmp > 0) {
      high = mid;
    } else {
      return readOffset(index, mid);
    }
  }

  return undefined;
}

const HEX_RE = /^[0-9a-f]+$/;

export function findByPrefix(index: PackIndex, prefix: string): ReadonlyArray<ObjectId> {
  if (prefix.length < 4) {
    throw invalidPackIndex(`prefix too short: minimum 4 hex chars, got ${prefix.length}`);
  }
  if (prefix.length > 40) {
    throw invalidPackIndex(`prefix too long: maximum 40 hex chars, got ${prefix.length}`);
  }
  if (!HEX_RE.test(prefix)) {
    throw invalidPackIndex('prefix contains non-hex characters');
  }

  const lowerHex = prefix.padEnd(40, '0');
  const upperHex = prefix.padEnd(40, 'f');
  const lowerBytes = hexToBytes(lowerHex);
  const upperBytes = hexToBytes(upperHex);

  const firstByte = lowerBytes[0]!;
  // Stryker disable next-line ConditionalExpression: equivalent — `lo` only narrows the search window; `findLowerBound`/`findUpperBound` over [0, hi) return the same bounds (the prefix range lies in [lo, hi) ⊆ [0, hi)), so forcing `lo` to 0 cannot change the result set.
  const lo = firstByte === 0 ? 0 : readFanout(index, firstByte - 1);

  const lastByte = upperBytes[0]!;
  const hi = readFanout(index, lastByte);

  const lowerBound = findLowerBound(index, lo, hi, lowerBytes);
  const upperBound = findUpperBound(index, lo, hi, upperBytes);

  const results: ObjectId[] = [];
  for (let i = lowerBound; i < upperBound; i++) {
    const offset = IDX_SHA_TABLE_OFFSET + i * IDX_SHA_LENGTH;
    const sha = index._bytes.subarray(offset, offset + IDX_SHA_LENGTH);
    results.push(bytesToHex(sha) as ObjectId);
  }

  return results;
}

export function allObjectIds(index: PackIndex): ReadonlyArray<ObjectId> {
  const results: ObjectId[] = [];
  for (let i = 0; i < index.objectCount; i++) {
    const offset = IDX_SHA_TABLE_OFFSET + i * IDX_SHA_LENGTH;
    const sha = index._bytes.subarray(offset, offset + IDX_SHA_LENGTH);
    results.push(bytesToHex(sha) as ObjectId);
  }
  return results;
}

function findLowerBound(index: PackIndex, lo: number, hi: number, targetBytes: Uint8Array): number {
  let low = lo;
  let high = hi;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compareShaAtIndex(index, mid, targetBytes) < 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function findUpperBound(index: PackIndex, lo: number, hi: number, targetBytes: Uint8Array): number {
  let low = lo;
  let high = hi;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compareShaAtIndex(index, mid, targetBytes) <= 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}
