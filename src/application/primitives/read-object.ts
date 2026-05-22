import { TsgitError } from '../../domain/error.js';
import type { GitObject, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import type { PromisorRemote } from '../../ports/promisor.js';
import { resolveObject } from './object-resolver.js';
import { createPackRegistry, type PackRegistry } from './pack-registry.js';
import type { ReadObjectOptions } from './types.js';

/**
 * Per-Context registry cache. Keyed by the Context instance so that a long-running
 * walk (walkCommits, walkTree) reuses the parsed .idx files across thousands of
 * object reads instead of re-scanning the pack directory each time.
 */
const registryCache = new WeakMap<Context, PackRegistry>();

/**
 * Per-Context in-flight lazy-fetch map. Concurrent reads of the same missing
 * object share a single promisor fetch instead of each issuing its own.
 */
const inflightCache = new WeakMap<Context, Map<string, Promise<boolean>>>();

function getPackRegistry(ctx: Context): PackRegistry {
  let registry = registryCache.get(ctx);
  if (registry === undefined) {
    registry = createPackRegistry(ctx);
    registryCache.set(ctx, registry);
  }
  return registry;
}

function getInflight(ctx: Context): Map<string, Promise<boolean>> {
  let inflight = inflightCache.get(ctx);
  if (inflight === undefined) {
    inflight = new Map();
    inflightCache.set(ctx, inflight);
  }
  return inflight;
}

/**
 * True when `err` is `OBJECT_NOT_FOUND`. tsgit strips `thin-pack`, so every
 * stored pack is self-contained — a resolver miss always means the requested
 * object itself is absent, never a dangling delta base.
 */
function isObjectNotFound(err: unknown): boolean {
  return err instanceof TsgitError && err.data.code === 'OBJECT_NOT_FOUND';
}

/**
 * Fetch `id` from the promisor remote, de-duplicating concurrent reads of the
 * same missing object so they share one fetch. Returns the promisor's
 * `attempted` flag — false when the repository is not a partial clone.
 */
async function lazyFetchOnce(
  ctx: Context,
  promisor: PromisorRemote,
  id: ObjectId,
): Promise<boolean> {
  const inflight = getInflight(ctx);
  const existing = inflight.get(id);
  if (existing !== undefined) return existing;
  const pending = promisor.fetch([id]).then((outcome) => outcome.attempted);
  inflight.set(id, pending);
  try {
    return await pending;
  } finally {
    inflight.delete(id);
  }
}

export async function readObject(
  ctx: Context,
  id: ObjectId,
  options?: ReadObjectOptions,
): Promise<GitObject> {
  const verifyHash = options?.verifyHash ?? true;
  const registry = getPackRegistry(ctx);
  try {
    return await resolveObject(ctx, registry, id, verifyHash, options?.maxBytes);
  } catch (err) {
    const promisor = ctx.promisor;
    if (promisor === undefined || !isObjectNotFound(err)) throw err;
    // Partial-clone lazy-fetch: pull the missing object, refresh the pack
    // registry so the new pack is visible, then retry the resolve exactly once.
    const attempted = await lazyFetchOnce(ctx, promisor, id);
    if (!attempted) throw err;
    registry.refresh();
    return resolveObject(ctx, registry, id, verifyHash, options?.maxBytes);
  }
}
