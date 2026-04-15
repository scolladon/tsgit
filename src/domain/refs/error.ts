import { TsgitError } from '../error.js';

export type RefsError =
  | { readonly code: 'INVALID_REF'; readonly reason: string }
  | { readonly code: 'INVALID_PACKED_REFS'; readonly reason: string };

export const invalidRef = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_REF', reason });

export const invalidPackedRefs = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_PACKED_REFS', reason });
