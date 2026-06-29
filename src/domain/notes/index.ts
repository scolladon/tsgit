export {
  constructPathWithFanout,
  constructSubtreePath,
  determineFanout,
  parseFanoutPath,
} from './fanout.js';
export { classifyEntries, classifyEntry, loadTrieRoot, unpackSubtree } from './load.js';
export { insert, lookup, remove } from './mutate.js';
export {
  chainGap,
  createEmptyTrie,
  internalSlot,
  nibbleAt,
  nibbleHex,
  placeLeaf,
  setSlot,
} from './trie.js';
export type {
  EmptySlot,
  InternalSlot,
  NoteSlot,
  NotesTrie,
  Slot,
  SubtreeReader,
  SubtreeSlot,
  WritePlan,
  WritePlanEntry,
} from './types.js';
export { EMPTY_SLOT, SLOT_COUNT } from './types.js';
export { planWrite } from './write-plan.js';
