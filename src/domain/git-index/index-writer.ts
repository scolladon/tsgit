/**
 * Index writer. Emits the DIRC binary format (v2 + v3) consumed by
 * canonical git's `git ls-files`, `git diff --cached`, and so on. Bytes
 * include per-host stat-cache fields (mtime/ctime/dev/ino), so the
 * contract is equivalence-under-readback rather than byte-identical
 * across writers.
 *
 * @writes
 *   surface: index
 *   kind:    equivalent-under-readback
 *   format:  git-index-dirc
 */
import { encode, hexToBytes } from '../objects/encoding.js';
import type { GitIndex, IndexEntry } from './index-entry.js';

const DIRC_SIGNATURE = 0x44495243;
const ENTRY_HEADER_SIZE = 62;

/**
 * Lexicographic comparator for index entries. Git stores entries
 * byte-sorted by path; this returns the standard `-1 / 0 / +1` triple so
 * `Array.prototype.sort` produces ascending path order and leaves
 * equal-path entries in their original (stable) order.
 */
export function compareEntryPath(a: IndexEntry, b: IndexEntry): number {
  const left = a.path as string;
  const right = b.path as string;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function serializeIndex(index: GitIndex): Uint8Array {
  const sortedEntries = [...index.entries].sort(compareEntryPath);

  const entryMetas = sortedEntries.map((entry) => {
    const pathBytes = encode(entry.path as string);
    const extended = entry.flags.skipWorktree || entry.flags.intentToAdd;
    const entryLength = ENTRY_HEADER_SIZE + (extended ? 2 : 0) + pathBytes.length;
    const paddedLength = (entryLength + 8) & ~7;
    return { entry, pathBytes, extended, paddedLength };
  });

  const extensionMetas = index.extensions.map((ext) => {
    const sigBytes = encode(ext.signature);
    return { ext, sigBytes, totalLength: 8 + ext.data.length };
  });

  const totalSize =
    12 +
    entryMetas.reduce((sum, m) => sum + m.paddedLength, 0) +
    extensionMetas.reduce((sum, m) => sum + m.totalLength, 0);

  const result = new Uint8Array(totalSize);
  const view = new DataView(result.buffer);

  // The on-disk version is the MINIMUM that can represent these entries: v3
  // iff any entry carries an extended flag (skip-worktree / intent-to-add),
  // else v2. `index.version` is informational and intentionally ignored — a
  // caller handing `{ version: 2 }` with a skip-worktree entry still gets a
  // correct v3 file (v2 cannot represent it).
  const version = entryMetas.some((m) => m.extended) ? 3 : 2;
  view.setUint32(0, DIRC_SIGNATURE);
  view.setUint32(4, version);
  view.setUint32(8, sortedEntries.length);

  let offset = 12;
  for (const { entry, pathBytes, extended, paddedLength } of entryMetas) {
    writeEntry(result, view, offset, entry, pathBytes, extended);
    offset += paddedLength;
  }
  for (const { ext, sigBytes, totalLength } of extensionMetas) {
    result.set(sigBytes, offset);
    view.setUint32(offset + 4, ext.data.length);
    result.set(ext.data, offset + 8);
    offset += totalLength;
  }

  return result;
}

function writeEntry(
  buf: Uint8Array,
  view: DataView,
  offset: number,
  entry: IndexEntry,
  pathBytes: Uint8Array,
  extended: boolean,
): void {
  view.setUint32(offset, entry.ctimeSeconds);
  view.setUint32(offset + 4, entry.ctimeNanoseconds);
  view.setUint32(offset + 8, entry.mtimeSeconds);
  view.setUint32(offset + 12, entry.mtimeNanoseconds);
  view.setUint32(offset + 16, entry.dev);
  view.setUint32(offset + 20, entry.ino);
  view.setUint32(offset + 24, Number.parseInt(entry.mode, 8));
  view.setUint32(offset + 28, entry.uid);
  view.setUint32(offset + 32, entry.gid);
  view.setUint32(offset + 36, entry.fileSize);

  const shaBytes = hexToBytes(entry.id);
  buf.set(shaBytes, offset + 40);

  const nameLength = Math.min(pathBytes.length, 0xfff);
  const flagsRaw =
    (entry.flags.assumeValid ? 0x8000 : 0) |
    (extended ? 0x4000 : 0) |
    (entry.flags.stage << 12) |
    nameLength;
  view.setUint16(offset + 60, flagsRaw);

  // Index v3 extended-flags word — emitted only for an entry that needs it.
  // Stryker disable next-line ConditionalExpression: equivalent — forcing the guard true for a non-extended entry writes extRaw (always 0, as skipWorktree/intentToAdd are both false) at offset+62, which the next `buf.set(pathBytes, offset+62)` overwrites; the zero-init buffer makes any un-overwritten byte identical.
  if (extended) {
    const extRaw = (entry.flags.skipWorktree ? 0x4000 : 0) | (entry.flags.intentToAdd ? 0x2000 : 0);
    view.setUint16(offset + ENTRY_HEADER_SIZE, extRaw);
  }

  buf.set(pathBytes, offset + ENTRY_HEADER_SIZE + (extended ? 2 : 0));
}
