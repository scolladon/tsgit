import { TsgitError } from '../error.js';
import type { ObjectId, RefName } from '../objects/object-id.js';

/**
 * The parse gate that refused a reftable stack file — a closed discriminant
 * so the application layer can classify the fault without re-deriving it
 * from the free-text reason.
 *
 * `'magic'`, `'version'`, `'footer-crc'`, `'truncated'`, `'varint-overflow'`
 * and `'block-bounds'` are raised by the header/footer/varint/block-framing
 * codec — `'block-bounds'` covers a declared block length or footer section
 * position that would read outside the file. `'block-type'`,
 * `'restart-count'`, `'record-overrun'` and `'cycle'` are raised by the
 * ref/index/obj block record grammar decoder — `'cycle'` is a ref-index
 * descent (iterative or recursive) that exceeded its depth bound, the
 * refusal a self-referential or pathologically deep index gets instead of
 * hanging or overflowing the stack. `'tables-list'` is raised once the
 * multi-file stack (`tables.list`) is read.
 */
export type ReftableCheck =
  | 'magic'
  | 'version'
  | 'footer-crc'
  | 'truncated'
  | 'block-type'
  | 'restart-count'
  | 'record-overrun'
  | 'varint-overflow'
  | 'block-bounds'
  | 'cycle'
  | 'tables-list';

export type RefsError =
  | { readonly code: 'INVALID_REF'; readonly reason: string }
  | { readonly code: 'INVALID_PACKED_REFS'; readonly reason: string }
  | {
      readonly code: 'INVALID_REFTABLE';
      readonly check: ReftableCheck;
      readonly reason: string;
    }
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
    }
  | { readonly code: 'REFTABLE_LOCKED'; readonly stack: string; readonly reason: string };

export const invalidRef = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_REF', reason });

export const invalidPackedRefs = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_PACKED_REFS', reason });

export const invalidReftable = (check: ReftableCheck, reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_REFTABLE', check, reason });

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

export const reftableLocked = (stack: string, reason: string): TsgitError =>
  new TsgitError({ code: 'REFTABLE_LOCKED', stack, reason });
