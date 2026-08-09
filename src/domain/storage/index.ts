// CRC-32
export { crc32 } from './crc32.js';

// Delta
export type { CopyInstruction, DeltaInstruction, DeltaParsed, InsertInstruction } from './delta.js';
export { applyDelta, parseDelta, readDeltaTargetSize } from './delta.js';

// Errors
export type { MidxCheck, StorageError } from './error.js';
export {
  invalidDelta,
  invalidMultiPackIndex,
  invalidPackEntry,
  invalidPackHeader,
  invalidPackIndex,
} from './error.js';

// Loose path
export { computeLooseObjectPath } from './loose-path.js';

// LRU cache
export type { LruCache } from './lru-cache.js';
export { createLruCache } from './lru-cache.js';

// Multi-pack index
export type { MidxEntry, MultiPackIndex } from './midx.js';
export { lookupMultiPackIndex, midxEntryAt, midxOidAt, parseMultiPackIndex } from './midx.js';

// Pack entry
export type {
  BasePackEntryHeader,
  BasePackEntryType,
  OfsPackEntryHeader,
  PackEntryHeader,
  PackEntryType,
  PackHeader,
  RefPackEntryHeader,
} from './pack-entry.js';
export {
  encodeOfsDistance,
  encodePackEntryHeader,
  PACK_ENTRY_TYPE,
  packEntryTypeToObjectType,
  parsePackEntryHeader,
  parsePackHeader,
  serializePackHeader,
} from './pack-entry.js';

// Pack index
export type { PackIndex } from './pack-index.js';
export { entryOffsets, findByPrefix, lookupPackIndex, parsePackIndex } from './pack-index.js';

// Pack writer
export type {
  PackEntryMeta,
  PackfileResult,
  PackIndexWriterEntry,
  PackWriterEntry,
} from './pack-writer.js';
export { serializePackfile, serializePackIndex } from './pack-writer.js';
