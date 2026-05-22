import { bytesToHex, decode } from '../objects/encoding.js';
import type { FileMode, FilePath, ObjectId } from '../objects/index.js';
import { FilePath as FilePathFactory, normalizeFileMode } from '../objects/index.js';
import { invalidIndexEntry, invalidIndexHeader } from './error.js';
import type { GitIndex, IndexEntry, IndexEntryFlags, IndexExtension } from './index-entry.js';
import { validateIndexPath } from './path-validator.js';

const DIRC_SIGNATURE = 0x44495243;
const INDEX_HEADER_SIZE = 12;
const INDEX_CHECKSUM_SIZE = 20;
const ENTRY_HEADER_SIZE = 62;

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

    const shaBytes = bytes.subarray(offset + 40, offset + 60);
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

  return { version: version as 2 | 3, entries, extensions };
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
