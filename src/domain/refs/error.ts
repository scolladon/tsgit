import { TsgitError } from '../error.js';
import type { ObjectId, RefName } from '../objects/object-id.js';

export type RefsError =
  | { readonly code: 'INVALID_REF'; readonly reason: string }
  | { readonly code: 'INVALID_PACKED_REFS'; readonly reason: string }
  | { readonly code: 'REF_NOT_FOUND'; readonly name: RefName }
  | {
      readonly code: 'REF_CHAIN_TOO_DEEP';
      readonly depth: number;
      readonly chain: ReadonlyArray<RefName>;
    }
  | {
      readonly code: 'REF_CYCLE_DETECTED';
      readonly chain: ReadonlyArray<RefName>;
    }
  | { readonly code: 'REF_LOCKED'; readonly name: RefName }
  | {
      readonly code: 'REF_UPDATE_CONFLICT';
      readonly name: RefName;
      readonly expected: ObjectId | 'absent';
      readonly actual: ObjectId | 'absent';
    };

export const invalidRef = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_REF', reason });

export const invalidPackedRefs = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_PACKED_REFS', reason });

export const refNotFound = (name: RefName): TsgitError =>
  new TsgitError({ code: 'REF_NOT_FOUND', name });

export const refChainTooDeep = (depth: number, chain: ReadonlyArray<RefName>): TsgitError =>
  new TsgitError({ code: 'REF_CHAIN_TOO_DEEP', depth, chain });

export const refCycleDetected = (chain: ReadonlyArray<RefName>): TsgitError =>
  new TsgitError({ code: 'REF_CYCLE_DETECTED', chain });

export const refLocked = (name: RefName): TsgitError =>
  new TsgitError({ code: 'REF_LOCKED', name });

export const refUpdateConflict = (
  name: RefName,
  expected: ObjectId | 'absent',
  actual: ObjectId | 'absent',
): TsgitError => new TsgitError({ code: 'REF_UPDATE_CONFLICT', name, expected, actual });
