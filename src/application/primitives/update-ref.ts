/**
 * Ref-update transaction. Verifies the target, walks the symref chain, then
 * lands the new value and its reflog entries across whichever backend the
 * repository uses (loose files, `packed-refs`, or reftable).
 *
 * The per-backend byte formats are declared by their own writers; what this
 * module owns is the transaction's outcome — which refs exist, what they
 * point at, and which reflogs grew — so the comparison against canonical
 * git is the readback (`git show-ref --verify`, `git symbolic-ref`), not
 * the ref file's bytes.
 *
 * @writes
 *   surface: updateRef
 *   kind:    equivalent-under-readback
 *   format:  git-ref-transaction-state
 */
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

/** What every entry of one update's transaction shares: the walked chain,
 *  the `HEAD` value it may couple with, the backend's logging shape, the
 *  null id, and the reflog message (empty when a delete carries none). */
interface TransactionPlan {
  readonly chain: RefWriteChain;
  readonly head: ResolveDirectResult;
  readonly logging: TransactionLogging;
  readonly zero: ObjectId;
  readonly message: string;
}

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
  const plan = await planTransaction(ctx, store, name, options);
  assertExpected(name, options.expected, plan.chain);
  await store.applyRefUpdates(
    isDelete(ctx, newId, options) ? deleteUpdates(plan, options) : writeUpdates(plan, newId),
  );
}

/** What a {@link deleteRefs} run carries to every delete it plans. */
export interface DeleteRefsOptions {
  readonly noDeref?: boolean;
  /** The message of every log entry the deletes produce (empty when absent). */
  readonly reflogMessage?: string;
}

/**
 * Deletes `names` as ONE ref transaction — git's `refs_delete_refs`: every
 * name is validated and its chain walked before anything is written, then
 * all the deletes apply as one run (one `packed-refs` rewrite, one reftable
 * table), followed by the log entries each delete produces, exactly as
 * {@link updateRef} would produce them one name at a time.
 */
export async function deleteRefs(
  ctx: Context,
  names: readonly RefName[],
  options: DeleteRefsOptions,
): Promise<void> {
  for (const name of names) validateRefName(name);
  const store = getRefStore(ctx);
  const deleteOptions = { ...options, delete: true } as const;
  const updates: RefUpdate[] = [];
  for (const name of names) {
    const plan = await planTransaction(ctx, store, name, deleteOptions);
    updates.push(...deleteUpdates(plan, deleteOptions));
  }
  await store.applyRefUpdates(deletesFirst(updates));
}

/** `updates` with every store-level delete moved ahead of the log entries,
 *  each group keeping its own order — so the deletes form a single run. */
const deletesFirst = (updates: readonly RefUpdate[]): readonly RefUpdate[] => [
  ...updates.filter((update) => update.kind === 'delete'),
  ...updates.filter((update) => update.kind !== 'delete'),
];

/** Walks `name`'s write chain and reads the `HEAD` value it may couple with. */
async function planTransaction(
  ctx: Context,
  store: RefStore,
  name: RefName,
  options: UpdateRefOptions,
): Promise<TransactionPlan> {
  const chain = await resolveWriteChain(store, name, options);
  // Resolved before any write so a genuine I/O error refuses the whole
  // update instead of leaving a committed ref, a written reflog, and a
  // thrown call. A chain that walks HEAD already read it, and never couples.
  const head = walksHead(name, chain) ? UNCOUPLED_HEAD : await resolveHeadForCoupling(store);
  const logging = transactionLogging(ctx);
  const message = options.reflogMessage ?? '';
  return { chain, head, logging, zero: zeroOid(ctx.hashConfig), message };
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
function coupledHeadEntry(plan: TransactionPlan, newId: ObjectId): RefUpdate | undefined {
  const { chain, head, logging, zero, message } = plan;
  if (head.kind !== 'symbolic') return undefined;
  const namesLink = chain.links.includes(head.target);
  if (head.target !== chain.terminal && !namesLink) return undefined;
  const oldId =
    namesLink && logging.headOldThroughLink === 'null-id' ? zero : oldOrZero(chain.old, zero);
  return { kind: 'reflogOnly', name: HEAD, reflog: { oldId, newId, message } };
}

/** The entries git's transaction splits off at each symbolic hop: one
 *  `reflogOnly` per walked link — unconditional, even when the value is
 *  unchanged — and the coupled `HEAD` entry, when it applies. */
function splitLogEntries(plan: TransactionPlan, newId: ObjectId): readonly RefUpdate[] {
  const reflog = { oldId: oldOrZero(plan.chain.old, plan.zero), newId, message: plan.message };
  const links = plan.chain.links.map((name): RefUpdate => ({ kind: 'reflogOnly', name, reflog }));
  const coupled = coupledHeadEntry(plan, newId);
  return coupled === undefined ? links : [...links, coupled];
}

/** The updates a write produces: the terminal's own `set` (reflog attached
 *  unless old === new), then the {@link splitLogEntries}. */
function writeUpdates(plan: TransactionPlan, newId: ObjectId): readonly RefUpdate[] {
  const oldId = oldOrZero(plan.chain.old, plan.zero);
  const reflog = { oldId, newId, message: plan.message };
  const terminal: RefUpdate = {
    kind: 'set',
    name: plan.chain.terminal,
    id: newId,
    ...(oldId !== newId ? { reflog } : {}),
  };
  return [terminal, ...splitLogEntries(plan, newId)];
}

/** A delete's {@link splitLogEntries}. When the terminal is ABSENT they are
 *  backend-specific (`noOpDeleteLogs`): the files backend still writes them
 *  as `0{40} 0{40}`, the reftable backend writes none. */
function deleteSplitLogEntries(plan: TransactionPlan): readonly RefUpdate[] {
  const written = plan.chain.old !== 'absent' || plan.logging.noOpDeleteLogs === 'written';
  return written ? splitLogEntries(plan, plan.zero) : [];
}

/** A `noDeref` delete of a symbolic ref on the reftable backend keeps its
 *  log (the store never tombstones it, see `applyDeleteRecords`) and gains
 *  one more entry recording the deletion itself; elsewhere, none. */
function keptSymbolicLogEntry(
  plan: TransactionPlan,
  options: UpdateRefOptions,
): readonly RefUpdate[] {
  const { chain, logging, zero, message } = plan;
  const kept = logging.symbolicDeleteLog === 'kept-with-entry' && chain.terminalIsSymbolic;
  if (options.noDeref !== true || !kept) return [];
  const reflog = { oldId: oldOrZero(chain.old, zero), newId: zero, message };
  return [{ kind: 'reflogOnly', name: chain.terminal, reflog }];
}

/** The updates a delete produces: the store-level `delete` of the terminal,
 *  always, then its split log entries and the kept symbolic log entry. */
function deleteUpdates(plan: TransactionPlan, options: UpdateRefOptions): readonly RefUpdate[] {
  return [
    { kind: 'delete', name: plan.chain.terminal },
    ...deleteSplitLogEntries(plan),
    ...keptSymbolicLogEntry(plan, options),
  ];
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
