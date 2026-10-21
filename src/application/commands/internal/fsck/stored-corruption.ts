import { errorDataCode } from '../../../../domain/error-data-code.js';

/** The codes a read of a damaged stored entry fails with: an unusable entry
 *  or the index routing to it,
 *  delta chain, zlib stream or header, a loose body that overruns its size claim, a body that no longer parses, a body that no longer hashes to its id,
 *  or a delta base the pack no longer yields. Anything else — a permission or
 *  I/O fault — says nothing about the entry and must reach the caller as-is. */
const CORRUPTION_CODES: ReadonlySet<string | undefined> = new Set([
  'INVALID_PACK_ENTRY',
  'INVALID_PACK_HEADER',
  'INVALID_PACK_INDEX',
  'INVALID_MULTI_PACK_INDEX',
  'INVALID_PACK_REV_INDEX',
  'INVALID_DELTA',
  'DECOMPRESS_FAILED',
  'INVALID_OBJECT_HEADER',
  'LOOSE_OBJECT_CORRUPT',
  'INVALID_TREE_ENTRY',
  'INVALID_COMMIT',
  'INVALID_TAG',
  'INVALID_FILE_MODE',
  'INVALID_IDENTITY',
  'OBJECT_HASH_MISMATCH',
  'OBJECT_NOT_FOUND',
]);

/** Whether `err` is a read of a damaged stored copy rather than an environmental fault. */
export const isStoredCorruption = (err: unknown): boolean =>
  CORRUPTION_CODES.has(errorDataCode(err));
