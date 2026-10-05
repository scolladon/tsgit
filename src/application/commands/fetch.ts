/**
 * `fetch` command. Real upload-pack-driven body.
 *
 * Flow (see `docs/design/phase-12-2-fetch.md`):
 *  1. Resolve the remote name → URL via `.git/config`.
 *  2. Discover refs over smart-HTTP v1 (`info/refs?service=git-upload-pack`).
 *  3. Derive `haves` from the local commit graph reachable from
 *  `refs/remotes/<remote>/*` (capped at MAX_HAVES).
 *  4. POST `git-upload-pack` with `want` + `have` + `deepen` (when depth set)
 *  via the shared `fetchPack` primitive.
 *  5. If the server emitted shallow / unshallow lines, persist `.git/shallow`.
 *  6. Write each advertised ref to the local ref `remote.<name>.fetch` maps it
 *  onto, then — when any refspec stores into a ref — every `refs/tags/<tag>`.
 *  7. If `prune: true`, delete each local ref those refspecs map from a remote
 *  ref the server no longer advertises.
 *
 * Working-tree materialization is out of scope.
 */
import { remoteAdvertisesNoRefs, remoteNotConfigured } from '../../domain/index.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import type { Advertisement } from '../../domain/protocol/index.js';
import {
  formatObjectFilter,
  parseObjectFilter,
  remoteFilterUnsupported,
} from '../../domain/protocol/index.js';
import { FETCH_PRUNE_REFLOG, fetchStoringHead } from '../../domain/reflog/reflog-messages.js';
import { isSafeRefName, validateRefName } from '../../domain/refs/ref-validation.js';
import { shortBranchName } from '../../domain/refs/short-branch-name.js';
import type { Context } from '../../ports/context.js';
import { readConfig, warnSlashLeadingPromisorRemotes } from '../primitives/config-read.js';
import { fetchPack } from '../primitives/fetch-pack.js';
import { hasObject } from '../primitives/has-object.js';
import { assertNoValuelessConfig } from '../primitives/internal/valueless-config-guard.js';
import { getRefStore } from '../primitives/ref-store.js';
import { updateShallow } from '../primitives/shallow-file.js';
import { MAX_HAVES, MAX_WALK_SEEDS } from '../primitives/types.js';
import { deleteRefs, updateRef } from '../primitives/update-ref.js';
import { walkCommits } from '../primitives/walk-commits.js';
import { assertValidRemoteName, defaultRemoteName } from './internal/default-remote.js';
import { negotiateDiscovery, negotiatePackBytes } from './internal/fetch-negotiation.js';
import { type MappedRef, mapFetchedRefs } from './internal/fetch-ref-map.js';
import { type GitServiceSession, openGitSession } from './internal/git-service-session.js';
import { assertPeerAlgorithm } from './internal/object-format-guard.js';
import { readRemoteConfig } from './internal/remote-config.js';
import { findTrackedSources } from './internal/remote-tracking-ref.js';
import {
  assertOperationalRepository,
  branchRefFromHead,
  readHeadRaw,
} from './internal/repo-state.js';
import {
  advertisesFilter,
  selectFetchCapabilities,
  uniqueRefOids,
} from './internal/upload-pack-client.js';

export interface FetchOptions {
  /**
   * Remote to fetch from. Default: `branch.<current>.remote` ?? the sole
   * configured remote ?? `'origin'`; detached HEAD skips the branch step.
   */
  readonly remote?: string;
  readonly refspecs?: ReadonlyArray<string>;
  readonly prune?: boolean;
  /** Shallow clone depth. Delegates to fetchPack's deepen path. */
  readonly depth?: number;
}

export interface FetchUpdate {
  readonly name: RefName;
  readonly oldId: ObjectId | undefined;
  readonly newId: ObjectId;
}

export interface FetchResult {
  readonly remote: string;
  readonly url: string;
  readonly updatedRefs: ReadonlyArray<FetchUpdate>;
  /** Refs deleted because the server no longer advertises them (prune semantics). */
  readonly prunedRefs: ReadonlyArray<RefName>;
  /** New shallow boundaries written to `.git/shallow` during this fetch. */
  readonly shallow: ReadonlyArray<ObjectId>;
  /** Commits that crossed the shallow → non-shallow boundary during this fetch. */
  readonly unshallow: ReadonlyArray<ObjectId>;
}

const FETCH_NEGOTIATE_OP = 'fetch:negotiate';
const REFS_PREFIX = 'refs/';
const FETCH_WRITE_OBJECTS_OP = 'fetch:write-objects';

export const fetch = async (ctx: Context, opts: FetchOptions = {}): Promise<FetchResult> => {
  await assertOperationalRepository(ctx);
  const head = await readHeadRaw(ctx);
  const branchRef = branchRefFromHead(head);
  const currentBranch = branchRef !== undefined ? shortBranchName(branchRef) : undefined;
  const config = await readRemoteConfig(ctx);
  const remoteName = defaultRemoteName(config, opts.remote, currentBranch);
  const trackingSpecs = config.remote?.get(remoteName)?.fetch ?? [];
  // git's single-remote fetch asks `repo_has_promisor_remote` before it fetches.
  await warnSlashLeadingPromisorRemotes(ctx);
  const { url, filter } = await resolveRemoteUrl(ctx, remoteName);

  ctx.progress.start(FETCH_NEGOTIATE_OP);
  try {
    return await fetchViaSession(ctx, opts, { name: remoteName, trackingSpecs }, url, filter);
  } finally {
    ctx.progress.end(FETCH_NEGOTIATE_OP);
  }
};

/** The remote fetched from: its name, and the refspecs mapping its refs locally. */
interface FetchRemote {
  readonly name: string;
  readonly trackingSpecs: ReadonlyArray<string>;
}

const fetchViaSession = async (
  ctx: Context,
  opts: FetchOptions,
  remote: FetchRemote,
  url: string,
  filter: string | undefined,
): Promise<FetchResult> => {
  const session = openGitSession(ctx, url, 'git-upload-pack');
  try {
    return await negotiateAndApply(ctx, opts, remote, url, filter, session);
  } finally {
    await session.close();
  }
};

const negotiateAndApply = async (
  ctx: Context,
  opts: FetchOptions,
  remote: FetchRemote,
  url: string,
  filter: string | undefined,
  session: GitServiceSession,
): Promise<FetchResult> => {
  const discovery = await negotiateDiscovery(ctx, session);
  assertPeerAlgorithm(ctx.hashConfig.algorithm, discovery.objectFormat, 'fetch');
  const advertisement = discovery.advertisement;
  if (advertisement.refs.length === 0) throw remoteAdvertisesNoRefs();
  // A partial repo's fetch must re-apply its filter; the server must still
  // advertise the `filter` capability.
  if (filter !== undefined && !advertisesFilter(advertisement.capabilities)) {
    throw remoteFilterUnsupported();
  }

  const capabilities = selectFetchCapabilities(
    advertisement.capabilities,
    ctx.hashConfig.algorithm,
  );
  const wants = uniqueRefOids(advertisement.refs);

  // A partial repo's wanted objects may be legitimately promised-absent (the
  // filter deliberately omits them), and a `depth` request needs to reach the
  // server regardless of local presence — deepening extends history the
  // server holds, it doesn't just fetch an already-known tip. The
  // local-presence short-circuit only applies to full, unfiltered,
  // non-deepening fetches: when everything is already on disk, the
  // upload-pack exchange has nothing to contribute — skip it and go straight
  // to updating refs. Checked before deriving haves: the have-walk is wasted
  // work when this short-circuit is about to discard it anyway.
  if (filter === undefined && opts.depth === undefined && (await isEverythingLocal(ctx, wants))) {
    return applyRefsAndBuildResult(ctx, opts, remote, url, advertisement, [], []);
  }

  const haves = await deriveHaves(ctx, remote.name);
  const packResult = await fetchPack(
    ctx,
    (c, req) => negotiatePackBytes(c, session, discovery.version, req),
    {
      wants,
      haves,
      capabilities,
      progressOp: FETCH_WRITE_OBJECTS_OP,
      // Stryker disable next-line ConditionalExpression: equivalent — fetchPack gates on input.depth !== undefined, so depth:undefined behaves identically to a missing key.
      ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
      // A partial repo re-applies its stored filter and re-marks the pack promisor.
      ...(filter !== undefined ? { filter, promisor: true } : {}),
    },
  );

  if (packResult.shallow.length > 0 || packResult.unshallow.length > 0) {
    await updateShallow(ctx, {
      shallow: packResult.shallow,
      unshallow: packResult.unshallow,
    });
  }

  return applyRefsAndBuildResult(
    ctx,
    opts,
    remote,
    url,
    advertisement,
    packResult.shallow,
    packResult.unshallow,
  );
};

const isEverythingLocal = async (
  ctx: Context,
  wants: ReadonlyArray<ObjectId>,
): Promise<boolean> => {
  for (const id of wants) {
    // Recheck mode: git's `check_exist_and_connected` calls `odb_has_object`
    // with `HAS_OBJECT_RECHECK_PACKED` here — a quick probe against a
    // registry scanned before a concurrent writer packed this exact id
    // would wrongly deny the short-circuit and pay a needless round trip.
    if (!(await hasObject(ctx, id, { mode: 'recheck' }))) return false;
  }
  return true;
};

const applyRefsAndBuildResult = async (
  ctx: Context,
  opts: FetchOptions,
  remote: FetchRemote,
  url: string,
  advertisement: Advertisement,
  shallow: ReadonlyArray<ObjectId>,
  unshallow: ReadonlyArray<ObjectId>,
): Promise<FetchResult> => {
  const refMap = mapFetchedRefs(remote.trackingSpecs, advertisement.refs);
  const updatedRefs = await applyRemoteRefs(ctx, remote.name, refMap);
  const prunedRefs = opts.prune === true ? await prune(ctx, remote.trackingSpecs, refMap) : [];

  return {
    remote: remote.name,
    url,
    updatedRefs,
    prunedRefs,
    shallow,
    unshallow,
  };
};

const resolveRemoteUrl = async (
  ctx: Context,
  remoteName: string,
): Promise<{ url: string; filter: string | undefined }> => {
  assertValidRemoteName(remoteName);
  const config = await readConfig(ctx);
  const remote = config.remote?.get(remoteName);
  // An absent OR empty url means the remote is not usably configured.
  if (remote?.url === undefined || remote.url === '') {
    await assertNoValuelessConfig(ctx, 'remote', remoteName, ['url']);
    throw remoteNotConfigured(remoteName);
  }
  // A partial repo re-applies its recorded filter so a fetch does not pull
  // full blobs and silently un-partial the repo. The stored value is
  // re-validated — a hand-corrupted config filter is rejected before the wire.
  const filter =
    remote.partialCloneFilter !== undefined
      ? formatObjectFilter(parseObjectFilter(remote.partialCloneFilter))
      : undefined;
  return { url: remote.url, filter };
};

/**
 * Collect haves from the local object graph. Strategy:
 *
 *  1. Read every ref tip under `refs/remotes/<remote>/` and `refs/tags/`
 *  (loose or packed). These tips ARE the first-class haves — the server
 *  uses them to filter the pack without needing their ancestors.
 *  2. Walk the commit graph from those tips (ignoring missing objects) and
 *  append the reachable commits in BFS order until `MAX_HAVES` is
 *  reached.
 *
 * A tip whose object is missing locally still gets sent as a have — the
 * server may ignore it, but if it happens to be the cut-point we want, this
 * keeps the negotiation honest.
 */
const deriveHaves = async (ctx: Context, remoteName: string): Promise<ReadonlyArray<ObjectId>> => {
  const seeds = await collectRefTips(ctx, remoteName);
  if (seeds.length === 0) return [];
  const seen = new Set<string>();
  const haves: ObjectId[] = [];
  for (const tip of seeds) {
    if (seen.has(tip)) continue;
    seen.add(tip);
    haves.push(tip);
    if (haves.length >= MAX_HAVES) return haves;
  }
  // Stryker disable next-line MethodExpression: equivalent — dropping `.slice(0, MAX_WALK_SEEDS)` only differs when seeds.length > 1024, a pathological scale no fixture reaches.
  const cappedSeeds = seeds.slice(0, MAX_WALK_SEEDS);
  for await (const commit of walkCommits(ctx, {
    from: cappedSeeds,
    ignoreMissing: true,
  })) {
    if (seen.has(commit.id)) continue;
    seen.add(commit.id);
    haves.push(commit.id);
    if (haves.length >= MAX_HAVES) break;
  }
  return haves;
};

const collectRefTips = async (
  ctx: Context,
  remoteName: string,
): Promise<ReadonlyArray<ObjectId>> => {
  // `listRefs` already merges loose and packed storage, so repos that have
  // packed their refs (e.g. after `git gc`) contribute haves the same as an
  // unpacked one — without it, every fetch of a packed repo would send zero
  // haves and the server would resend a full pack.
  const store = getRefStore(ctx);
  const remoteEntries = await store.listRefs(`refs/remotes/${remoteName}/` as RefName);
  const tagEntries = await store.listRefs('refs/tags/' as RefName);
  const ids: ObjectId[] = [];
  for (const entry of [...remoteEntries, ...tagEntries]) {
    if (entry.value.kind === 'direct') ids.push(entry.value.id);
  }
  return ids;
};

const applyRemoteRefs = async (
  ctx: Context,
  remoteName: string,
  refMap: ReadonlyArray<MappedRef>,
): Promise<ReadonlyArray<FetchUpdate>> => {
  const updates: FetchUpdate[] = [];
  for (const { source, target } of refMap) {
    if (!isStorableRef(ctx, target)) continue;
    const name = target as RefName;
    const oldId = await readExistingRef(ctx, name);
    // An up-to-date ref is still listed, so callers tell "considered" from
    // "advanced" by comparing oldId and newId.
    if (oldId !== source.id) {
      await updateRef(ctx, name, source.id, { reflogMessage: fetchStoringHead(remoteName) });
    }
    updates.push({ name, oldId, newId: source.id });
  }
  return updates;
};

/**
 * git's `get_fetch_map` check: a local ref outside `refs/` or of a bad name is
 * ignored with an error — and never composed into a path, so a server's
 * `refs/heads/../../config` cannot reach a file outside the ref store.
 */
const isStorableRef = (ctx: Context, target: string): boolean => {
  if (target.startsWith(REFS_PREFIX) && isSafeRefName(target)) return true;
  ctx.logger?.error?.(`* Ignoring funny ref '${target}' locally`, { ref: target });
  return false;
};

const readExistingRef = async (ctx: Context, name: RefName): Promise<ObjectId | undefined> => {
  // Defense in depth: every caller of `readExistingRef` passes a name
  // `isStorableRef` already validated. We re-validate here so a
  // future refactor that loses the guard cannot reintroduce the
  // path-traversal vulnerability. validateRefName throws if invalid.
  validateRefName(name);
  // `resolveDirect` checks loose AND packed storage — a remote-tracking ref
  // that survived a `git gc` (packed, no loose file) is seen as existing, not
  // rewritten as brand new.
  const result = await getRefStore(ctx).resolveDirect(name);
  return result.kind === 'direct' ? result.id : undefined;
};

/**
 * git's `get_stale_heads`: a local ref is stale when the refspecs map it from
 * remote refs and none of them was fetched. A symref (`<remote>/HEAD`) is
 * never stale. Candidates come from `listRefs`, which only ever yields names
 * that resolve to a real ref.
 */
const prune = async (
  ctx: Context,
  trackingSpecs: ReadonlyArray<string>,
  refMap: ReadonlyArray<MappedRef>,
): Promise<ReadonlyArray<RefName>> => {
  const fetched = new Set(refMap.map((entry) => entry.source.name));
  const local = await getRefStore(ctx).listRefs(REFS_PREFIX as RefName);
  const stale = local
    .filter((entry) => entry.value.kind !== 'symbolic')
    .map((entry) => entry.name)
    .filter((name) => isStale(findTrackedSources(trackingSpecs, name), fetched));
  // One transaction, as git's prune queues every stale ref into one: a
  // packed-only tracking ref deletes like any other, and `packed-refs` is
  // rewritten once for the whole run.
  await deleteRefs(ctx, stale, { reflogMessage: FETCH_PRUNE_REFLOG });
  return stale;
};

const isStale = (sources: ReadonlyArray<string>, fetched: ReadonlySet<string>): boolean =>
  sources.length > 0 && !sources.some((source) => fetched.has(source));
