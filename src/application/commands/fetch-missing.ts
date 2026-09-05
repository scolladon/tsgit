/**
 * `fetchMissing` — fetch objects a partial clone omitted, from the configured
 * promisor remote. Exposes two entry points over one internal routine
 * (`docs/design/partial-clone.md` §8.2):
 *
 *  - `fetchMissing` — the Tier-1 command; throws `NO_PROMISOR_REMOTE` on a
 *    non-partial repository.
 *  - `createPromisorRemote` — the `PromisorRemote` port implementation behind
 *    `readObject`'s automatic lazy-fetch; reports `attempted: false` instead.
 */
import { noPromisorRemote, remoteNotConfigured } from '../../domain/index.js';
import type { ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import type { PromisorRemote } from '../../ports/promisor.js';
import { readConfig } from '../primitives/config-read.js';
import { fetchPack } from '../primitives/fetch-pack.js';
import { assertValidPromisorRemoteConfig } from '../primitives/internal/boolean-config-guard.js';
import { createPackRegistry, type PackRegistry } from '../primitives/pack-registry.js';
import { commonGitDir, looseObjectPath } from '../primitives/path-layout.js';
import { negotiateDiscovery, negotiatePackBytes } from './internal/fetch-negotiation.js';
import { openGitSession } from './internal/git-service-session.js';
import { assertPeerAlgorithm } from './internal/object-format-guard.js';
import { assertOperationalRepository } from './internal/repo-state.js';
import { selectFetchCapabilities } from './internal/upload-pack-client.js';

export interface FetchMissingOptions {
  /** Object ids to fetch. Ones already present locally are skipped. */
  readonly oids: ReadonlyArray<ObjectId>;
}

export interface FetchMissingResult {
  /** The promisor remote the objects were fetched from. */
  readonly remote: string;
  /** Objects the caller asked for. */
  readonly requested: number;
  /** Objects that were missing locally and got fetched. */
  readonly fetched: number;
}

const FETCH_MISSING_OP = 'fetch-missing:write-objects';

type FetchMissingOutcome =
  | { readonly kind: 'no-promisor' }
  | {
      readonly kind: 'fetched';
      readonly remote: string;
      readonly requested: number;
      readonly fetched: number;
    };

/** Loose-object probe + pack-registry lookup — no `readObject`, no re-entry. */
const objectExistsLocally = async (
  ctx: Context,
  registry: PackRegistry,
  id: ObjectId,
): Promise<boolean> => {
  if (await ctx.fs.exists(looseObjectPath(commonGitDir(ctx), id))) return true;
  return (await registry.lookup(id)) !== undefined;
};

/** The oids not already present locally, de-duplicated, order-preserving. */
const collectMissing = async (
  ctx: Context,
  oids: ReadonlyArray<ObjectId>,
): Promise<ReadonlyArray<ObjectId>> => {
  const registry = createPackRegistry(ctx);
  const seen = new Set<string>();
  const missing: ObjectId[] = [];
  for (const id of oids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!(await objectExistsLocally(ctx, registry, id))) missing.push(id);
  }
  return missing;
};

const fetchMissingInternal = async (
  ctx: Context,
  oids: ReadonlyArray<ObjectId>,
): Promise<FetchMissingOutcome> => {
  await assertOperationalRepository(ctx);
  const config = await readConfig(ctx);
  const remoteName = config.extensions?.partialClone;
  if (remoteName === undefined) return { kind: 'no-promisor' };
  // Promisor-remote guard (see assertValidPromisorRemoteConfig) — on the lazy-fetch path.
  await assertValidPromisorRemoteConfig(ctx);
  const url = config.remote?.get(remoteName)?.url;
  // An absent OR empty url means the promisor remote is not usably configured;
  // surface REMOTE_NOT_CONFIGURED rather than a cryptic INVALID_BASE_URL.
  if (url === undefined || url === '') throw remoteNotConfigured(remoteName);

  const missing = await collectMissing(ctx, oids);
  if (missing.length === 0) {
    return { kind: 'fetched', remote: remoteName, requested: oids.length, fetched: 0 };
  }

  const session = openGitSession(ctx, url, 'git-upload-pack');
  try {
    const discovery = await negotiateDiscovery(ctx, session);
    // The lazy-fetch path reaches a peer exactly as `fetch` does, so it owes
    // the same refusal — otherwise a cross-format promisor writes wrong-width
    // oids into the repository with nothing objecting.
    assertPeerAlgorithm(ctx.hashConfig.algorithm, discovery.objectFormat, 'fetch');
    const capabilities = selectFetchCapabilities(
      discovery.advertisement.capabilities,
      ctx.hashConfig.algorithm,
    );
    // No `filter`: a lazy-fetch requests exact oids. A pack another fetch
    // landed first is adopted by the receive path itself, so nothing is
    // tolerated here — a differing artefact at that name is a refusal.
    await fetchPack(ctx, (c, req) => negotiatePackBytes(c, session, discovery.version, req), {
      wants: missing,
      haves: [],
      capabilities,
      progressOp: FETCH_MISSING_OP,
      promisor: true,
    });
  } finally {
    await session.close();
  }
  return { kind: 'fetched', remote: remoteName, requested: oids.length, fetched: missing.length };
};

/**
 * Fetch the named objects from the repository's promisor remote. Throws
 * `NO_PROMISOR_REMOTE` when the repository is not a partial clone.
 */
export const fetchMissing = async (
  ctx: Context,
  opts: FetchMissingOptions,
): Promise<FetchMissingResult> => {
  const outcome = await fetchMissingInternal(ctx, opts.oids);
  if (outcome.kind === 'no-promisor') throw noPromisorRemote();
  return { remote: outcome.remote, requested: outcome.requested, fetched: outcome.fetched };
};

/**
 * `PromisorRemote` port implementation — the seam `readObject` calls on a
 * miss. A non-partial repository yields `attempted: false` (rather than
 * throwing) so `readObject` falls through to its normal `OBJECT_NOT_FOUND`.
 */
export const createPromisorRemote = (ctx: Context): PromisorRemote => ({
  fetch: async (oids) => {
    const outcome = await fetchMissingInternal(ctx, oids);
    if (outcome.kind === 'no-promisor') {
      return { attempted: false, requested: oids.length, fetched: 0 };
    }
    return { attempted: true, requested: outcome.requested, fetched: outcome.fetched };
  },
});
