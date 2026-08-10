export {
  constructPathWithFanout,
  constructSubtreePath,
  determineFanout,
  parseFanoutPath,
} from './fanout.js';
export { loadTrieRoot, unpackSubtree } from './load.js';
export { insert, lookup, remove } from './mutate.js';
export { chainGap, createEmptyTrie, setSlot } from './trie.js';
export type {
  InternalSlot,
  NoteSlot,
  NotesTrie,
  Slot,
  SubtreeReader,
} from './types.js';
export { EMPTY_SLOT } from './types.js';
export { planWrite } from './write-plan.js';
