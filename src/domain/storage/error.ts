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
