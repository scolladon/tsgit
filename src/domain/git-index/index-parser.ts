import { bytesToHex, decode, indexOf } from '../objects/encoding.js';
import type { FileMode, FilePath, ObjectId } from '../objects/index.js';
import { FilePath as FilePathFactory, normalizeFileMode } from '../objects/index.js';
import { invalidIndexEntry, invalidIndexHeader } from './error.js';
import type {
  CacheTreeEntry,
  GitIndex,
  IndexEntry,
  IndexEntryFlags,
  IndexExtension,
} from './index-entry.js';
import { validateIndexPath } from './path-validator.js';

const DIRC_SIGNATURE = 0x44495243;
const INDEX_HEADER_SIZE = 12;
/**
 * The width of EVERY oid this module reads — an entry's own sha, the file's
 * trailing checksum, and a cache-tree entry's oid alike. The index parser is
 * SHA-1-only, deliberately and as a whole: git sizes all three together from
 * the repository's hash algorithm, so widening one without the others would
 * mis-frame the file rather than read a SHA-256 index. That is why
 * `parseCacheTree` takes no `digestLength` parameter the way the pack-side
 * parsers do — the width is not a per-function choice here.
 */
const INDEX_OID_LENGTH = 20;
const INDEX_CHECKSUM_SIZE = INDEX_OID_LENGTH;
const ENTRY_HEADER_SIZE = 62;
const CACHE_TREE_OID_LENGTH = INDEX_OID_LENGTH;
const CACHE_TREE_SPACE = 0x20;
const CACHE_TREE_LF = 0x0a;
/**
 * Same bound the tree walkers hold: a cache-tree nests through mutual
 * recursion (`parseCacheTreeEntry` <-> `readCacheTreeChildren`), and its
 * cheapest nesting unit is six bytes, so an index carrying a hostile `TREE`
 * extension would otherwise drive the parser past the call stack from a few
 * kilobytes of payload.
 */
const MAX_CACHE_TREE_DEPTH = 1024;

export function parseIndex(bytes: Uint8Array): GitIndex {
  if (bytes.length < INDEX_HEADER_SIZE) {
    throw invalidIndexHeader('truncated header');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (view.getUint32(0) !== DIRC_SIGNATURE) {
    throw invalidIndexHeader('invalid signature: expected DIRC');
  }

  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) {
    throw invalidIndexHeader(`unsupported version: ${version}`);
  }

  const entryCount = view.getUint32(8);
  const maxEntryBytes = bytes.length - INDEX_HEADER_SIZE - INDEX_CHECKSUM_SIZE;
  if (entryCount * ENTRY_HEADER_SIZE > maxEntryBytes) {
    throw invalidIndexHeader(`entry count ${entryCount} exceeds file capacity`);
  }

  let offset = INDEX_HEADER_SIZE;
  const entries: IndexEntry[] = [];

  for (let i = 0; i < entryCount; i++) {
    const entryStart = offset;
    if (offset + ENTRY_HEADER_SIZE > bytes.length - INDEX_CHECKSUM_SIZE) {
      throw invalidIndexEntry(offset, 'truncated entry');
    }

    const ctimeSeconds = view.getUint32(offset);
    const ctimeNanoseconds = view.getUint32(offset + 4);
    const mtimeSeconds = view.getUint32(offset + 8);
    const mtimeNanoseconds = view.getUint32(offset + 12);
    const dev = view.getUint32(offset + 16);
    const ino = view.getUint32(offset + 20);
    const rawMode = view.getUint32(offset + 24);
    const uid = view.getUint32(offset + 28);
    const gid = view.getUint32(offset + 32);
    const fileSize = view.getUint32(offset + 36);

    const shaBytes = bytes.subarray(offset + 40, offset + 40 + INDEX_OID_LENGTH);
    const id = bytesToHex(shaBytes) as ObjectId;

    const flagsRaw = view.getUint16(offset + 60);
    const { flags, extendedSize } = decodeEntryFlags(view, offset, version, bytes.length);

    const mode = normalizeFileMode(rawMode.toString(8)) as FileMode;
    offset += ENTRY_HEADER_SIZE + extendedSize;

    const nulEnd = findNul(bytes, offset);
    if (nulEnd === -1) {
      throw invalidIndexEntry(entryStart, 'missing NUL terminator');
    }

    const nameLength = flagsRaw & 0xfff;
    const pathEnd = nameLength === 0xfff ? nulEnd : offset + nameLength;
    const path = decode(bytes.subarray(offset, pathEnd));
    validateIndexPath(path, entryStart);

    offset = nulEnd + 1;

    const entryLength = offset - entryStart;
    const paddedLength = (entryLength + 7) & ~7;
    offset = entryStart + paddedLength;

    entries.push({
      ctimeSeconds,
      ctimeNanoseconds,
      mtimeSeconds,
      mtimeNanoseconds,
      dev,
      ino,
      mode,
      uid,
      gid,
      fileSize,
      id,
      flags,
      path: FilePathFactory.from(path) as FilePath,
    });
  }

  const extensions = parseExtensions(bytes, offset, view);
  const trailerSha = bytes.slice(bytes.length - INDEX_CHECKSUM_SIZE);

  return { version: version as 2 | 3, entries, extensions, trailerSha };
}

/**
 * Decode an entry's flags. Reads the 16-bit `flags` word at `offset + 60`;
 * when its extended (`0x4000`) bit is set, also reads the index-v3 16-bit
 * extended-flags word that follows the 62-byte fixed header. Returns the
 * decoded {@link IndexEntryFlags} plus `extendedSize` (`2` for an extended
 * entry, `0` otherwise) so the caller can advance the cursor.
 */
function decodeEntryFlags(
  view: DataView,
  offset: number,
  version: number,
  byteLength: number,
): { readonly flags: IndexEntryFlags; readonly extendedSize: number } {
  const flagsRaw = view.getUint16(offset + 60);
  const extended = (flagsRaw & 0x4000) !== 0;
  if (extended && version !== 3) {
    throw invalidIndexEntry(offset, 'extended flag requires index v3');
  }
  const extendedSize = extended ? 2 : 0;
  if (offset + ENTRY_HEADER_SIZE + extendedSize > byteLength - INDEX_CHECKSUM_SIZE) {
    throw invalidIndexEntry(offset, 'truncated extended flags');
  }
  const extRaw = extended ? view.getUint16(offset + ENTRY_HEADER_SIZE) : 0;
  return { flags: parseFlags(flagsRaw, extRaw), extendedSize };
}

/**
 * Decode the 16-bit `flags` word and, for an index-v3 extended entry, the
 * extra 16-bit extended-flags word. `extRaw` is `0` for a non-extended entry,
 * which yields `skipWorktree: false` / `intentToAdd: false`.
 */
function parseFlags(raw: number, extRaw: number): IndexEntryFlags {
  const assumeValid = (raw & 0x8000) !== 0;
  const stage = ((raw >>> 12) & 0x3) as 0 | 1 | 2 | 3;
  const skipWorktree = (extRaw & 0x4000) !== 0;
  const intentToAdd = (extRaw & 0x2000) !== 0;
  return { assumeValid, stage, skipWorktree, intentToAdd };
}

function findNul(bytes: Uint8Array, fromIndex: number): number {
  // Stryker disable next-line EqualityOperator: equivalent — at i === bytes.length the extra iteration reads bytes[length] which is undefined; `undefined === 0` is false so no NUL is matched and the function still returns -1.
  for (let i = fromIndex; i < bytes.length; i++) {
    if (bytes[i] === 0) return i;
  }
  return -1;
}

function parseExtensions(
  bytes: Uint8Array,
  offset: number,
  view: DataView,
): ReadonlyArray<IndexExtension> {
  const extensions: IndexExtension[] = [];
  const extensionEnd = bytes.length - INDEX_CHECKSUM_SIZE;

  while (offset + 8 <= extensionEnd) {
    const signature = decode(bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4);

    if (offset + 8 + size > extensionEnd) {
      throw invalidIndexEntry(offset, 'extension size exceeds remaining bytes');
    }

    const firstChar = signature.charCodeAt(0);
    if (firstChar >= 97 && firstChar <= 122) {
      const safe = signature.replace(/[^\x20-\x7e]/g, '?');
      throw invalidIndexEntry(offset, `mandatory extension '${safe}' not supported`);
    }

    const data = bytes.slice(offset + 8, offset + 8 + size);
    extensions.push({ signature, data });
    offset += 8 + size;
  }

  return extensions;
}

/**
 * Parse the index's `TREE` (cache-tree) extension payload into its rooted,
 * depth-first entry tree. Per-entry grammar: a NUL-terminated path
 * component, then ASCII `<entry_count> SP <subtree_count> LF`, then — only
 * when `entry_count >= 0` — the raw oid. `subtree_count` further entries
 * follow immediately, each parsed the same way, which is what produces the
 * depth-first nesting — bounded at `MAX_CACHE_TREE_DEPTH`, since that nesting
 * is the one thing an untrusted payload gets to drive without limit. The oid
 * is read at `INDEX_OID_LENGTH`, the SHA-1 width the whole index parser is
 * fixed to.
 */
export function parseCacheTree(data: Uint8Array): CacheTreeEntry {
  const { entry, offset } = parseCacheTreeEntry(data, 0, 0);
  if (offset !== data.length) {
    throw invalidIndexEntry(offset, 'cache-tree data has trailing bytes');
  }
  return entry;
}

function parseCacheTreeEntry(
  data: Uint8Array,
  start: number,
  depth: number,
): { readonly entry: CacheTreeEntry; readonly offset: number } {
  if (depth > MAX_CACHE_TREE_DEPTH) {
    throw invalidIndexEntry(start, 'cache-tree nesting exceeds the maximum depth');
  }
  const pathEnd = findNul(data, start);
  if (pathEnd === -1) {
    throw invalidIndexEntry(start, 'cache-tree entry missing NUL-terminated path');
  }
  const path = decode(data.subarray(start, pathEnd));

  const spaceIndex = indexOf(data, CACHE_TREE_SPACE, pathEnd + 1);
  if (spaceIndex === -1) {
    throw invalidIndexEntry(start, 'cache-tree entry missing entry-count separator');
  }
  const entryCount = parseCacheTreeEntryCount(
    decode(data.subarray(pathEnd + 1, spaceIndex)),
    start,
  );

  // Stryker disable next-line ArithmeticOperator: equivalent — the entry count parsed just above matched /^-?\d+$/, so data[spaceIndex-1] is always an ASCII digit and data[spaceIndex] the separator space; neither byte is LF, so a scan started at spaceIndex-1 finds the same LF as one started at spaceIndex+1
  const lfIndex = indexOf(data, CACHE_TREE_LF, spaceIndex + 1);
  if (lfIndex === -1) {
    throw invalidIndexEntry(start, 'cache-tree entry missing subtree-count terminator');
  }
  const subtreeCount = parseCacheTreeSubtreeCount(
    decode(data.subarray(spaceIndex + 1, lfIndex)),
    start,
  );

  const { id, offset: afterOid } = readCacheTreeOid(data, lfIndex + 1, entryCount, start);
  return readCacheTreeChildren(data, afterOid, subtreeCount, depth, {
    path,
    entryCount,
    subtreeCount,
    id,
  });
}

function readCacheTreeOid(
  data: Uint8Array,
  offset: number,
  entryCount: number,
  entryStart: number,
): { readonly id: ObjectId | undefined; readonly offset: number } {
  if (entryCount < 0) return { id: undefined, offset };
  if (offset + CACHE_TREE_OID_LENGTH > data.length) {
    throw invalidIndexEntry(entryStart, 'cache-tree entry truncated oid');
  }
  const id = bytesToHex(data.subarray(offset, offset + CACHE_TREE_OID_LENGTH)) as ObjectId;
  return { id, offset: offset + CACHE_TREE_OID_LENGTH };
}

function readCacheTreeChildren(
  data: Uint8Array,
  start: number,
  subtreeCount: number,
  depth: number,
  base: {
    readonly path: string;
    readonly entryCount: number;
    readonly subtreeCount: number;
    readonly id: ObjectId | undefined;
  },
): { readonly entry: CacheTreeEntry; readonly offset: number } {
  const children: CacheTreeEntry[] = [];
  let cursor = start;
  for (let i = 0; i < subtreeCount; i++) {
    const child = parseCacheTreeEntry(data, cursor, depth + 1);
    children.push(child.entry);
    cursor = child.offset;
  }
  const entry: CacheTreeEntry =
    base.id === undefined
      ? { path: base.path, entryCount: base.entryCount, subtreeCount: base.subtreeCount, children }
      : {
          path: base.path,
          entryCount: base.entryCount,
          subtreeCount: base.subtreeCount,
          id: base.id,
          children,
        };
  return { entry, offset: cursor };
}

function parseCacheTreeEntryCount(text: string, offset: number): number {
  if (!/^-?\d+$/.test(text)) {
    throw invalidIndexEntry(offset, 'cache-tree entry has a malformed entry count');
  }
  return Number.parseInt(text, 10);
}

function parseCacheTreeSubtreeCount(text: string, offset: number): number {
  if (!/^\d+$/.test(text)) {
    throw invalidIndexEntry(offset, 'cache-tree entry has a malformed subtree count');
  }
  return Number.parseInt(text, 10);
}
