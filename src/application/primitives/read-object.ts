import type { GitObject, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { resolveObject } from './object-resolver.js';
import { createPackRegistry, type PackRegistry } from './pack-registry.js';
import type { ReadObjectOptions } from './types.js';

/**
 * Per-Context registry cache. Keyed by the Context instance so that a long-running
 * walk (walkCommits, walkTree) reuses the parsed .idx files across thousands of
 * object reads instead of re-scanning the pack directory each time.
 */
const registryCache = new WeakMap<Context, PackRegistry>();

function getPackRegistry(ctx: Context): PackRegistry {
  let registry = registryCache.get(ctx);
  if (registry === undefined) {
    registry = createPackRegistry(ctx);
    registryCache.set(ctx, registry);
  }
  return registry;
}

export async function readObject(
  ctx: Context,
  id: ObjectId,
  options?: ReadObjectOptions,
): Promise<GitObject> {
  const verifyHash = options?.verifyHash ?? true;
  return resolveObject(ctx, getPackRegistry(ctx), id, verifyHash, options?.maxBytes);
}
