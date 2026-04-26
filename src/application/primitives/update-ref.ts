import { unsupportedOperation } from '../../domain/error.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { refNotFound, refUpdateConflict } from '../../domain/refs/error.js';
import { validateRefName } from '../../domain/refs/ref-validation.js';
import type { Context } from '../../ports/context.js';
import { atomicWriteRef } from './atomic-write.js';
import { looseRefPath } from './path-layout.js';
import { getRefStore } from './ref-store.js';
import type { UpdateRefOptions } from './types.js';

export async function updateRef(
  ctx: Context,
  name: RefName,
  newId: ObjectId,
  options?: UpdateRefOptions,
): Promise<void> {
  // validateRefName rejects `..`, absolute paths, and every character class
  // that could let `${gitDir}/${name}` escape the repo — no separate path
  // containment check is needed.
  validateRefName(name);
  const refPath = looseRefPath(ctx.layout.gitDir, name);

  const store = getRefStore(ctx);

  if (options?.expected !== undefined) {
    const current = await store.resolveDirect(name);
    const actual = current.kind === 'direct' ? current.id : 'absent';
    if (options.expected !== actual) {
      throw refUpdateConflict(name, options.expected, actual);
    }
  }

  if (options?.delete === true) {
    const looseExists = await store.isLoose(name);
    if (looseExists) {
      await store.removeLoose(name);
      return;
    }
    const packed = await store.resolveDirect(name);
    if (packed.kind === 'direct') {
      throw unsupportedOperation(
        'delete-packed-ref',
        'deleting packed-only refs requires packed-refs rewrite (Phase 9)',
      );
    }
    // Neither loose nor packed — surface a clear error instead of silently
    // succeeding. Callers that want idempotent delete can catch refNotFound.
    throw refNotFound(name);
  }

  const content = new TextEncoder().encode(`${newId}\n`);
  await atomicWriteRef(ctx, name, refPath, content);
}
