import { bytesToHex, decode } from '../objects/encoding.js';
import type { FileMode, FilePath, ObjectId } from '../objects/index.js';
import { FilePath as FilePathFactory, normalizeFileMode } from '../objects/index.js';
import { invalidIndexEntry, invalidIndexHeader } from './error.js';
import type { GitIndex, IndexEntry, IndexEntryFlags, IndexExtension } from './index-entry.js';

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
  if (version !== 2) {
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
    const flags = parseFlags(flagsRaw, offset);

    const mode = normalizeFileMode(rawMode.toString(8)) as FileMode;
    offset += ENTRY_HEADER_SIZE;

    const nulEnd = findNul(bytes, offset);
    if (nulEnd === -1) {
      throw invalidIndexEntry(entryStart, 'missing NUL terminator');
    }

    const nameLength = flagsRaw & 0xfff;
    const pathEnd = nameLength === 0xfff ? nulEnd : offset + nameLength;
    const path = decode(bytes.subarray(offset, pathEnd));

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

  return { version: 2, entries, extensions };
}

function parseFlags(raw: number, offset: number): IndexEntryFlags {
  const assumeValid = (raw & 0x8000) !== 0;
  const extended = (raw & 0x4000) !== 0;
  if (extended) {
    throw invalidIndexEntry(offset, 'extended flag not supported in v2');
  }
  const stage = ((raw >>> 12) & 0x3) as 0 | 1 | 2 | 3;
  return { assumeValid, extended: false, stage };
}

function findNul(bytes: Uint8Array, fromIndex: number): number {
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
