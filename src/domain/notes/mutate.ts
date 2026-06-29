import type { ObjectId } from '../objects/index.js';
import { unpackSubtree } from './load.js';
import { chainGap, createEmptyTrie, internalSlot, nibbleAt, placeLeaf, setSlot } from './trie.js';
import type { NotesTrie, Slot, SubtreeReader, SubtreeSlot } from './types.js';
import { EMPTY_SLOT } from './types.js';

const insertIntoSubtree = async (
  trie: NotesTrie,
  index: number,
  slot: SubtreeSlot,
  key: ObjectId,
  val: ObjectId,
  read: SubtreeReader,
  n: number,
): Promise<NotesTrie> => {
  if (!key.startsWith(slot.prefix)) {
    const split = placeLeaf(
      placeLeaf(createEmptyTrie(), slot, n + 1),
      { kind: 'note', key, val },
      n + 1,
    );
    return setSlot(trie, index, internalSlot(split));
  }
  const grafted = setSlot(trie, index, chainGap(await unpackSubtree(slot, read), slot.prefix, n));
  return insert(grafted, key, val, read, n);
};

/** Inserts/overwrites a note, splitting leaf collisions and unpacking subtrees lazily. */
export const insert = async (
  trie: NotesTrie,
  key: ObjectId,
  val: ObjectId,
  read: SubtreeReader,
  n = 0,
): Promise<NotesTrie> => {
  const index = nibbleAt(key, n);
  const slot = trie.slots[index] as Slot;
  if (slot.kind === 'subtree') return insertIntoSubtree(trie, index, slot, key, val, read, n);
  if (slot.kind === 'internal')
    return setSlot(trie, index, internalSlot(await insert(slot.node, key, val, read, n + 1)));
  return placeLeaf(trie, { kind: 'note', key, val }, n);
};

/** Fanout-aware descent returning a note's blob oid, unpacking subtrees on demand. */
export const lookup = async (
  trie: NotesTrie,
  key: ObjectId,
  read: SubtreeReader,
  n = 0,
): Promise<ObjectId | undefined> => {
  const index = nibbleAt(key, n);
  const slot = trie.slots[index] as Slot;
  if (slot.kind === 'empty') return undefined;
  if (slot.kind === 'note') return slot.key === key ? slot.val : undefined;
  if (slot.kind === 'internal') return lookup(slot.node, key, read, n + 1);
  if (!key.startsWith(slot.prefix)) return undefined;
  return lookup(await unpackSubtree(slot, read), key, read, slot.prefix.length);
};

/**
 * Collapses a node back into the parent slot: empty ⇒ gone, a single leaf lifts,
 * a single internal child stays put (its slots are keyed one nibble deeper).
 */
const consolidate = (node: NotesTrie): Slot => {
  if (node.preserved.length > 0) return internalSlot(node);
  const occupied = node.slots.filter((slot) => slot.kind !== 'empty');
  if (occupied.length === 0) return EMPTY_SLOT;
  const only = occupied[0] as Slot;
  if (occupied.length === 1 && only.kind !== 'internal') return only;
  return internalSlot(node);
};

/** Removes a note and consolidates up the loaded path; lazy siblings stay sticky. */
export const remove = async (
  trie: NotesTrie,
  key: ObjectId,
  read: SubtreeReader,
  n = 0,
): Promise<NotesTrie> => {
  const index = nibbleAt(key, n);
  const slot = trie.slots[index] as Slot;
  if (slot.kind === 'empty') return trie;
  if (slot.kind === 'note') return slot.key === key ? setSlot(trie, index, EMPTY_SLOT) : trie;
  if (slot.kind === 'internal')
    return setSlot(trie, index, consolidate(await remove(slot.node, key, read, n + 1)));
  if (!key.startsWith(slot.prefix)) return trie;
  const grafted = setSlot(trie, index, chainGap(await unpackSubtree(slot, read), slot.prefix, n));
  return remove(grafted, key, read, n);
};
