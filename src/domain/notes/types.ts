import type { FileMode, ObjectId, TreeEntry } from '../objects/index.js';

/**
 * Lazily reads an on-disk fanout subtree's entries on demand. Injected by the
 * caller so the trie stays pure: the I/O lives outside the domain.
 */
export type SubtreeReader = (oid: ObjectId) => Promise<ReadonlyArray<TreeEntry>>;

export interface EmptySlot {
  readonly kind: 'empty';
}

export interface NoteSlot {
  readonly kind: 'note';
  readonly key: ObjectId;
  readonly val: ObjectId;
}

export interface SubtreeSlot {
  readonly kind: 'subtree';
  readonly prefix: string;
  readonly oid: ObjectId;
}

export interface InternalSlot {
  readonly kind: 'internal';
  readonly node: NotesTrie;
}

export type Slot = EmptySlot | NoteSlot | SubtreeSlot | InternalSlot;

/** A 16-way nibble-trie node: one slot per hex value of the oid at this depth. */
export interface NotesTrie {
  readonly slots: ReadonlyArray<Slot>;
  readonly preserved: ReadonlyArray<TreeEntry>;
}

/** One unsorted tree level the bridge sorts (via `sortTreeEntries`) and persists. */
export interface WritePlanEntry {
  readonly name: string;
  readonly mode: FileMode;
  readonly oid: ObjectId;
}

export interface WritePlan {
  readonly entries: ReadonlyArray<WritePlanEntry>;
}

export const SLOT_COUNT = 16;

export const EMPTY_SLOT: EmptySlot = { kind: 'empty' };
