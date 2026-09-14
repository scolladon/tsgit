/**
 * Where git's files and reftable ref backends log the same transaction
 * differently — a small, backend-selected data table rather than a branch
 * scattered through the transaction builders themselves. Each field is
 * documented against the design pin(s) that measured it.
 */
import type { Context } from '../../../ports/context.js';

export interface TransactionLogging {
  /** Whether a delete of an absent target still writes the split log-only
   *  entries it would carry if the target existed (the symrefs walked and
   *  the coupled `HEAD` entry) — the files backend writes them as
   *  `0{40} 0{40}`; the reftable backend writes none. */
  readonly noOpDeleteLogs: 'written' | 'skipped';
  /** How `branch.rename` writes the RENAMED branch's own log (O5, R16/R17):
   *  files replaces the destination's history (on a forced rename) and
   *  appends one `<id> <id>` entry; reftable never drops the destination,
   *  merges the source's live records in at their own update indices, and
   *  appends two entries shaped like a delete then a create. */
  readonly renamedBranchLog: 'replace-then-same-id' | 'merge-then-delete-and-create';
}

const FILES: TransactionLogging = {
  noOpDeleteLogs: 'written',
  renamedBranchLog: 'replace-then-same-id',
};
const REFTABLE: TransactionLogging = {
  noOpDeleteLogs: 'skipped',
  renamedBranchLog: 'merge-then-delete-and-create',
};

/** `ctx.layout.refStorage`'s own discriminant — the same one
 *  `createRefStore` dispatches on. */
export const transactionLogging = (ctx: Context): TransactionLogging =>
  ctx.layout.refStorage === 'reftable' ? REFTABLE : FILES;
