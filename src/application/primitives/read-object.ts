import { TsgitError } from '../../domain/error.js';
import { splitObject } from '../../domain/objects/git-object.js';
import type { GitObject, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import type { PromisorRemote } from '../../ports/promisor.js';
import { resolveObject, resolveObjectBytes } from './object-resolver.js';
import { createPackRegistry, type PackRegistry } from './pack-registry.js';
import type { RawObject, ReadObjectOptions } from './types.js';

/**
 * Per-session registry cache. Keyed by `ctx.session` (not the Context
 * instance itself) so that every Context derived from the same
 * `openRepository()`/`createXContext()` call — a long-running walk
 * (walkCommits, walkTree), or a same-repository derivation such as fsck's
 * audit view — reuses the parsed .idx files across thousands of object reads
 * instead of re-scanning the pack directory each time.
 */
const registryCache = new WeakMap<Context['session'], PackRegistry>();

/**
 * Per-session in-flight lazy-fetch map. Concurrent reads of the same missing
 * object share a single promisor fetch instead of each issuing its own.
 */
const inflightCache = new WeakMap<Context['session'], Map<string, Promise<boolean>>>();

export function getPackRegistry(ctx: Context): PackRegistry {
  let registry = registryCache.get(ctx.session);
  if (registry === undefined) {
    registry = createPackRegistry(ctx);
    registryCache.set(ctx.session, registry);
  }
  return registry;
}

/**
 * Drop the per-session pack-registry's cached `.idx` scan so the next read
 * re-scans `objects/pack/`. MUST be called after a pack is written into a live
 * Context (e.g. `fetchPack`), otherwise objects delivered by that pack are
 * invisible to subsequent reads through the same handle — the failure `pull`
 * exposed when its `merge` step could not see freshly-fetched commits.
 */
export function refreshPackRegistry(ctx: Context): void {
  registryCache.get(ctx.session)?.refresh();
}

/**
 * Close every persistent per-pack handle the registry opened for this
 * session. Does NOT create a registry if none exists — a repo that never
 * touched a pack disposes without scanning `objects/pack/`.
 */
export async function disposePackRegistry(ctx: Context): Promise<void> {
  await registryCache.get(ctx.session)?.dispose();
}

function getInflight(ctx: Context): Map<string, Promise<boolean>> {
  let inflight = inflightCache.get(ctx.session);
  if (inflight === undefined) {
    inflight = new Map();
    inflightCache.set(ctx.session, inflight);
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
 * Fetch `id` from the promisor remote, de-duplicating reads of the same
 * missing object whose fetches overlap in time — they share one promisor
 * call. A read that misses *after* an earlier fetch already completed is not
 * a duplicate: the object was genuinely absent for it, so it fetches anew.
 * Returns the promisor's `attempted` flag — false on a non-partial repo.
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

/**
 * Runs `run` once; on an `OBJECT_NOT_FOUND` miss with a promisor attached,
 * lazy-fetches the missing object and retries `run` exactly once. Shared by
 * `readObject` and `readRawObject` so a partial clone behaves identically on
 * both — a divergence here would let the raw path see a weaker retry
 * contract than the parsed one.
 */
async function withLazyFetchRetry<T>(
  ctx: Context,
  id: ObjectId,
  registry: PackRegistry,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const promisor = ctx.promisor;
    if (promisor === undefined || !isObjectNotFound(err)) throw err;
    // Partial-clone lazy-fetch: pull the missing object, refresh the pack
    // registry so the new pack is visible, then retry the resolve exactly once.
    const attempted = await lazyFetchOnce(ctx, promisor, id);
    // No fetch happened (non-partial repo): the store is unchanged, so a retry
    // would scan the packs again and throw the identical OBJECT_NOT_FOUND.
    // Surface the original error directly and skip that pointless re-resolve.
    if (!attempted) throw err;
    registry.refresh();
    return run();
  }
}

export async function readObject(
  ctx: Context,
  id: ObjectId,
  options?: ReadObjectOptions,
): Promise<GitObject> {
  const verifyHash = options?.verifyHash ?? false;
  const registry = getPackRegistry(ctx);
  return withLazyFetchRetry(ctx, id, registry, () =>
    resolveObject(ctx, registry, id, verifyHash, options?.maxBytes),
  );
}

export async function readRawObject(
  ctx: Context,
  id: ObjectId,
  options?: ReadObjectOptions,
): Promise<RawObject> {
  const verifyHash = options?.verifyHash ?? false;
  const registry = getPackRegistry(ctx);
  return withLazyFetchRetry(ctx, id, registry, async () =>
    splitObject(await resolveObjectBytes(ctx, registry, id, verifyHash, options?.maxBytes)),
  );
}
