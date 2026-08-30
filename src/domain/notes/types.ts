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

/**
 * One unsorted tree level the bridge sorts (via `sortTreeEntries`) and
 * persists. `name` is the grouping path only — a pure-hex fanout prefix
 * (`3f/a2`) the bridge splits one level at a time, or the empty string at
 * the root. A PRESERVED (non-note) entry carries its raw leaf bytes in
 * `nameBytes` instead, so the bridge mints it verbatim and never re-splits
 * an on-disk name that happens to contain a '/' byte of its own. A
 * plan-synthesised note leaf has no `nameBytes` — its full path, prefix
 * included, is pure hex by construction and safe to split as a string.
 */
export interface WritePlanEntry {
  readonly name: string;
  readonly nameBytes?: Uint8Array;
  readonly mode: FileMode;
  readonly oid: ObjectId;
}

export interface WritePlan {
  readonly entries: ReadonlyArray<WritePlanEntry>;
}

export const SLOT_COUNT = 16;

export const EMPTY_SLOT: EmptySlot = { kind: 'empty' };
