import { bytesToHex, decode, hexToBytes } from '../objects/encoding.js';
import type { ObjectId } from '../objects/index.js';
import { invalidMultiPackIndex } from './error.js';

const MIDX_MAGIC = 0x4d494458;
const MIDX_HEADER_SIZE = 12;
const MIDX_CHUNK_TABLE_ROW_SIZE = 12;
const MIDX_FANOUT_ENTRIES = 256;
const MIDX_FANOUT_SIZE = MIDX_FANOUT_ENTRIES * 4;

const CHUNK_ID_PNAM = 'PNAM';
const CHUNK_ID_OIDF = 'OIDF';
const CHUNK_ID_OIDL = 'OIDL';
const CHUNK_ID_OOFF = 'OOFF';
const CHUNK_ID_LOFF = 'LOFF';

/** `hashVersion` byte → the digest width it implies (git's oid-version map). */
const HASH_VERSION_WIDTH: ReadonlyMap<number, number> = new Map([
  [1, 20],
  [2, 32],
]);

export interface MultiPackIndex {
  readonly version: 1 | 2;
  readonly hashVersion: 1 | 2;
  readonly digestLength: number;
  /** Read from the header and exposed as-is; not a load-bearing check. */
  readonly numBaseFiles: number;
  readonly objectCount: number;
  /** As recorded in the PNAM chunk — `pack-<hex>.idx`, not a path. */
  readonly packNames: ReadonlyArray<string>;
  readonly oidFanoutOffset: number;
  readonly oidLookupOffset: number;
  readonly objectOffsetsOffset: number;
  /** `undefined` when the file carries no LOFF chunk. */
  readonly largeOffsetsOffset: number | undefined;
  readonly largeOffsetCount: number;
  readonly _bytes: Uint8Array;
  readonly _view: DataView;
}

export interface MidxEntry {
  readonly packIndex: number;
  readonly offset: number;
}

interface ChunkRange {
  readonly start: number;
  readonly end: number;
}

interface ChunkTableRow {
  readonly name: string;
  readonly idWord: number;
  readonly offset: number;
}

/**
 * Parses a multi-pack-index file's bytes into its structural fields. Every
 * `DataView` read is proved in-bounds by an earlier gate — a `RangeError`
 * escaping this function is a defect, never an expected error path. The
 * trailer (a digest over everything before it) is never read here: this
 * reader trusts the filesystem, not the checksum, for corruption detection
 * on the hot read path.
 */
export function parseMultiPackIndex(bytes: Uint8Array, digestLength: number): MultiPackIndex {
  if (bytes.length < MIDX_HEADER_SIZE) {
    throw invalidMultiPackIndex('size', 'truncated: file too short for header');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const signature = view.getUint32(0);
  if (signature !== MIDX_MAGIC) {
    throw invalidMultiPackIndex(
      'signature',
      `invalid signature: expected 0x${MIDX_MAGIC.toString(16)}, got 0x${signature.toString(16).padStart(8, '0')}`,
    );
  }

  const version = view.getUint8(4);
  if (version !== 1 && version !== 2) {
    throw invalidMultiPackIndex('version', `unsupported version: expected 1 or 2, got ${version}`);
  }

  const hashVersion = view.getUint8(5);
  if (hashVersion !== 1 && hashVersion !== 2) {
    throw invalidMultiPackIndex(
      'hash-version',
      `unsupported hash version: expected 1 or 2, got ${hashVersion}`,
    );
  }
  const expectedWidth = HASH_VERSION_WIDTH.get(hashVersion)!;
  if (expectedWidth !== digestLength) {
    throw invalidMultiPackIndex(
      'hash-version',
      `hash version ${hashVersion} implies ${expectedWidth}-byte object ids, but the caller declared ${digestLength}`,
    );
  }

  const numChunks = view.getUint8(6);
  const numBaseFiles = view.getUint8(7);
  const numPacks = view.getUint32(8);

  const rows = readChunkTableRows(bytes, view, numChunks, digestLength);
  const chunkRanges = chunkRangesOf(rows);

  const pnam = requireChunk(chunkRanges, CHUNK_ID_PNAM);
  const oidf = requireChunk(chunkRanges, CHUNK_ID_OIDF);
  const oidl = requireChunk(chunkRanges, CHUNK_ID_OIDL);
  const ooff = requireChunk(chunkRanges, CHUNK_ID_OOFF);

  requireChunkSize(oidf, MIDX_FANOUT_SIZE, CHUNK_ID_OIDF);
  const objectCount = validateFanoutMonotonicity(view, oidf.start);

  requireChunkSize(oidl, objectCount * digestLength, CHUNK_ID_OIDL);
  requireChunkSize(ooff, objectCount * 8, CHUNK_ID_OOFF);

  const packNames = parsePackNames(bytes, pnam, numPacks, version);

  const loffRange = chunkRanges.get(CHUNK_ID_LOFF);
  const largeOffsetsOffset = loffRange?.start;
  const largeOffsetCount = loffRange === undefined ? 0 : requireLoffSize(loffRange);

  return {
    version,
    hashVersion,
    digestLength,
    numBaseFiles,
    objectCount,
    packNames,
    oidFanoutOffset: oidf.start,
    oidLookupOffset: oidl.start,
    objectOffsetsOffset: ooff.start,
    largeOffsetsOffset,
    largeOffsetCount,
    _bytes: bytes,
    _view: view,
  };
}

/**
 * Reads every chunk-table row, gating each offset before any chunk body is
 * ever read: never decreasing (an empty chunk repeats the previous offset —
 * a 0-pack PNAM or a 0-object OIDL/OOFF is legitimate), never before the
 * table's own end, and never past the trailer boundary. The final row is
 * the zero-id sentinel that marks the trailer's start.
 */
function readChunkTableRows(
  bytes: Uint8Array,
  view: DataView,
  numChunks: number,
  digestLength: number,
): ReadonlyArray<ChunkTableRow> {
  const rowCount = numChunks + 1;
  const tableEnd = MIDX_HEADER_SIZE + rowCount * MIDX_CHUNK_TABLE_ROW_SIZE;
  const trailerStart = bytes.length - digestLength;
  if (tableEnd > trailerStart) {
    throw invalidMultiPackIndex('chunk-table', 'truncated: chunk table extends past end of file');
  }

  const rows: ChunkTableRow[] = [];
  const seenIds = new Set<number>();
  let previousOffset = tableEnd;
  for (let i = 0; i < rowCount; i += 1) {
    const rowStart = MIDX_HEADER_SIZE + i * MIDX_CHUNK_TABLE_ROW_SIZE;
    const idWord = view.getUint32(rowStart);
    const high = view.getUint32(rowStart + 4);
    const low = view.getUint32(rowStart + 8);
    const offset = high * 0x100000000 + low;

    if (seenIds.has(idWord)) {
      throw invalidMultiPackIndex('chunk-table', `duplicate chunk id at row ${i}`);
    }
    seenIds.add(idWord);
    if (idWord === 0 && i < rowCount - 1) {
      throw invalidMultiPackIndex(
        'chunk-table',
        `terminating chunk id appears at row ${i} before the final row`,
      );
    }
    if (offset % 4 !== 0) {
      throw invalidMultiPackIndex(
        'chunk-table',
        `chunk table offset at row ${i} is not 4-byte aligned`,
      );
    }
    if (offset < previousOffset) {
      throw invalidMultiPackIndex('chunk-table', `chunk table offset at row ${i} moves backward`);
    }
    if (offset > trailerStart) {
      throw invalidMultiPackIndex(
        'chunk-table',
        `chunk table offset at row ${i} extends past end of file`,
      );
    }

    rows.push({ name: decode(bytes.subarray(rowStart, rowStart + 4)), idWord, offset });
    previousOffset = offset;
  }

  if (rows[rows.length - 1]!.idWord !== 0) {
    throw invalidMultiPackIndex('chunk-table', 'final chunk table entry must have id 0');
  }

  return rows;
}

function chunkRangesOf(rows: ReadonlyArray<ChunkTableRow>): ReadonlyMap<string, ChunkRange> {
  const ranges = new Map<string, ChunkRange>();
  for (let i = 0; i < rows.length - 1; i += 1) {
    ranges.set(rows[i]!.name, { start: rows[i]!.offset, end: rows[i + 1]!.offset });
  }
  return ranges;
}

function requireChunk(ranges: ReadonlyMap<string, ChunkRange>, id: string): ChunkRange {
  const range = ranges.get(id);
  if (range === undefined) {
    throw invalidMultiPackIndex('required-chunk', `missing required ${id} chunk`);
  }
  return range;
}

function requireChunkSize(range: ChunkRange, expectedSize: number, id: string): void {
  const actualSize = range.end - range.start;
  if (actualSize !== expectedSize) {
    throw invalidMultiPackIndex(
      'chunk-length',
      `chunk ${id} has size ${actualSize}, expected ${expectedSize}`,
    );
  }
}

/** Validates OIDF monotonicity and returns the object count (`OIDF[255]`). */
function validateFanoutMonotonicity(view: DataView, fanoutStart: number): number {
  let prev = view.getUint32(fanoutStart);
  for (let i = 1; i < MIDX_FANOUT_ENTRIES; i += 1) {
    const current = view.getUint32(fanoutStart + i * 4);
    if (current < prev) {
      throw invalidMultiPackIndex(
        'fanout',
        `non-monotonic OIDF fanout at index ${i}: ${prev} > ${current}`,
      );
    }
    prev = current;
  }
  return prev;
}

function requireLoffSize(range: ChunkRange): number {
  const size = range.end - range.start;
  if (size % 8 !== 0) {
    throw invalidMultiPackIndex('chunk-length', `chunk LOFF has size ${size}, not a multiple of 8`);
  }
  return size / 8;
}

function parsePackNames(
  bytes: Uint8Array,
  range: ChunkRange,
  numPacks: number,
  version: 1 | 2,
): ReadonlyArray<string> {
  const names: string[] = [];
  let cursor = range.start;
  for (let i = 0; i < numPacks; i += 1) {
    let end = cursor;
    while (end < range.end && bytes[end] !== 0) end += 1;
    if (end >= range.end) {
      throw invalidMultiPackIndex(
        'pack-names',
        `pack name ${i} is not NUL-terminated within the PNAM chunk`,
      );
    }
    if (end === cursor) {
      throw invalidMultiPackIndex('pack-names', `pack name ${i} is empty`);
    }
    names.push(decode(bytes.subarray(cursor, end)));
    cursor = end + 1;
  }

  // Bytes left over after the declared `numPacks` names — whether natural
  // 4-byte alignment padding or, when `numPacks` understates the chunk's
  // real content, the untouched remainder — are never checked: git reads
  // exactly `numPacks` names and stops, with no cross-check against PNAM's
  // own chunk-table span. A stricter gate here would refuse files git
  // accepts (confirmed against git 2.55.0), which the prime directive
  // forbids.

  if (version === 1) {
    for (let i = 1; i < names.length; i += 1) {
      if (!(names[i - 1]! < names[i]!)) {
        // The names themselves are attacker-controlled bytes and must not
        // reach the error message raw; the indices identify the pair safely.
        throw invalidMultiPackIndex(
          'pack-names',
          `pack names out of order at entries ${i - 1} and ${i}`,
        );
      }
    }
  }

  return names;
}

function readMidxFanout(midx: MultiPackIndex, byte: number): number {
  return midx._view.getUint32(midx.oidFanoutOffset + byte * 4);
}

function compareMidxOidAt(midx: MultiPackIndex, index: number, targetBytes: Uint8Array): number {
  const base = midx.oidLookupOffset + index * midx.digestLength;
  const bytes = midx._bytes;
  for (let k = 0; k < midx.digestLength; k += 1) {
    const diff = bytes[base + k]! - targetBytes[k]!;
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The large-offset decode rule: bit 31 of the `OOFF` offset word is an
 * indirection into `LOFF` only when a `LOFF` chunk exists; otherwise the
 * word is the offset verbatim, bit 31 included. Reusing the pack `.idx`
 * v2 rule (whose large table is always present) would silently reinterpret
 * a legitimate large plain offset as an indirection.
 */
function readMidxOffset(midx: MultiPackIndex, index: number): number {
  const raw = midx._view.getUint32(midx.objectOffsetsOffset + index * 8 + 4);
  if (midx.largeOffsetsOffset === undefined || (raw & 0x80000000) === 0) {
    return raw >>> 0;
  }
  const row = raw & 0x7fffffff;
  if (row >= midx.largeOffsetCount) {
    throw invalidMultiPackIndex(
      'large-offset',
      `large offset row ${row} out of range for ${midx.largeOffsetCount} entries`,
    );
  }
  const high = midx._view.getUint32(midx.largeOffsetsOffset + row * 8);
  if (high > 0x1fffff) {
    throw invalidMultiPackIndex(
      'large-offset',
      `pack offset exceeds safe JavaScript number range: high word=${high}`,
    );
  }
  const low = midx._view.getUint32(midx.largeOffsetsOffset + row * 8 + 4);
  return high * 0x100000000 + low;
}

function readMidxEntry(midx: MultiPackIndex, index: number): MidxEntry {
  const packIndex = midx._view.getUint32(midx.objectOffsetsOffset + index * 8);
  if (packIndex >= midx.packNames.length) {
    throw invalidMultiPackIndex(
      'pack-int-id',
      `pack index ${packIndex} out of range for ${midx.packNames.length} pack names`,
    );
  }
  return { packIndex, offset: readMidxOffset(midx, index) };
}

/**
 * Fanout-narrowed binary search over OIDL, structurally `lookupPackIndex`'s
 * shape at the midx's own stride (`digestLength`, not a fixed 20).
 */
export function lookupMultiPackIndex(midx: MultiPackIndex, id: ObjectId): MidxEntry | undefined {
  return lookupMultiPackIndexBytes(midx, hexToBytes(id));
}

/**
 * The bytes-taking core of `lookupMultiPackIndex` — a caller probing several
 * chain layers for one oid decodes the hex once and reuses the bytes.
 */
export function lookupMultiPackIndexBytes(
  midx: MultiPackIndex,
  targetBytes: Uint8Array,
): MidxEntry | undefined {
  const firstByte = targetBytes[0]!;
  // Stryker disable next-line ConditionalExpression: equivalent — `lo` only narrows the search
  // window; the loop over [0, hi) still converges on the same index (the target, if present,
  // lies in [lo, hi) ⊆ [0, hi) regardless of the digest stride), so forcing `lo` to 0 cannot
  // change the looked-up entry.
  const lo = firstByte === 0 ? 0 : readMidxFanout(midx, firstByte - 1);
  const hi = readMidxFanout(midx, firstByte);

  let low = lo;
  let high = hi;

  while (low < high) {
    const mid = (low + high) >>> 1;
    const cmp = compareMidxOidAt(midx, mid, targetBytes);
    if (cmp < 0) {
      low = mid + 1;
    } else if (cmp > 0) {
      high = mid;
    } else {
      return readMidxEntry(midx, mid);
    }
  }

  return undefined;
}

/**
 * The oid at OIDL position `index`, hex-encoded. Index-addressed on purpose:
 * an entry walk that already knows the position never re-derives it through
 * the binary search.
 */
export function midxOidAt(midx: MultiPackIndex, index: number): ObjectId {
  const offset = midx.oidLookupOffset + index * midx.digestLength;
  return bytesToHex(midx._bytes.subarray(offset, offset + midx.digestLength)) as ObjectId;
}

/**
 * The decoded entry at OOFF position `index` — the same deferred
 * `pack-int-id` / `large-offset` refusals `lookupMultiPackIndex` raises,
 * without paying its search when the position is already known.
 */
export function midxEntryAt(midx: MultiPackIndex, index: number): MidxEntry {
  return readMidxEntry(midx, index);
}
