import { compareBytes, decode, encode, hexToBytes, indexOf } from './encoding.js';
import { invalidTreeEntry } from './error.js';
import type { FileMode } from './file-mode.js';
import { isDirectory, normalizeFileMode } from './file-mode.js';
import type { HashConfig } from './hash-config.js';
import type { ObjectId } from './object-id.js';
import { ObjectId as ObjectIdFactory } from './object-id.js';

export interface TreeEntry {
  readonly mode: FileMode;
  readonly name: string;
  readonly id: ObjectId;
}

export interface Tree {
  readonly type: 'tree';
  readonly id: ObjectId;
  readonly entries: ReadonlyArray<TreeEntry>;
}

export function parseTreeContent(id: ObjectId, content: Uint8Array, hash: HashConfig): Tree {
  const entries: TreeEntry[] = [];
  const names = new Set<string>();
  let offset = 0;

  while (offset < content.length) {
    const spaceIndex = indexOf(content, 0x20, offset);
    if (spaceIndex === -1) {
      throw invalidTreeEntry(offset, 'missing space after mode');
    }

    const modeStr = decode(content.subarray(offset, spaceIndex));

    const nullIndex = indexOf(content, 0x00, spaceIndex + 1);
    if (nullIndex === -1) {
      throw invalidTreeEntry(offset, 'missing null after name');
    }

    const name = decode(content.subarray(spaceIndex + 1, nullIndex));
    if (name === '' || name === '.' || name === '..' || name.includes('/')) {
      throw invalidTreeEntry(offset, `invalid entry name: ${name}`);
    }

    const hashStart = nullIndex + 1;
    const hashEnd = hashStart + hash.digestLength;
    if (hashEnd > content.length) {
      throw invalidTreeEntry(offset, 'truncated hash');
    }

    const rawHash = content.subarray(hashStart, hashEnd);
    const entryId = ObjectIdFactory.fromRaw(rawHash);
    const mode = normalizeFileMode(modeStr);

    if (names.has(name)) {
      throw invalidTreeEntry(offset, `duplicate entry name: ${name}`);
    }
    names.add(name);
    entries.push({ mode, name, id: entryId });
    offset = hashEnd;
  }

  return { type: 'tree', id, entries };
}

export function serializeTreeContent(tree: Tree, hash: HashConfig): Uint8Array {
  const sorted = sortTreeEntries(tree.entries);

  const encoded = sorted.map((entry) => ({
    mode: encode(entry.mode),
    name: encode(entry.name),
    hash: hexToBytes(entry.id),
  }));

  const totalLength = encoded.reduce(
    (sum, e) => sum + e.mode.length + 1 + e.name.length + 1 + hash.digestLength,
    0,
  );

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const e of encoded) {
    result.set(e.mode, offset);
    offset += e.mode.length;
    result[offset++] = 0x20;
    result.set(e.name, offset);
    offset += e.name.length;
    result[offset++] = 0x00;
    result.set(e.hash, offset);
    offset += e.hash.length;
  }
  return result;
}

export function sortTreeEntries(entries: ReadonlyArray<TreeEntry>): ReadonlyArray<TreeEntry> {
  const decorated = entries.map((entry) => ({
    entry,
    sortKey: encodeEntryName(entry.name, isDirectory(entry.mode)),
  }));
  decorated.sort((a, b) => compareBytes(a.sortKey, b.sortKey));
  return decorated.map((d) => d.entry);
}

export function treeEntryCompare(a: TreeEntry, b: TreeEntry): number {
  const aBytes = encodeEntryName(a.name, isDirectory(a.mode));
  const bBytes = encodeEntryName(b.name, isDirectory(b.mode));
  return compareBytes(aBytes, bBytes);
}

function encodeEntryName(name: string, isDir: boolean): Uint8Array {
  const nameBytes = encode(name);
  if (!isDir) return nameBytes;
  const result = new Uint8Array(nameBytes.length + 1);
  result.set(nameBytes);
  result[nameBytes.length] = 0x2f;
  return result;
}
