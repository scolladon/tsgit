import { errorDataCode } from '../../domain/error-data-code.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { zeroOid } from '../../domain/objects/index.js';
import { refUpdateConflict } from '../../domain/refs/error.js';
import { validateRefName } from '../../domain/refs/ref-validation.js';
import type { Context } from '../../ports/context.js';
import { transactionLogging } from './internal/ref-transaction-logging.js';
import {
  getRefStore,
  type RefStore,
  type RefUpdate,
  type ResolveDirectResult,
} from './ref-store.js';
import type { UpdateRefOptions } from './types.js';

const HEAD: RefName = 'HEAD' as RefName;

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

  const store = getRefStore(ctx);
  const current = await store.resolveDirect(name);
  // Resolved before any write so a genuine I/O error refuses the whole
  // update instead of leaving a committed ref, a written reflog, and a
  // thrown call.
  const head = await resolveHeadForCoupling(store);

  assertExpected(name, options.expected, current);

  // git marks a null new object id `REF_DELETING` and takes the delete path
  // unverified, exactly as `delete: true` does — the two are one transaction
  // shape, not two.
  if (options.delete === true || newId === zeroOid(ctx.hashConfig)) {
    const message = options.reflogMessage ?? '';
    await store.applyRefUpdates(deleteUpdates(ctx, name, current, head, message));
    return;
  }

  const oldId = current.kind === 'direct' ? current.id : zeroOid(ctx.hashConfig);
  await store.applyRefUpdates(refUpdatesFor(name, newId, oldId, options.reflogMessage, head));
}

/**
 * The one or two updates a delete produces: the store-level `delete` plus,
 * when `HEAD` symbolically names the ref being deleted, a coupled
 * `logs/HEAD` entry (`<old> 0{40} <message>`, X2/X3/X9). For an ABSENT
 * target the split entry is backend-specific (`TransactionLogging.noOpDeleteLogs`,
 * X5/X14/X16): the files backend still writes `0{40} 0{40}`, the reftable
 * backend writes nothing.
 */
function deleteUpdates(
  ctx: Context,
  name: RefName,
  current: ResolveDirectResult,
  head: ResolveDirectResult,
  message: string,
): readonly RefUpdate[] {
  const deletion: RefUpdate = { kind: 'delete', name };
  if (!coupledHeadTarget(head, name)) return [deletion];
  const zero = zeroOid(ctx.hashConfig);
  const absent = current.kind !== 'direct';
  if (absent && transactionLogging(ctx).noOpDeleteLogs === 'skipped') return [deletion];
  const reflog = { oldId: absent ? zero : current.id, newId: zero, message };
  return [deletion, { kind: 'reflogOnly', name: HEAD, reflog }];
}

/**
 * git's compare-and-swap: `expected` is checked against the GIVEN ref's own
 * current value before anything is written — never a symbolic ref's target
 * (dereferencing the write itself is a later change).
 */
function assertExpected(
  name: RefName,
  expected: ObjectId | 'absent' | undefined,
  current: ResolveDirectResult,
): void {
  if (expected === undefined) return;
  const actual = current.kind === 'direct' ? current.id : 'absent';
  if (expected !== actual) throw refUpdateConflict(name, expected, actual);
}

/**
 * The one or two updates a branch write produces: the direct `set`
 * (reflog attached unless old === new — git's ref backend skips the reflog
 * when the value is unchanged) plus, when HEAD symbolically points at `name`,
 * a `reflogOnly` HEAD entry — the symref log-only path, which logs
 * unconditionally (e.g. `reset: moving to`).
 */
function refUpdatesFor(
  name: RefName,
  newId: ObjectId,
  oldId: ObjectId,
  message: string,
  head: ResolveDirectResult,
): readonly RefUpdate[] {
  const set: RefUpdate = {
    kind: 'set',
    name,
    id: newId,
    ...(oldId !== newId ? { reflog: { oldId, newId, message } } : {}),
  };
  if (!coupledHeadTarget(head, name)) return [set];
  return [set, { kind: 'reflogOnly', name: HEAD, reflog: { oldId, newId, message } }];
}

/**
 * True when HEAD symbolically points at the ref just written — git appends a
 * matching entry to `.git/logs/HEAD` too in that case.
 */
function coupledHeadTarget(head: ResolveDirectResult, name: RefName): boolean {
  return head.kind === 'symbolic' && head.target === name;
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
