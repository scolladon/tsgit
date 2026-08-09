import { TsgitError } from '../error.js';

/**
 * The parse gate that refused a multi-pack-index — a closed discriminant so
 * the application layer can classify the fault without re-deriving it from
 * the free-text reason.
 */
export type MidxCheck =
  | 'size'
  | 'signature'
  | 'version'
  | 'hash-version'
  | 'chunk-table'
  | 'required-chunk'
  | 'fanout'
  | 'chunk-length'
  | 'pack-names'
  | 'pack-int-id'
  | 'large-offset';

/**
 * The parse gate that refused a pack reverse index — a closed discriminant,
 * same shape and reason as `MidxCheck`.
 */
export type RevIndexCheck = 'size' | 'signature' | 'version' | 'hash-id';

/**
 * The parse gate that refused a pack (or midx) bitmap, or one of its EWAH
 * streams — a closed discriminant, same shape and reason as `MidxCheck`.
 * `'stream'` is the only member raised so far (the EWAH decoder); the other
 * five arrive with the bitmap container's own header and entry parsing.
 */
export type BitmapCheck = 'size' | 'signature' | 'version' | 'options' | 'stream' | 'entry';

export type StorageError =
  | { readonly code: 'INVALID_PACK_HEADER'; readonly reason: string }
  | { readonly code: 'INVALID_PACK_INDEX'; readonly reason: string }
  | {
      readonly code: 'INVALID_PACK_ENTRY';
      readonly offset: number;
      readonly reason: string;
    }
  | { readonly code: 'INVALID_DELTA'; readonly reason: string }
  | { readonly code: 'DELTA_CHAIN_TOO_DEEP'; readonly depth: number }
  | {
      readonly code: 'INVALID_MULTI_PACK_INDEX';
      readonly reason: string;
      readonly check: MidxCheck;
    }
  | {
      readonly code: 'INVALID_PACK_REV_INDEX';
      readonly reason: string;
      readonly check: RevIndexCheck;
    }
  | {
      readonly code: 'INVALID_PACK_BITMAP';
      readonly reason: string;
      readonly check: BitmapCheck;
    };

export const invalidPackHeader = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_PACK_HEADER', reason });

export const invalidPackIndex = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_PACK_INDEX', reason });

export const invalidPackEntry = (offset: number, reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_PACK_ENTRY', offset, reason });

export const invalidDelta = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_DELTA', reason });

export const deltaChainTooDeep = (depth: number): TsgitError =>
  new TsgitError({ code: 'DELTA_CHAIN_TOO_DEEP', depth });

export const invalidMultiPackIndex = (check: MidxCheck, reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_MULTI_PACK_INDEX', check, reason });

export const invalidPackRevIndex = (check: RevIndexCheck, reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_PACK_REV_INDEX', check, reason });

export const invalidPackBitmap = (check: BitmapCheck, reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_PACK_BITMAP', check, reason });
