import type { TreeEntry } from '../objects/index.js';
import { isDirectory, ObjectId } from '../objects/index.js';
import { addPreserved, createEmptyTrie, placeLeaf } from './trie.js';
import type { NoteSlot, NotesTrie, SubtreeReader, SubtreeSlot } from './types.js';

const FULL_HEX = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TWO_HEX = /^[0-9a-f]{2}$/;

/**
 * Classifies one on-disk tree entry at byte-prefix `prefix`: a full-hex blob is
 * a note, a two-hex directory is a lazy subtree placeholder, anything else is a
 * preserved non-note entry (`null`).
 */
export const classifyEntry = (entry: TreeEntry, prefix: string): NoteSlot | SubtreeSlot | null => {
  const combined = prefix + entry.name;
  if (!isDirectory(entry.mode) && FULL_HEX.test(combined))
    return { kind: 'note', key: ObjectId.from(combined), val: entry.id };
  if (isDirectory(entry.mode) && TWO_HEX.test(entry.name))
    return { kind: 'subtree', prefix: combined, oid: entry.id };
  return null;
};

/** Builds one trie level from a tree's entries, classified at byte-prefix `prefix`. */
export const classifyEntries = (entries: ReadonlyArray<TreeEntry>, prefix: string): NotesTrie =>
  entries.reduce<NotesTrie>((trie, entry) => {
    const leaf = classifyEntry(entry, prefix);
    return leaf === null ? addPreserved(trie, entry) : placeLeaf(trie, leaf, prefix.length);
  }, createEmptyTrie());

/** Loads a root notes tree's entries into a trie; subtrees stay lazy (unread). */
export const loadTrieRoot = (entries: ReadonlyArray<TreeEntry>): NotesTrie =>
  classifyEntries(entries, '');

/** Reads a lazy subtree's entries on demand and classifies them at its prefix. */
export const unpackSubtree = async (slot: SubtreeSlot, read: SubtreeReader): Promise<NotesTrie> =>
  classifyEntries(await read(slot.oid), slot.prefix);
