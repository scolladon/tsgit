import { compareBytes, hexToBytes } from '../objects/encoding.js';
import { crc32 } from './crc32.js';
import { invalidPackIndex } from './error.js';
import {
  type BasePackEntryType,
  encodePackEntryHeader,
  serializePackHeader,
} from './pack-entry.js';

export interface PackWriterEntry {
  readonly type: BasePackEntryType;
  readonly uncompressedSize: number;
  readonly compressedData: Uint8Array;
}

export interface PackEntryMeta {
  readonly crc32: number;
  readonly offset: number;
}

export interface PackfileResult {
  readonly data: Uint8Array;
  readonly entries: ReadonlyArray<PackEntryMeta>;
}

export interface PackIndexWriterEntry {
  readonly id: string;
  readonly crc32: number;
  readonly offset: number;
}

export function serializePackfile(entries: ReadonlyArray<PackWriterEntry>): PackfileResult {
  const header = serializePackHeader(2, entries.length);

  const chunks: Uint8Array[] = [header];
  const metas: PackEntryMeta[] = [];
  let currentOffset = header.length;

  for (const entry of entries) {
    const entryHeader = encodePackEntryHeader(entry.type, entry.uncompressedSize);
    const entryBytes = concat(entryHeader, entry.compressedData);
    const entryCrc = crc32(entryBytes);

    metas.push({ crc32: entryCrc, offset: currentOffset });
    chunks.push(entryBytes);
    currentOffset += entryBytes.length;
  }

  return { data: concatAll(chunks), entries: metas };
}

const IDX_SHA_LENGTH = 20;

interface SortedEntry {
  readonly shaBytes: Uint8Array;
  readonly entry: PackIndexWriterEntry;
}

export function serializePackIndex(
  entries: ReadonlyArray<PackIndexWriterEntry>,
  packChecksum: Uint8Array,
): Uint8Array {
  if (packChecksum.length !== IDX_SHA_LENGTH) {
    throw invalidPackIndex(
      `packChecksum must be ${IDX_SHA_LENGTH} bytes, got ${packChecksum.length}`,
    );
  }

  const withBytes: SortedEntry[] = entries.map((entry) => ({
    shaBytes: hexToBytes(entry.id),
    entry,
  }));
  withBytes.sort((a, b) => compareBytes(a.shaBytes, b.shaBytes));

  const n = withBytes.length;
  let largeCount = 0;
  for (const e of withBytes) {
    if (e.entry.offset > 0x7fffffff) largeCount += 1;
  }

  const headerSize = 8;
  const fanoutSize = 1024;
  const shaTableSize = n * IDX_SHA_LENGTH;
  const crcTableSize = n * 4;
  const offsetTableSize = n * 4;
  const largeOffsetTableSize = largeCount * 8;
  const checksumSize = IDX_SHA_LENGTH;

  const totalSize =
    headerSize +
    fanoutSize +
    shaTableSize +
    crcTableSize +
    offsetTableSize +
    largeOffsetTableSize +
    checksumSize;

  const bytes = new Uint8Array(totalSize);
  const view = new DataView(bytes.buffer);

  // Header
  view.setUint32(0, 0xff744f63);
  view.setUint32(4, 2);

  // Fanout table — count per bucket, then cumulate (O(N + 256) instead of O(N * 256))
  const bucketCounts = new Uint32Array(256);
  for (const { shaBytes } of withBytes) {
    bucketCounts[shaBytes[0]!]! += 1;
  }
  const fanout = new Uint32Array(256);
  let cumulative = 0;
  // Stryker disable next-line EqualityOperator: equivalent — at i=256 bucketCounts[256] is undefined (Uint32Array len 256) so cumulative becomes NaN and fanout[256]=NaN is an out-of-bounds no-op; fanout[0..255] are already final, so no observable change.
  for (let i = 0; i < 256; i++) {
    cumulative += bucketCounts[i]!;
    fanout[i] = cumulative;
  }
  const fanoutOffset = headerSize;
  // Stryker disable next-line EqualityOperator: equivalent — relaxing the bound to `i <= 256` adds one write at byte offset `fanoutOffset + 1024`, the start of the SHA table region; `fanout[256]` is `undefined` → coerced to 0, and those 4 bytes are unconditionally overwritten afterwards (by the SHA-table loop when n>=1, or by the trailing pack checksum when n===0), so the emitted index is byte-identical.
  for (let i = 0; i < 256; i++) {
    view.setUint32(fanoutOffset + i * 4, fanout[i]!);
  }

  // SHA table — reuse pre-computed bytes
  const shaStart = fanoutOffset + fanoutSize;
  for (let i = 0; i < n; i++) {
    bytes.set(withBytes[i]!.shaBytes, shaStart + i * IDX_SHA_LENGTH);
  }

  // CRC-32 table
  const crcStart = shaStart + shaTableSize;
  for (let i = 0; i < n; i++) {
    view.setUint32(crcStart + i * 4, withBytes[i]!.entry.crc32);
  }

  // Offset table
  const offsetStart = crcStart + crcTableSize;
  let largeIdx = 0;
  const largeOffsetStart = offsetStart + offsetTableSize;

  for (let i = 0; i < n; i++) {
    const offset = withBytes[i]!.entry.offset;
    if (offset > 0x7fffffff) {
      view.setUint32(offsetStart + i * 4, 0x80000000 | largeIdx);
      const high = Math.floor(offset / 0x100000000);
      const low = offset >>> 0;
      view.setUint32(largeOffsetStart + largeIdx * 8, high);
      view.setUint32(largeOffsetStart + largeIdx * 8 + 4, low);
      largeIdx += 1;
    } else {
      view.setUint32(offsetStart + i * 4, offset);
    }
  }

  // Pack checksum
  bytes.set(packChecksum, totalSize - checksumSize);

  return bytes;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result;
}

function concatAll(arrays: ReadonlyArray<Uint8Array>): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
