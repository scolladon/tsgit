import { compareBytes, hexToBytes } from '../objects/encoding.js';

export interface PackIndexWriterEntry {
  readonly id: string;
  readonly crc32: number;
  readonly offset: number;
}

export interface SortedEntry {
  readonly shaBytes: Uint8Array;
  readonly entry: PackIndexWriterEntry;
}

/**
 * Writer entries paired with their raw oid bytes, oid-ascending — the index
 * order the `.idx` encodes and the `.rev` permutes. The single ordering step
 * `serializePackIndex` and `serializePackRevIndex` both build on, so the two
 * artefacts cannot disagree about the entry set's oid order.
 */
export function sortPackIndexEntries(
  entries: ReadonlyArray<PackIndexWriterEntry>,
): ReadonlyArray<SortedEntry> {
  const withBytes: SortedEntry[] = entries.map((entry) => ({
    shaBytes: hexToBytes(entry.id),
    entry,
  }));
  withBytes.sort((a, b) => compareBytes(a.shaBytes, b.shaBytes));
  return withBytes;
}
