import { encode, hexToBytes } from '../objects/encoding.js';
import type { GitIndex, IndexEntry } from './index-entry.js';

const DIRC_SIGNATURE = 0x44495243;
const ENTRY_HEADER_SIZE = 62;

export function serializeIndex(index: GitIndex): Uint8Array {
  const sortedEntries = [...index.entries].sort((a, b) =>
    (a.path as string) < (b.path as string) ? -1 : (a.path as string) > (b.path as string) ? 1 : 0,
  );

  const entryMetas = sortedEntries.map((entry) => {
    const pathBytes = encode(entry.path as string);
    const entryLength = ENTRY_HEADER_SIZE + pathBytes.length;
    const paddedLength = (entryLength + 8) & ~7;
    return { entry, pathBytes, paddedLength };
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

  view.setUint32(0, DIRC_SIGNATURE);
  view.setUint32(4, 2);
  view.setUint32(8, sortedEntries.length);

  let offset = 12;
  for (const { entry, pathBytes, paddedLength } of entryMetas) {
    writeEntry(result, view, offset, entry, pathBytes);
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
  const flagsRaw = (entry.flags.assumeValid ? 0x8000 : 0) | (entry.flags.stage << 12) | nameLength;
  view.setUint16(offset + 60, flagsRaw);

  buf.set(pathBytes, offset + ENTRY_HEADER_SIZE);
}
