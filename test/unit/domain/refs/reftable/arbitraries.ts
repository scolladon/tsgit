/**
 * The reftable writers live in a `fast-check`-free module so the parity
 * scenarios can reach them without dragging a dev dependency into the Deno,
 * Bun and `workerd` graphs; re-exported here so importers of the arbitraries
 * keep a single entry point. `fast-check` generators (`arbReftableSpec` and
 * friends) arrive in a later part.
 */
export type {
  DeflateFn,
  IndexBlockSpec,
  IndexRecordSpec,
  LogBlockSpec,
  LogRecordEntrySpec,
  LogRecordSpec,
  ObjBlockSpec,
  ObjRecordSpec,
  RefBlockSpec,
  RefRecordSpec,
  RefRecordValueSpec,
  ReftableBlockSpec,
  ReftableFooterSpec,
  ReftableHeaderSpec,
  ReftableSpec,
} from '../../../../fixtures/refs/reftable-writers.js';
export {
  buildIndexBlock,
  buildObjBlock,
  buildRefBlock,
  buildReftable,
  buildReftableBlock,
  buildReftableHeader,
  buildReftableLogBlock,
} from '../../../../fixtures/refs/reftable-writers.js';
