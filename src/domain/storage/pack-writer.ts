/**
 * Packfile + pack-index writers. `serializePackfile` emits the v2 pack
 * body (header + base and OFS_DELTA entries) and `serializePackIndex`
 * emits the matching v2 idx (fanout + sha table + crc32 + offsets +
 * trailer). The packfile bytes are not bit-exact across writers (deflate
 * level and delta selection are implementation-defined); fsck acceptance
 * + readback is the contract.
 *
 * @writes
 *   surface: packfile
 *   kind:    equivalent-under-readback
 *   format:  git-packfile-v2
 */
import { concatBytes } from '../objects/encoding.js';
import { crc32 } from './crc32.js';
import { invalidPackEntry, invalidPackIndex } from './error.js';
import {
  type BasePackEntryType,
  encodeOfsDistance,
  encodePackEntryHeader,
  GENERATED_PACK_VERSION,
  PACK_ENTRY_TYPE,
  serializePackHeader,
} from './pack-entry.js';
import { type PackIndexWriterEntry, type SortedEntry, sortPackIndexEntries } from './pack-order.js';

export type { PackIndexWriterEntry };

export interface PackWriterBaseEntry {
  readonly type: BasePackEntryType;
  readonly uncompressedSize: number;
  readonly compressedData: Uint8Array;
}

export interface PackWriterDeltaEntry {
  readonly type: typeof PACK_ENTRY_TYPE.OFS_DELTA;
  /** Inflated length of the DELTA INSTRUCTION STREAM — not the target object. */
  readonly uncompressedSize: number;
  readonly compressedData: Uint8Array;
  /** Index of this delta's base in the SAME entries array; must be < this entry's index. */
  readonly baseIndex: number;
}

export type PackWriterEntry = PackWriterBaseEntry | PackWriterDeltaEntry;

export interface PackEntryMeta {
  readonly crc32: number;
  readonly offset: number;
}

export interface PackfileResult {
  readonly data: Uint8Array;
  readonly entries: ReadonlyArray<PackEntryMeta>;
}

function assertValidBaseIndex(baseIndex: number, i: number, offset: number): void {
  if (baseIndex >= i) {
    throw invalidPackEntry(offset, `OFS_DELTA base index ${baseIndex} is not before entry ${i}`);
  }
  if (baseIndex < 0) {
    throw invalidPackEntry(offset, `OFS_DELTA base index ${baseIndex} out of range`);
  }
  if (!Number.isInteger(baseIndex)) {
    throw invalidPackEntry(offset, `OFS_DELTA base index ${baseIndex} out of range`);
  }
}

function encodeEntryBytes(
  entry: PackWriterEntry,
  offsets: ReadonlyArray<number>,
  currentOffset: number,
): Uint8Array {
  const entryHeader = encodePackEntryHeader(entry.type, entry.uncompressedSize);
  if (entry.type !== PACK_ENTRY_TYPE.OFS_DELTA) {
    return concatBytes([entryHeader, entry.compressedData]);
  }
  const distance = encodeOfsDistance(currentOffset - offsets[entry.baseIndex]!);
  return concatBytes([entryHeader, distance, entry.compressedData]);
}

export function serializePackfile(entries: ReadonlyArray<PackWriterEntry>): PackfileResult {
  const header = serializePackHeader(GENERATED_PACK_VERSION, entries.length);

  const chunks: Uint8Array[] = [header];
  const metas: PackEntryMeta[] = [];
  const offsets: number[] = [];
  let currentOffset = header.length;

  for (const [i, entry] of entries.entries()) {
    if (entry.type === PACK_ENTRY_TYPE.OFS_DELTA) {
      assertValidBaseIndex(entry.baseIndex, i, currentOffset);
    }

    const entryBytes = encodeEntryBytes(entry, offsets, currentOffset);
    metas.push({ crc32: crc32(entryBytes), offset: currentOffset });
    offsets.push(currentOffset);
    chunks.push(entryBytes);
    currentOffset += entryBytes.length;
  }

  return { data: concatBytes(chunks), entries: metas };
}

export function serializePackIndex(
  entries: ReadonlyArray<PackIndexWriterEntry>,
  packChecksum: Uint8Array,
  presorted?: ReadonlyArray<SortedEntry>,
): Uint8Array {
  const digestLength = packChecksum.length;
  if (digestLength !== 20 && digestLength !== 32) {
    throw invalidPackIndex(`packChecksum must be 20 or 32 bytes, got ${digestLength}`);
  }

  // `presorted` MUST be `sortPackIndexEntries(entries)` — a caller writing the
  // sibling `.rev` from the same entry set passes it so the oid sort runs once
  // per pack write instead of once per artefact.
  const withBytes = presorted ?? sortPackIndexEntries(entries);

  const n = withBytes.length;
  let largeCount = 0;
  for (const e of withBytes) {
    if (e.entry.offset > 0x7fffffff) largeCount += 1;
  }

  const headerSize = 8;
  const fanoutSize = 1024;
  const shaTableSize = n * digestLength;
  const crcTableSize = n * 4;
  const offsetTableSize = n * 4;
  const largeOffsetTableSize = largeCount * 8;
  const checksumSize = digestLength;

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
    bytes.set(withBytes[i]!.shaBytes, shaStart + i * digestLength);
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
