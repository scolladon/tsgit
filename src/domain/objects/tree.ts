/**
 * Tree serializer. Produces the canonical sorted-entry binary form
 * (`<mode> <name>\0<raw-sha>`-per-entry) that lives inside a loose tree
 * object.
 *
 * @writes
 *   surface: tree
 *   kind:    equivalent-under-readback
 *   format:  git-tree-object
 */
import {
  compareBytes,
  decode,
  decodePreservingBom,
  encode,
  hexToBytes,
  indexOf,
} from './encoding.js';
import { invalidTreeEntry } from './error.js';
import type { FileMode } from './file-mode.js';
import { isDirectory, normalizeFileMode } from './file-mode.js';
import type { HashConfig } from './hash-config.js';
import type { ObjectId } from './object-id.js';
import { ObjectId as ObjectIdFactory } from './object-id.js';
import { hasNonOctalByte } from './tree-entry-bytes.js';

export type TreeEntry = {
  readonly mode: FileMode;
  /** Derived display view — always `decodePreservingBom(nameBytes)`. Never
   *  read to make a decision; `nameBytes` is the authoritative value. */
  readonly name: string;
  /** Authoritative on-disk name bytes: a fresh copy owned by this entry,
   *  never a view onto a caller-supplied or cached buffer. */
  readonly nameBytes: Uint8Array;
  readonly id: ObjectId;
} & { readonly __brand: unique symbol };

// The brand stops an object *literal* from satisfying `TreeEntry`, not a
// spread (`{ ...entry, name: 'x' }` still type-checks — TypeScript's spread
// carries the brand property along with everything else). Accepted: nothing
// reads `name` to make a decision, so a stale `name` from such a spread is a
// wrong display string, never wrong on-disk bytes.
export function treeEntry(mode: FileMode, name: string | Uint8Array, id: ObjectId): TreeEntry {
  const nameBytes = typeof name === 'string' ? encode(name) : new Uint8Array(name);
  return { mode, name: decodePreservingBom(nameBytes), nameBytes, id } as TreeEntry;
}

export interface Tree {
  readonly type: 'tree';
  readonly id: ObjectId;
  readonly entries: ReadonlyArray<TreeEntry>;
}

export function parseTreeContent(id: ObjectId, content: Uint8Array, hash: HashConfig): Tree {
  const entries: TreeEntry[] = [];
  let offset = 0;

  while (offset < content.length) {
    const spaceIndex = indexOf(content, 0x20, offset);
    if (spaceIndex === -1) {
      throw invalidTreeEntry(offset, 'missing space after mode');
    }
    if (spaceIndex === offset || hasNonOctalByte(content, offset, spaceIndex)) {
      throw invalidTreeEntry(offset, 'malformed mode');
    }

    const nullIndex = indexOf(content, 0x00, spaceIndex + 1);
    if (nullIndex === -1) {
      throw invalidTreeEntry(offset, 'missing null after name');
    }
    if (nullIndex === spaceIndex + 1) {
      throw invalidTreeEntry(offset, 'empty filename');
    }

    const hashStart = nullIndex + 1;
    const hashEnd = hashStart + hash.digestLength;
    if (hashEnd > content.length) {
      throw invalidTreeEntry(offset, 'truncated hash');
    }

    const nameSpan = content.subarray(spaceIndex + 1, nullIndex);
    const rawHash = content.subarray(hashStart, hashEnd);
    const entryId = ObjectIdFactory.fromRaw(rawHash);
    const modeStr = decode(content.subarray(offset, spaceIndex));
    const mode = normalizeFileMode(modeStr);

    entries.push(treeEntry(mode, nameSpan, entryId));
    offset = hashEnd;
  }

  return { type: 'tree', id, entries };
}

export function serializeTreeContent(tree: Tree, hash: HashConfig): Uint8Array {
  const sorted = sortTreeEntries(tree.entries);

  const encoded = sorted.map((entry) => ({
    mode: encode(entry.mode),
    name: entry.nameBytes,
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
    sortKey: encodeEntryName(entry.nameBytes, isDirectory(entry.mode)),
  }));
  decorated.sort((a, b) => compareBytes(a.sortKey, b.sortKey));
  return decorated.map((d) => d.entry);
}

export function treeEntryCompare(a: TreeEntry, b: TreeEntry): number {
  const aBytes = encodeEntryName(a.nameBytes, isDirectory(a.mode));
  const bBytes = encodeEntryName(b.nameBytes, isDirectory(b.mode));
  return compareBytes(aBytes, bBytes);
}

function encodeEntryName(nameBytes: Uint8Array, isDir: boolean): Uint8Array {
  if (!isDir) return nameBytes;
  const result = new Uint8Array(nameBytes.length + 1);
  result.set(nameBytes);
  result[nameBytes.length] = 0x2f;
  return result;
}
