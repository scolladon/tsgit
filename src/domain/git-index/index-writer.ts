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
import { compareBytes, encode, hexToBytes } from '../objects/encoding.js';
import type { GitIndex, IndexEntry } from './index-entry.js';
import { type IndexPath, pathBytesOf } from './index-path-key.js';

const DIRC_SIGNATURE = 0x44495243;
const STAT_FIELDS_SIZE = 40;
const FLAGS_WORD_SIZE = 2;

/**
 * The width of every entry's oid this module writes comes from a single
 * `digestLength` `serializeIndex` takes as its last parameter (the caller's
 * `ctx.hashConfig.digestLength`) — the same repository-wide width
 * `index-parser.ts` reads back at. These are the two derived offsets
 * `writeEntry` needs; the oid itself is always written at `offset + 40`
 * (self-sizing from `entry.id`'s own hex length) regardless of width.
 */
function entryHeaderSize(digestLength: 20 | 32): number {
  return STAT_FIELDS_SIZE + digestLength + FLAGS_WORD_SIZE;
}

function flagsOffset(digestLength: 20 | 32): number {
  return STAT_FIELDS_SIZE + digestLength;
}

const SURROGATE_START = 0xd800;
const PRIVATE_USE_START = 0xe000;
const SURROGATE_RANK_SHIFT = 0x2000;
const PRIVATE_USE_RANK_SHIFT = 0x800;

/**
 * Orders UTF-16 code units the way their UTF-8 bytes order: surrogates
 * (astral code points, 4 UTF-8 bytes) sort after U+E000-U+FFFF.
 */
function utf8Rank(unit: number): number {
  if (unit < SURROGATE_START) return unit;
  return unit >= PRIVATE_USE_START ? unit - PRIVATE_USE_RANK_SHIFT : unit + SURROGATE_RANK_SHIFT;
}

/**
 * Byte-order comparator for index entries. Git stores entries sorted by the
 * UTF-8 bytes of the path; comparing code units with a rank fix-up at the
 * first difference yields that order without encoding. Returns a negative,
 * zero or positive number so `Array.prototype.sort` produces ascending path
 * order and leaves equal-path entries in their original (stable) order.
 * A pair where either side carries raw `pathBytes` (a path that is not valid
 * UTF-8) compares those bytes, since the decoded view cannot rank them.
 */
export function compareEntryPath(a: IndexPath, b: IndexPath): number {
  if (a.pathBytes === undefined && b.pathBytes === undefined) {
    return comparePathStrings(a.path as string, b.path as string);
  }
  return compareBytes(pathBytesOf(a), pathBytesOf(b));
}

export function comparePathStrings(left: string, right: string): number {
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    const l = left.charCodeAt(i);
    const r = right.charCodeAt(i);
    if (l !== r) return utf8Rank(l) - utf8Rank(r);
  }
  return left.length - right.length;
}

const SURROGATE_OR_ABOVE = /[\ud800-\uffff]/;

function compareUtf16Strings(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

const compareUtf16Path = (a: IndexPath, b: IndexPath): number =>
  compareUtf16Strings(a.path as string, b.path as string);

/** Same pick-once rule as `pathComparatorFor`, for bare path strings. */
export function pathStringComparatorFor(paths: ReadonlyArray<string>): typeof comparePathStrings {
  return paths.some((path) => SURROGATE_OR_ABOVE.test(path))
    ? comparePathStrings
    : compareUtf16Strings;
}

/**
 * UTF-16 and UTF-8 byte order only disagree when a path holds a code unit at
 * or above U+D800, so the engine's native string comparison serves every
 * other index at a fraction of the cost of the code-unit loop. A lossy path's
 * decoded view always holds U+FFFD, so every index with raw path bytes takes
 * the byte-aware comparator.
 */
export function pathComparatorFor(entries: ReadonlyArray<IndexPath>): typeof compareEntryPath {
  return entries.some((entry) => SURROGATE_OR_ABOVE.test(entry.path as string))
    ? compareEntryPath
    : compareUtf16Path;
}

/** `items` itself when already ordered (one O(n) pass), else a sorted copy: the input is never mutated. */
export function inOrder<T>(
  items: ReadonlyArray<T>,
  compare: (a: T, b: T) => number,
): ReadonlyArray<T> {
  for (let i = 1; i < items.length; i++) {
    if (compare(items[i - 1] as T, items[i] as T) > 0) return [...items].sort(compare);
  }
  return items;
}

export function serializeIndex(index: GitIndex, digestLength: 20 | 32): Uint8Array {
  const headerSize = entryHeaderSize(digestLength);
  const sortedEntries = [...index.entries].sort(pathComparatorFor(index.entries));

  const entryMetas = sortedEntries.map((entry) => {
    const pathBytes = pathBytesOf(entry);
    const extended = entry.flags.skipWorktree || entry.flags.intentToAdd;
    const entryLength = headerSize + (extended ? 2 : 0) + pathBytes.length;
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
    writeEntry(result, view, offset, entry, pathBytes, extended, digestLength);
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
  digestLength: 20 | 32,
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
  view.setUint16(offset + flagsOffset(digestLength), flagsRaw);

  const headerSize = entryHeaderSize(digestLength);
  // Index v3 extended-flags word — emitted only for an entry that needs it.
  // Stryker disable next-line ConditionalExpression: equivalent — forcing the guard true for a non-extended entry writes extRaw (always 0, as skipWorktree/intentToAdd are both false) at offset+headerSize, which the next `buf.set(pathBytes, offset+headerSize)` overwrites; the zero-init buffer makes any un-overwritten byte identical.
  if (extended) {
    const extRaw = (entry.flags.skipWorktree ? 0x4000 : 0) | (entry.flags.intentToAdd ? 0x2000 : 0);
    view.setUint16(offset + headerSize, extRaw);
  }

  buf.set(pathBytes, offset + headerSize + (extended ? 2 : 0));
}
