import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { zeroOid } from '../../domain/objects/index.js';
import { refUpdateConflict } from '../../domain/refs/error.js';
import { validateRefName } from '../../domain/refs/ref-validation.js';
import type { Context } from '../../ports/context.js';
import { errorDataCode } from './internal/error-data-code.js';
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

  if (options.expected !== undefined) {
    const actual = current.kind === 'direct' ? current.id : 'absent';
    if (options.expected !== actual) {
      throw refUpdateConflict(name, options.expected, actual);
    }
  }

  if (options.delete === true) {
    await store.applyRefUpdates([{ kind: 'delete', name }]);
    return;
  }

  const oldId = current.kind === 'direct' ? current.id : zeroOid(ctx.hashConfig);
  await store.applyRefUpdates(refUpdatesFor(name, newId, oldId, options.reflogMessage, head));
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
