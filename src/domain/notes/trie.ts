import type { TreeEntry } from '../objects/index.js';
import type { NoteSlot, NotesTrie, Slot, SubtreeSlot } from './types.js';
import { EMPTY_SLOT, SLOT_COUNT } from './types.js';

export const createEmptyTrie = (): NotesTrie => ({
  slots: Array.from({ length: SLOT_COUNT }, () => EMPTY_SLOT),
  preserved: [],
});

export const internalSlot = (node: NotesTrie): Slot => ({ kind: 'internal', node });

export const setSlot = (trie: NotesTrie, index: number, slot: Slot): NotesTrie => ({
  ...trie,
  slots: trie.slots.map((current, i) => (i === index ? slot : current)),
});

export const addPreserved = (trie: NotesTrie, entry: TreeEntry): NotesTrie => ({
  ...trie,
  preserved: [...trie.preserved, entry],
});

/** The hex nibble value (0–15) of `hex` at depth `n`. */
export const nibbleAt = (hex: string, n: number): number => Number.parseInt(hex.charAt(n), 16);

/** The lowercase-hex character for a nibble value (0–15). */
export const nibbleHex = (nibble: number): string => nibble.toString(16);

const pathOf = (leaf: NoteSlot | SubtreeSlot): string =>
  leaf.kind === 'note' ? leaf.key : leaf.prefix;

/**
 * Places a note/subtree leaf at its nibble path from depth `n`, splitting an
 * occupied leaf slot into a fresh internal node down to the first differing
 * nibble. Same path ⇒ overwrite (git's `combine_notes_overwrite`).
 */
export const placeLeaf = (trie: NotesTrie, leaf: NoteSlot | SubtreeSlot, n: number): NotesTrie => {
  const path = pathOf(leaf);
  const index = nibbleAt(path, n);
  const slot = trie.slots[index] as Slot;
  if (slot.kind === 'empty') return setSlot(trie, index, leaf);
  if (slot.kind === 'internal')
    return setSlot(trie, index, internalSlot(placeLeaf(slot.node, leaf, n + 1)));
  if (pathOf(slot) === path) return setSlot(trie, index, leaf);
  const split = placeLeaf(placeLeaf(createEmptyTrie(), slot, n + 1), leaf, n + 1);
  return setSlot(trie, index, internalSlot(split));
};

/**
 * Wraps an unpacked subtree node (keyed at depth `prefix.length`) in the chain
 * of single-child internals for the nibbles consumed between depth `n` and the
 * prefix end, so descent stays a uniform one-nibble-per-level walk.
 */
export const chainGap = (node: NotesTrie, prefix: string, n: number): Slot =>
  [...prefix.slice(n + 1)].reduceRight<Slot>(
    (child, nibble) => internalSlot(setSlot(createEmptyTrie(), nibbleAt(nibble, 0), child)),
    internalSlot(node),
  );
