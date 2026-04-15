import { TsgitError } from '../error.js';

export type StorageError =
  | { readonly code: 'INVALID_PACK_HEADER'; readonly reason: string }
  | { readonly code: 'INVALID_PACK_INDEX'; readonly reason: string }
  | {
      readonly code: 'INVALID_PACK_ENTRY';
      readonly offset: number;
      readonly reason: string;
    }
  | { readonly code: 'INVALID_DELTA'; readonly reason: string };

export const invalidPackHeader = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_PACK_HEADER', reason });

export const invalidPackIndex = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_PACK_INDEX', reason });

export const invalidPackEntry = (offset: number, reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_PACK_ENTRY', offset, reason });

export const invalidDelta = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_DELTA', reason });
