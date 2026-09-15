import { errorDataCode } from '../../domain/error-data-code.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { zeroOid } from '../../domain/objects/index.js';
import { refUpdateConflict } from '../../domain/refs/error.js';
import { validateRefName } from '../../domain/refs/ref-validation.js';
import type { Context } from '../../ports/context.js';
import { assertRefTargetValid } from './internal/ref-target.js';
import { type TransactionLogging, transactionLogging } from './internal/ref-transaction-logging.js';
import { type RefWriteChain, resolveWriteChain } from './internal/ref-write-chain.js';
import {
  getRefStore,
  type RefStore,
  type RefUpdate,
  type ResolveDirectResult,
} from './ref-store.js';
import type { UpdateRefOptions } from './types.js';

const HEAD: RefName = 'HEAD' as RefName;
/** The `HEAD` value a chain that walks `HEAD` itself couples with: none. */
const UNCOUPLED_HEAD: ResolveDirectResult = { kind: 'missing' };

/** The write arm of {@link UpdateRefOptions} — `reflogMessage` is required
 *  here, unlike the delete arm's optional one. `writeUpdates` only ever
 *  receives this shape (the caller routes `delete: true` to `deleteUpdates`
 *  before it is reached), so narrowing to it removes a fallback that could
 *  never actually run. */
type WriteRefOptions = Extract<UpdateRefOptions, { readonly delete?: false }>;

export async function updateRef(
  ctx: Context,
  name: RefName,
  newId: ObjectId,
  options: UpdateRefOptions,
): Promise<void> {
  // validateRefName rejects `..`, absolute paths, and every character class
  // that could let `${gitDir}/${name}` escape the repo — no separate path
  // containment check is needed.
  validateRefName(name);
  // Verification precedes chain resolution and the compare-and-swap (git's
  // own order); a delete is never verified.
  if (!isDelete(ctx, newId, options)) await assertRefTargetValid(ctx, name, newId);

  const store = getRefStore(ctx);
  const chain = await resolveWriteChain(store, name, options);
  // Resolved before any write so a genuine I/O error refuses the whole
  // update instead of leaving a committed ref, a written reflog, and a
  // thrown call. A chain that walks HEAD already read it, and never couples.
  const head = walksHead(name, chain) ? UNCOUPLED_HEAD : await resolveHeadForCoupling(store);

  assertExpected(name, options.expected, chain);

  const logging = transactionLogging(ctx);
  const updates = isDelete(ctx, newId, options)
    ? deleteUpdates(ctx, chain, head, options, logging)
    : writeUpdates(ctx, chain, head, newId, options, logging);
  await store.applyRefUpdates(updates);
}

/** git marks a null new object id `REF_DELETING` and takes the delete path
 *  unverified, exactly as `delete: true` does — the two are one transaction
 *  shape, not two. Narrows `options` for `writeUpdates`' stricter parameter
 *  type in the (false) write branch. */
function isDelete(
  ctx: Context,
  newId: ObjectId,
  options: UpdateRefOptions,
): options is Extract<UpdateRefOptions, { readonly delete: true }> {
  return options.delete === true || newId === zeroOid(ctx.hashConfig);
}

/**
 * git's compare-and-swap: `expected` is checked against the value naming the
 * GIVEN ref reads to (its terminal, once symbolic refs are walked) — never
 * an intermediate link's own content. `expected === 'absent'` through a
 * dangling symref is git's own distinct refusal (`'dangling symref already
 * exists'`): the referent doesn't exist, but the symref naming it does, so
 * `'absent'` alone is not enough of a match — a caller reconstructing git's
 * text tells the two `'absent'`/`'absent'` shapes apart via `danglingSymref`,
 * the data itself needs no extra field.
 */
function assertExpected(
  name: RefName,
  expected: ObjectId | 'absent' | undefined,
  chain: RefWriteChain,
): void {
  if (expected === undefined) return;
  if (expected === 'absent' && chain.danglingSymref) {
    throw refUpdateConflict(name, 'absent', 'absent');
  }
  if (expected !== chain.old) throw refUpdateConflict(name, expected, chain.old);
}

/** `chain.old`, or `zero` when the chain resolved to nothing — every reflog
 *  field needs a concrete `ObjectId`, never the `'absent'` sentinel. */
function oldOrZero(old: ObjectId | 'absent', zero: ObjectId): ObjectId {
  return old === 'absent' ? zero : old;
}

/** Whether `HEAD` is the given name or a link the chain walks — git's
 *  `REF_UPDATE_VIA_HEAD`: `HEAD` then logs as part of the chain itself and
 *  gains no second, coupled entry. */
const walksHead = (name: RefName, chain: RefWriteChain): boolean =>
  name === HEAD || chain.links.includes(HEAD);

/**
 * The coupled `logs/HEAD` entry a write or delete produces when `HEAD`
 * symbolically names the chain's terminal OR one of its walked links — and
 * the chain does not walk `HEAD` itself (`head` is then uncoupled).
 * The old id is the resolved chain value, except on the files backend when
 * `HEAD` names a walked LINK rather than the terminal directly: the files
 * backend splits the transaction at each hop and logs the coupled entry
 * before the terminal's value is known, so it logs the null id there
 * instead.
 */
function coupledHeadEntry(
  chain: RefWriteChain,
  head: ResolveDirectResult,
  newId: ObjectId,
  message: string,
  logging: TransactionLogging,
  zero: ObjectId,
): RefUpdate | undefined {
  if (head.kind !== 'symbolic') return undefined;
  const namesLink = chain.links.includes(head.target);
  if (head.target !== chain.terminal && !namesLink) return undefined;
  const oldId =
    namesLink && logging.headOldThroughLink === 'null-id' ? zero : oldOrZero(chain.old, zero);
  return { kind: 'reflogOnly', name: HEAD, reflog: { oldId, newId, message } };
}

/**
 * The updates a write produces: the terminal's own `set` (reflog attached
 * unless old === new); one `reflogOnly` entry per walked link, unconditional
 * even when the value is unchanged; and the coupled `HEAD` entry, when it
 * applies.
 */
function writeUpdates(
  ctx: Context,
  chain: RefWriteChain,
  head: ResolveDirectResult,
  newId: ObjectId,
  options: WriteRefOptions,
  logging: TransactionLogging,
): readonly RefUpdate[] {
  const zero = zeroOid(ctx.hashConfig);
  const oldId = oldOrZero(chain.old, zero);
  const message = options.reflogMessage;
  const updates: RefUpdate[] = [
    {
      kind: 'set',
      name: chain.terminal,
      id: newId,
      ...(oldId !== newId ? { reflog: { oldId, newId, message } } : {}),
    },
  ];
  for (const link of chain.links) {
    updates.push({ kind: 'reflogOnly', name: link, reflog: { oldId, newId, message } });
  }
  const coupled = coupledHeadEntry(chain, head, newId, message, logging, zero);
  if (coupled !== undefined) updates.push(coupled);
  return updates;
}

/**
 * The updates a delete produces: the store-level `delete` of the terminal,
 * always. When the terminal is ABSENT, the split log-only entries (each
 * walked link, plus the coupled `HEAD` entry) are backend-specific
 * (`noOpDeleteLogs`) — the files backend still writes them as `0{40} 0{40}`,
 * the reftable backend writes none. A `noDeref` delete of a symbolic ref on
 * the reftable backend keeps its log (the store never tombstones it, see
 * `applyDeleteRecords`) and gains one more entry recording the deletion
 * itself.
 */
function deleteUpdates(
  ctx: Context,
  chain: RefWriteChain,
  head: ResolveDirectResult,
  options: UpdateRefOptions,
  logging: TransactionLogging,
): readonly RefUpdate[] {
  const zero = zeroOid(ctx.hashConfig);
  const message = options.reflogMessage ?? '';
  const updates: RefUpdate[] = [{ kind: 'delete', name: chain.terminal }];
  const terminalAbsent = chain.old === 'absent';
  if (!terminalAbsent || logging.noOpDeleteLogs === 'written') {
    const oldId = oldOrZero(chain.old, zero);
    for (const link of chain.links) {
      updates.push({ kind: 'reflogOnly', name: link, reflog: { oldId, newId: zero, message } });
    }
    const coupled = coupledHeadEntry(chain, head, zero, message, logging, zero);
    if (coupled !== undefined) updates.push(coupled);
  }
  if (
    options.noDeref === true &&
    chain.terminalIsSymbolic &&
    logging.symbolicDeleteLog === 'kept-with-entry'
  ) {
    const oldId = oldOrZero(chain.old, zero);
    updates.push({
      kind: 'reflogOnly',
      name: chain.terminal,
      reflog: { oldId, newId: zero, message },
    });
  }
  return updates;
}

/**
 * git tolerates an unreadable HEAD when updating any other ref: HEAD simply
 * reads as uncoupled and only the logs/HEAD entry is skipped. HEAD's own
 * malformed content is forgiven here; an I/O failure still propagates.
 */
async function resolveHeadForCoupling(store: RefStore): Promise<ResolveDirectResult> {
  try {
    return await store.resolveDirect(HEAD);
  } catch (error) {
    if (errorDataCode(error) === 'INVALID_REF') return { kind: 'missing' };
    throw error;
  }
}
