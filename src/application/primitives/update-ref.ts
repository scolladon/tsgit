import { unsupportedOperation } from '../../domain/error.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { zeroOid } from '../../domain/objects/index.js';
import { refNotFound, refUpdateConflict } from '../../domain/refs/error.js';
import { validateRefName } from '../../domain/refs/ref-validation.js';
import type { Context } from '../../ports/context.js';
import { atomicWriteRef } from './atomic-write.js';
import { looseRefPath, perWorktreeRefDir } from './path-layout.js';
import { recordRefUpdate } from './record-ref-update.js';
import { getRefStore, type RefStore, type ResolveDirectResult } from './ref-store.js';
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
  const refPath = looseRefPath(perWorktreeRefDir(ctx, name), name);

  const store = getRefStore(ctx);
  const current = await store.resolveDirect(name);
  // Resolved before any write so a corrupt HEAD, a symref cycle, or an I/O
  // error refuses the whole update instead of leaving a committed ref, a
  // written reflog, and a thrown call.
  const head = await store.resolveDirect(HEAD);

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

  const oldId = current.kind === 'direct' ? current.id : zeroOid(ctx.hashConfig);
  const content = new TextEncoder().encode(`${newId}\n`);
  await atomicWriteRef(ctx, name, refPath, content);
  // A no-op update (old === new) records no entry on the direct ref — git's ref
  // backend skips the reflog when the value is unchanged. The coupled HEAD is the
  // symref log-only path, which logs unconditionally (e.g. `reset: moving to`).
  if (oldId !== newId) {
    await recordRefUpdate(ctx, name, oldId, newId, options.reflogMessage);
  }
  if (coupledHeadTarget(head, name)) {
    await recordRefUpdate(ctx, HEAD, oldId, newId, options.reflogMessage);
  }
}

/**
 * True when HEAD symbolically points at the ref just written — git appends a
 * matching entry to `.git/logs/HEAD` too in that case.
 */
function coupledHeadTarget(head: ResolveDirectResult, name: RefName): boolean {
  return head.kind === 'symbolic' && head.target === name;
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
