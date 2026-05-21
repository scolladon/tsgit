import { TsgitError } from '../error.js';
import type { RefName } from '../objects/object-id.js';

export type ReflogError =
  | { readonly code: 'INVALID_REFLOG_ENTRY'; readonly reason: string }
  | { readonly code: 'REFLOG_NOT_FOUND'; readonly ref: RefName }
  | {
      readonly code: 'REFLOG_ENTRY_OUT_OF_RANGE';
      readonly ref: RefName;
      readonly requested: number;
      readonly available: number;
    };

export const invalidReflogEntry = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_REFLOG_ENTRY', reason });

export const reflogNotFound = (ref: RefName): TsgitError =>
  new TsgitError({ code: 'REFLOG_NOT_FOUND', ref });

export const reflogEntryOutOfRange = (
  ref: RefName,
  requested: number,
  available: number,
): TsgitError => new TsgitError({ code: 'REFLOG_ENTRY_OUT_OF_RANGE', ref, requested, available });
