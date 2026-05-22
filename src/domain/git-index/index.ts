// Error types
export type { IndexError } from './error.js';
export { invalidIndexEntry, invalidIndexHeader } from './error.js';

// Index entry types + comparison
export type {
  GitIndex,
  IndexEntry,
  IndexEntryFlags,
  IndexExtension,
  StatData,
} from './index-entry.js';
export { isStatClean, STAGE0_FLAGS } from './index-entry.js';

// Parser
export { parseIndex } from './index-parser.js';

// Writer
export { compareEntryPath, serializeIndex } from './index-writer.js';
