import { bytesToHex, hexToBytes } from '../objects/encoding.js';
import type { ObjectId } from '../objects/index.js';
import { invalidPackIndex } from './error.js';

const IDX_MAGIC = 0xff744f63;
const IDX_VERSION = 2;
const IDX_HEADER_SIZE = 8;
const IDX_FANOUT_SIZE = 1024;
const IDX_SHA_TABLE_OFFSET = 1032;

export interface PackIndex {
  readonly objectCount: number;
  /** Oid byte width this index was framed at — 20 for SHA-1, 32 for SHA-256. */
  readonly digestLength: 20 | 32;
  readonly crc32TableOffset: number;
  readonly smallOffsetsTableOffset: number;
  readonly largeOffsetsTableOffset: number;
  readonly trailerOffset: number;
  readonly _bytes: Uint8Array;
  readonly _view: DataView;
}

/**
 * `.idx` trailer size: pack checksum + idx checksum, each `digestLength`
 * bytes. The SAME arithmetic also gives a full oid's hex-character length
 * (two hex digits per byte) — `findByPrefix` reuses this helper for that,
 * rather than restating `2 * digestLength` a third time.
 */
function idxTrailerSize(digestLength: number): number {
  return 2 * digestLength;
}

/**
 * Byte offset of the sha-table slot at `position`, for an index whose oids
 * are `digestLength` bytes wide. Shared by a single-slot read
 * (`compareShaAtIndex`, `objectIdAt`, `position` = `i`) and the table's own
 * end boundary (`parsePackIndex`'s `crc32TableOffset`, `position` =
 * `objectCount`) — one stride, no restated literal.
 */
function shaSlotOffset(position: number, digestLength: number): number {
  return IDX_SHA_TABLE_OFFSET + position * digestLength;
}

export function parsePackIndex(bytes: Uint8Array, digestLength: 20 | 32): PackIndex {
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

  const crc32TableOffset = shaSlotOffset(objectCount, digestLength);
  const smallOffsetsTableOffset = crc32TableOffset + objectCount * 4;
  const largeOffsetsTableOffset = smallOffsetsTableOffset + objectCount * 4;
  const trailerOffset = bytes.length - idxTrailerSize(digestLength);

  const minExpectedSize = largeOffsetsTableOffset + idxTrailerSize(digestLength);
  if (bytes.length < minExpectedSize) {
    throw invalidPackIndex(
      `truncated: expected at least ${minExpectedSize} bytes for ${objectCount} objects, got ${bytes.length}`,
    );
  }

  return {
    objectCount,
    digestLength,
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
  const base = shaSlotOffset(i, index.digestLength);
  const bytes = index._bytes;
  for (let k = 0; k < index.digestLength; k += 1) {
    const diff = bytes[base + k]! - targetBytes[k]!;
    if (diff !== 0) return diff;
  }
  return 0;
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

/**
 * The fanout-narrowed binary search both `lookupPackIndex` and
 * `lookupPackIndexPosition` run: the index position holding `targetBytes`,
 * or `undefined` when this index does not carry the object at all.
 */
function searchIndexPosition(index: PackIndex, targetBytes: Uint8Array): number | undefined {
  const firstByte = targetBytes[0]!;
  // Stryker disable next-line ConditionalExpression: equivalent — `lo` only narrows the binary search; the loop over [0, hi) still converges on the same index (the target, if present, lies in [lo, hi) ⊆ [0, hi)), so forcing `lo` to 0 cannot change the position found.
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
      return mid;
    }
  }

  return undefined;
}

export function lookupPackIndex(index: PackIndex, id: ObjectId): number | undefined {
  const position = searchIndexPosition(index, hexToBytes(id));
  return position === undefined ? undefined : readOffset(index, position);
}

/**
 * The INDEX POSITION of `id` — the same search `lookupPackIndex` runs,
 * stopping one step earlier. A caller mapping an oid to the position an
 * artefact addresses it by needs neither the offset nor an offset → position
 * table materialised over the whole index to invert one back.
 */
export function lookupPackIndexPosition(index: PackIndex, id: ObjectId): number | undefined {
  return searchIndexPosition(index, hexToBytes(id));
}

/**
 * The oid at index position `position`, hex-encoded — `midxOidAt`'s shape at
 * a pack `.idx`. Index-addressed on purpose: a caller that already knows the
 * position neither re-derives it through the search nor pays
 * `allObjectIds`' one-string-per-object materialisation to read a handful of
 * them. `position` is trusted to name an object this index carries, exactly
 * as `midxOidAt` trusts a midx position — the range rule belongs to whoever
 * decoded the position.
 */
export function objectIdAt(index: PackIndex, position: number): ObjectId {
  const offset = shaSlotOffset(position, index.digestLength);
  return bytesToHex(index._bytes.subarray(offset, offset + index.digestLength)) as ObjectId;
}

const HEX_RE = /^[0-9a-f]+$/;

export function findByPrefix(index: PackIndex, prefix: string): ReadonlyArray<ObjectId> {
  const hexLength = idxTrailerSize(index.digestLength);
  if (prefix.length < 4) {
    throw invalidPackIndex(`prefix too short: minimum 4 hex chars, got ${prefix.length}`);
  }
  if (prefix.length > hexLength) {
    throw invalidPackIndex(`prefix too long: maximum ${hexLength} hex chars, got ${prefix.length}`);
  }
  if (!HEX_RE.test(prefix)) {
    throw invalidPackIndex('prefix contains non-hex characters');
  }

  const lowerHex = prefix.padEnd(hexLength, '0');
  const upperHex = prefix.padEnd(hexLength, 'f');
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
    results.push(objectIdAt(index, i));
  }

  return results;
}

export function allObjectIds(index: PackIndex): ReadonlyArray<ObjectId> {
  const results: ObjectId[] = [];
  for (let i = 0; i < index.objectCount; i++) {
    results.push(objectIdAt(index, i));
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
