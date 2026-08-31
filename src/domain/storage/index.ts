// Pack bitmap
export type { BitmapEntryHeader, PackBitmap } from './bitmap.js';
export { bitmapEntryHeaders, parsePackBitmap } from './bitmap.js';
// CRC-32
export { crc32 } from './crc32.js';
// Cruft pack .mtimes sidecar
export { CRUFT_MTIMES_MAGIC, parseCruftMtimes, serializeCruftMtimes } from './cruft-pack.js';
// Delta
export type { CopyInstruction, DeltaInstruction, DeltaParsed, InsertInstruction } from './delta.js';
export { applyDelta, parseDelta, readDeltaTargetSize } from './delta.js';
export { encodeDelta, serializeDelta } from './delta-encode.js';
// Errors
export type {
  BitmapCheck,
  CruftMtimesCheck,
  MidxCheck,
  RevIndexCheck,
  StorageError,
} from './error.js';
export {
  invalidCruftMtimes,
  invalidDelta,
  invalidMultiPackIndex,
  invalidPackBitmap,
  invalidPackEntry,
  invalidPackHeader,
  invalidPackIndex,
  invalidPackRevIndex,
} from './error.js';
// Pack bitmap
export type { EwahStream } from './ewah.js';
export { foldEwahStream, maxSetBitPosition, readEwahStream } from './ewah.js';
// Loose path
export { computeLooseObjectPath } from './loose-path.js';
// LRU cache
export type { LruCache } from './lru-cache.js';
export { createLruCache } from './lru-cache.js';
// Multi-pack index
export type { MidxEntry, MultiPackIndex } from './midx.js';
export {
  lookupMidxPosition,
  lookupMultiPackIndex,
  midxEntryAt,
  midxOidAt,
  midxReverseIndexAt,
  midxReverseIndexPositions,
  parseMultiPackIndex,
} from './midx.js';
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
export {
  entryOffsets,
  entryOffsetsF64,
  findByPrefix,
  lookupPackIndex,
  lookupPackIndexPosition,
  objectIdAt,
  offsetAtPackPosition,
  parsePackIndex,
} from './pack-index.js';
export { type SortedEntry, sortPackIndexEntries } from './pack-order.js';
// Pack writer
export type {
  PackEntryMeta,
  PackfileResult,
  PackIndexWriterEntry,
  PackWriterEntry,
} from './pack-writer.js';
export { serializePackfile, serializePackIndex } from './pack-writer.js';
// Pack reverse index
export type { PackRevIndex } from './rev-index.js';
export {
  parsePackRevIndex,
  REASON_REV_INDEX_CORRUPT,
  REASON_REV_INDEX_TOO_SMALL,
  REV_HEADER_SIZE,
  revIndexPositionAt,
  serializePackRevIndex,
} from './rev-index.js';
