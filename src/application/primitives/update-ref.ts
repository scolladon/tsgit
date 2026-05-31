import { unsupportedOperation } from '../../domain/error.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { ZERO_OID } from '../../domain/objects/index.js';
import { refNotFound, refUpdateConflict } from '../../domain/refs/error.js';
import { validateRefName } from '../../domain/refs/ref-validation.js';
import type { Context } from '../../ports/context.js';
import { atomicWriteRef } from './atomic-write.js';
import { looseRefPath } from './path-layout.js';
import { recordRefUpdate } from './record-ref-update.js';
import { getRefStore, type RefStore } from './ref-store.js';
import { deleteReflog } from './reflog-store.js';
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
  const refPath = looseRefPath(ctx.layout.gitDir, name);

  const store = getRefStore(ctx);
  const current = await store.resolveDirect(name);

  if (options.expected !== undefined) {
    const actual = current.kind === 'direct' ? current.id : 'absent';
    if (options.expected !== actual) {
      throw refUpdateConflict(name, options.expected, actual);
    }
  }

  if (options.delete === true) {
    await deleteRef(store, name);
    await deleteReflog(ctx, name);
    return;
  }

  const oldId = current.kind === 'direct' ? current.id : ZERO_OID;
  const content = new TextEncoder().encode(`${newId}\n`);
  await atomicWriteRef(ctx, name, refPath, content);
  // A no-op update (old === new) records no entry on the direct ref — git's ref
  // backend skips the reflog when the value is unchanged. The coupled HEAD is the
  // symref log-only path, which logs unconditionally (e.g. `reset: moving to`).
  if (oldId !== newId) {
    await recordRefUpdate(ctx, name, oldId, newId, options.reflogMessage);
  }
  await logCoupledHead(ctx, store, name, oldId, newId, options.reflogMessage);
}

async function deleteRef(store: RefStore, name: RefName): Promise<void> {
  const looseExists = await store.isLoose(name);
  if (looseExists) {
    await store.removeLoose(name);
    return;
  }
  const packed = await store.resolveDirect(name);
  if (packed.kind === 'direct') {
    throw unsupportedOperation(
      'delete-packed-ref',
      'deleting packed-only refs requires packed-refs rewrite',
    );
  }
  // Neither loose nor packed — surface a clear error instead of silently
  // succeeding. Callers that want idempotent delete can catch refNotFound.
  throw refNotFound(name);
}

/**
 * When HEAD symbolically points at the branch just written, git appends a
 * matching entry to `.git/logs/HEAD` too. `recordRefUpdate` self-gates, so a
 * closed gate makes this a cheap no-op.
 */
async function logCoupledHead(
  ctx: Context,
  store: RefStore,
  name: RefName,
  oldId: ObjectId,
  newId: ObjectId,
  reflogMessage: string,
): Promise<void> {
  const head = await store.resolveDirect(HEAD);
  if (head.kind !== 'symbolic') return;
  if (head.target !== name) return;
  await recordRefUpdate(ctx, HEAD, oldId, newId, reflogMessage);
}
