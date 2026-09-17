/**
 * The pieces both ref backends share for git's availability check over one
 * transaction's names: which names the transaction carries, which of its
 * updates git checks, and the refusal a conflict maps to.
 */
import { fileExists, notADirectory, type TsgitError } from '../../../domain/error.js';
import type { ObjectId, RefName } from '../../../domain/objects/index.js';
import {
  hasPrefixRelatedNames,
  type RefNameConflict,
  type TransactionNames,
  transactionNamesOf,
} from '../../../domain/refs/ref-name-conflict.js';
import type { Context } from '../../../ports/context.js';
import { looseRefPath, perWorktreeRefDir } from '../path-layout.js';

interface NamedUpdate {
  readonly kind: string;
  readonly name: RefName;
}

/** An update that creates, rewrites or deletes a ref. */
export interface RefChangingUpdate extends NamedUpdate {
  readonly kind: 'set' | 'setSymbolic' | 'delete';
  readonly expected?: ObjectId | 'absent';
}

const REF_CHANGING_KINDS: ReadonlySet<string> = new Set(['set', 'setSymbolic', 'delete']);
const TRANSACTION_NAME_KINDS: ReadonlySet<string> = new Set([...REF_CHANGING_KINDS, 'reflogOnly']);

export const isRefChanging = (update: NamedUpdate): update is RefChangingUpdate =>
  REF_CHANGING_KINDS.has(update.kind);

/** No transaction name of its own to check against — an availability check
 *  that only has the store's existing refs to go on. */
export const NO_TRANSACTION_NAMES: TransactionNames = { names: new Set(), sorted: [] };

/** The names `updates` carry, when two of them are prefix-related — the only
 *  shape the availability check can refuse among the transaction's own names. */
export const prefixRelatedTransactionNames = (
  updates: readonly NamedUpdate[],
): TransactionNames | undefined => {
  const named = updates.filter((update) => TRANSACTION_NAME_KINDS.has(update.kind));
  const transaction = transactionNamesOf(named.map((update) => update.name));
  return hasPrefixRelatedNames(transaction.names) ? transaction : undefined;
};

/** Whether git checks `update`'s name once the ref is known absent: it
 *  changes the ref without requiring a current value. */
export const isCheckedWhenAbsent = (update: NamedUpdate): update is RefChangingUpdate =>
  isRefChanging(update) && (update.expected === undefined || update.expected === 'absent');

/** A conflict's refusal, naming the blocking name's loose path — the data the
 *  files store's own refusals carry, a packed or reftable ref included. */
export const refNameConflictRefusal = (ctx: Context, conflict: RefNameConflict): TsgitError => {
  const path = looseRefPath(perWorktreeRefDir(ctx, conflict.blocking), conflict.blocking);
  return conflict.position === 'above' ? notADirectory(path) : fileExists(path);
};
