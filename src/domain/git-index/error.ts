import { TsgitError } from '../error.js';

export type IndexError =
  | { readonly code: 'INVALID_INDEX_HEADER'; readonly reason: string }
  | {
      readonly code: 'INVALID_INDEX_ENTRY';
      readonly offset: number;
      readonly reason: string;
    };

export const invalidIndexHeader = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_INDEX_HEADER', reason });

export const invalidIndexEntry = (offset: number, reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_INDEX_ENTRY', offset, reason });
