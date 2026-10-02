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
import { errorDataCode } from '../../domain/error-data-code.js';
import { noPromisorRemote, remoteNotConfigured } from '../../domain/index.js';
import type { ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import type { PromisorRemote } from '../../ports/promisor.js';
import {
  type ParsedConfig,
  readConfig,
  readPromisorRemoteNames,
} from '../primitives/config-read.js';
import { fetchPack } from '../primitives/fetch-pack.js';
import { hasObject } from '../primitives/has-object.js';
import { assertValidPromisorRemoteConfig } from '../primitives/internal/boolean-config-guard.js';
import { getObjectStore } from '../primitives/object-store.js';
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

/** The oids not already present locally, de-duplicated, order-preserving. */
const collectMissing = async (
  ctx: Context,
  oids: ReadonlyArray<ObjectId>,
): Promise<ReadonlyArray<ObjectId>> => {
  // One rescan up front, so a pack another process landed since the last scan
  // is seen, then a plain presence probe per oid across every source.
  await (await getObjectStore(ctx)).reprepare();
  const seen = new Set<string>();
  const missing: ObjectId[] = [];
  for (const id of oids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!(await hasObject(ctx, id))) missing.push(id);
  }
  return missing;
};

/** Fetch `missing` from one remote, refusing one whose url is absent or empty. */
const fetchFrom = async (
  ctx: Context,
  url: string | undefined,
  remoteName: string,
  missing: ReadonlyArray<ObjectId>,
): Promise<void> => {
  // An absent OR empty url means the promisor remote is not usably configured;
  // surface REMOTE_NOT_CONFIGURED rather than a cryptic INVALID_BASE_URL.
  if (url === undefined || url === '') throw remoteNotConfigured(remoteName);
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
};

/**
 * One remote short of the last: a classified failure hands the fetch on, as
 * git's does — warned first, where git's fetch child leaves its stderr.
 */
const fetchSucceeded = async (
  ctx: Context,
  config: ParsedConfig,
  name: string,
  wanted: ReadonlyArray<ObjectId>,
): Promise<boolean> => {
  try {
    await fetchFrom(ctx, config.remote?.get(name)?.url, name, wanted);
    return true;
  } catch (err) {
    if (errorDataCode(err) === undefined) throw err;
    ctx.logger?.warn?.('fetchMissing: promisor remote failed, trying the next', {
      remote: name,
      error: (err as { readonly data: unknown }).data,
    });
    return false;
  }
};

/**
 * git's `try_promisor_remotes`: each remote in turn until one fetch succeeds.
 * A failed remote passes what is still missing to the next; the last one's
 * failure is the caller's. Returns the remote that served the fetch.
 */
const fetchFromFirstServing = async (
  ctx: Context,
  config: ParsedConfig,
  remotes: { readonly before: ReadonlyArray<string>; readonly last: string },
  missing: ReadonlyArray<ObjectId>,
): Promise<string> => {
  let wanted = missing;
  for (const name of remotes.before) {
    if (await fetchSucceeded(ctx, config, name, wanted)) return name;
    wanted = await collectMissing(ctx, wanted);
    if (wanted.length === 0) return name;
  }
  await fetchFrom(ctx, config.remote?.get(remotes.last)?.url, remotes.last, wanted);
  return remotes.last;
};

const fetchMissingInternal = async (
  ctx: Context,
  oids: ReadonlyArray<ObjectId>,
): Promise<FetchMissingOutcome> => {
  await assertOperationalRepository(ctx);
  const config = await readConfig(ctx);
  const remotes = await readPromisorRemoteNames(ctx);
  const [first] = remotes;
  const last = remotes.at(-1);
  if (first === undefined || last === undefined) return { kind: 'no-promisor' };
  // Promisor-remote guard (see assertValidPromisorRemoteConfig) — on the lazy-fetch path.
  await assertValidPromisorRemoteConfig(ctx);
  const missing = await collectMissing(ctx, oids);
  if (missing.length === 0) {
    return { kind: 'fetched', remote: first, requested: oids.length, fetched: 0 };
  }
  const before = remotes.slice(0, -1);
  const remote = await fetchFromFirstServing(ctx, config, { before, last }, missing);
  return { kind: 'fetched', remote, requested: oids.length, fetched: missing.length };
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
