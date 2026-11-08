/**
 * Where git's files and reftable ref backends log the same transaction
 * differently — a small, backend-selected data table rather than a branch
 * scattered through the transaction builders themselves.
 */
import type { Context } from '../../../ports/context.js';

export interface TransactionLogging {
  /** Whether a delete of an absent target still writes the split log-only
   *  entries it would carry if the target existed (the symrefs walked and
   *  the coupled `HEAD` entry) — the files backend writes them as
   *  `0{40} 0{40}`; the reftable backend writes none. */
  readonly noOpDeleteLogs: 'written' | 'skipped';
  /** How `branch.rename` writes the RENAMED branch's own log: files replaces
   *  the destination's history (on a forced rename) and appends one
   *  `<id> <id>` entry; reftable never drops the destination, merges the
   *  source's live records in at their own update indices, and appends two
   *  entries shaped like a delete then a create. */
  readonly renamedBranchLog: 'replace-then-same-id' | 'merge-then-delete-and-create';
  /** The old id of a `logs/HEAD` entry coupled through a symbolic ref the
   *  write walked: the files backend splits the update at each hop and logs
   *  the coupled entry before the terminal's value is known, so it is always
   *  the null id; the reftable backend resolves the old value directly, so
   *  it carries the real one. An update that is not walked (`noDeref`) or
   *  whose terminal `HEAD` itself names logs the resolved value on both
   *  backends regardless of this field. */
  readonly headOldThroughLink: 'null-id' | 'resolved';
  /** Whether a `noDeref` delete of a symbolic ref keeps its log, appending
   *  the deletion to it: the files backend removes the log with the ref;
   *  the reftable backend keeps it and appends `<old> 0{40}`. */
  readonly symbolicDeleteLog: 'removed' | 'kept-with-entry';
  /** How `remote.rename` moves a tracking symref's (`<remote>/HEAD`) own
   *  log: the files backend moves it wholesale and appends one null-id
   *  entry to the destination; the reftable backend copies it onto the
   *  destination and leaves the source's log record live, with no
   *  tombstone for it, so the source's log survives for the coupled
   *  delete's own kept-with-entry append. */
  readonly renamedSymrefLog: 'move-then-null-entry' | 'copy-then-delete-entry';
  /** files: two names of one transaction on one loose file refuse, as git's per-refname lock
   *  map meets EEXIST; reftable: stacks hold no per-ref lock, so nothing collides. */
  readonly sharedLooseFile: 'refused' | 'allowed';
}

const FILES: TransactionLogging = {
  noOpDeleteLogs: 'written',
  renamedBranchLog: 'replace-then-same-id',
  headOldThroughLink: 'null-id',
  symbolicDeleteLog: 'removed',
  renamedSymrefLog: 'move-then-null-entry',
  sharedLooseFile: 'refused',
};
const REFTABLE: TransactionLogging = {
  noOpDeleteLogs: 'skipped',
  renamedBranchLog: 'merge-then-delete-and-create',
  headOldThroughLink: 'resolved',
  symbolicDeleteLog: 'kept-with-entry',
  renamedSymrefLog: 'copy-then-delete-entry',
  sharedLooseFile: 'allowed',
};

/** `ctx.layout.refStorage`'s own discriminant — the same one
 *  `createRefStore` dispatches on. */
export const transactionLogging = (ctx: Context): TransactionLogging =>
  ctx.layout.refStorage === 'reftable' ? REFTABLE : FILES;
