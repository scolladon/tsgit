/**
 * `fetch` command. Real upload-pack-driven body.
 *
 * Flow (see `docs/design/phase-12-2-fetch.md`):
 *  1. Resolve the remote name → URL via `.git/config`.
 *  2. Discover refs over smart-HTTP v1 (`info/refs?service=git-upload-pack`).
 *  3. Derive `haves` from the local commit graph reachable from every local
 *  ref (capped at MAX_HAVES); `wants` are the ref map's objects alone.
 *  4. POST `git-upload-pack` with `want` + `have` + `deepen` (when depth set)
 *  via the shared `fetchPack` primitive.
 *  5. If the server emitted shallow / unshallow lines, persist `.git/shallow`.
 *  6. Write each fetched ref to the local ref its refspec maps it onto — the
 *  command-line refspecs, else `remote.<name>.fetch` — then — when any refspec
 *  stores into a ref — every `refs/tags/<tag>`, and list them in `FETCH_HEAD`.
 *  7. If `prune: true`, delete each local ref those refspecs map from a remote
 *  ref the server no longer advertises.
 *
 * Working-tree materialization is out of scope.
 */
import {
  type FetchRejection,
  fetchIntoCheckedOutBranch,
  invalidOption,
} from '../../domain/commands/error.js';
import { errorDataCode } from '../../domain/error-data-code.js';
import { remoteNotConfigured } from '../../domain/index.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import { refspecInvalid } from '../../domain/protocol/error.js';
import type { AdvertisedRef, Advertisement } from '../../domain/protocol/index.js';
import {
  formatObjectFilter,
  parseObjectFilter,
  remoteFilterUnsupported,
} from '../../domain/protocol/index.js';
import {
  FETCH_PRUNE_REFLOG,
  type FetchReflogAction,
  fetchReflogMessage,
} from '../../domain/reflog/reflog-messages.js';
import { HEADS_PREFIX, TAGS_PREFIX } from '../../domain/refs/ref-prefixes.js';
import { isSafeRefName, validateRefName } from '../../domain/refs/ref-validation.js';
import { shortBranchName } from '../../domain/refs/short-branch-name.js';
import type { Context } from '../../ports/context.js';
import {
  findLastEntries,
  type ParsedConfig,
  readConfig,
  warnSlashLeadingPromisorRemotes,
} from '../primitives/config-read.js';
import { fetchPack } from '../primitives/fetch-pack.js';
import { hasObject } from '../primitives/has-object.js';
import { assertValidBooleanConfig } from '../primitives/internal/boolean-config-guard.js';
import { peelRefToCommit } from '../primitives/internal/peel-ref-to-commit.js';
import { assertNoValuelessConfig } from '../primitives/internal/valueless-config-guard.js';
import { getRefStore } from '../primitives/ref-store.js';
import { updateShallow } from '../primitives/shallow-file.js';
import { MAX_HAVES, MAX_WALK_SEEDS } from '../primitives/types.js';
import { deleteRefs, updateRef } from '../primitives/update-ref.js';
import { walkCommits } from '../primitives/walk-commits.js';
import { heldBranches } from './internal/checked-out-branches.js';
import { enabledByDefault } from './internal/default-on-setting.js';
import { assertValidRemoteName, defaultRemoteName } from './internal/default-remote.js';
import {
  fetchHeadEntries,
  fetchHeadUrl,
  formatFetchHead,
  writeFetchHead,
} from './internal/fetch-head.js';
import { negotiateDiscovery, negotiatePackBytes } from './internal/fetch-negotiation.js';
import {
  autoFollowsTags,
  findNonLocalTags,
  getRefMap,
  type LocalState,
  type MappedRef,
  type RefMapRequest,
} from './internal/fetch-ref-map.js';
import { followRemoteHead, readRemoteHeadPolicy } from './internal/fetch-remote-head.js';
import { type GitServiceSession, openGitSession } from './internal/git-service-session.js';
import { isAncestor } from './internal/is-ancestor.js';
import { assertPeerAlgorithm } from './internal/object-format-guard.js';
import { isValidFetchRefspec } from './internal/refspec-grammar.js';
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
  /**
   * Refspecs fetched instead of `remote.<name>.fetch` (git's command-line
   * `<refspec>…`). Every ref they name is listed for merging in `FETCH_HEAD`,
   * and still updates the tracking ref the configured refspecs map it onto.
   */
  readonly refspecs?: ReadonlyArray<string>;
  /**
   * git's `--refmap=<refspec>`, one entry per flag: the refspecs mapping the
   * `refspecs` refs onto tracking refs, in place of `remote.<name>.fetch`.
   * `['']` updates no tracking ref. Refused without `refspecs`.
   */
  readonly refmap?: ReadonlyArray<string>;
  readonly prune?: boolean;
  /** Shallow clone depth. Delegates to fetchPack's deepen path. */
  readonly depth?: number;
}

export type { FetchRejection } from '../../domain/commands/error.js';

interface RefMove {
  /** The local ref. */
  readonly name: RefName;
  /** The remote ref it is fetched from. */
  readonly source: RefName;
  readonly newId: ObjectId;
}

/** One local ref a fetch considered; an up-to-date ref is listed with `oldId === newId`. */
export type FetchUpdate =
  | (RefMove & { readonly oldId: ObjectId | undefined; readonly status: 'ok' })
  | (RefMove & {
      readonly oldId: ObjectId;
      /** The local ref stays at `oldId`; `FETCH_HEAD` still lists the fetched object. */
      readonly status: 'rejected';
      readonly rejection: FetchRejection;
    });

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

/**
 * Options only tsgit's own commands pass — never end users. Deliberately **not**
 * re-exported from the commands barrel, so it stays off the public API surface.
 */
export interface FetchInternalOptions {
  /** git's `--update-head-ok`, which only `git pull` passes: a refspec may write
   *  a branch a worktree holds. */
  readonly updateHeadOk?: boolean;
}

export const fetch = (ctx: Context, opts: FetchOptions = {}): Promise<FetchResult> =>
  fetchWith(ctx, opts, {});

export const fetchWith = async (
  ctx: Context,
  opts: FetchOptions,
  internal: FetchInternalOptions,
): Promise<FetchResult> => {
  await assertOperationalRepository(ctx);
  const forcedUpdates = await readForcedUpdateCheck(ctx);
  const head = await readHeadRaw(ctx);
  const branchRef = branchRefFromHead(head);
  const currentBranch = branchRef !== undefined ? shortBranchName(branchRef) : undefined;
  const config = await readRemoteConfig(ctx);
  const remoteName = defaultRemoteName(config, opts.remote, currentBranch);
  const request = refMapRequest(ctx, config, opts, { remoteName, currentBranch });
  // git's single-remote fetch asks `repo_has_promisor_remote` before it fetches.
  await warnSlashLeadingPromisorRemotes(ctx);
  const { url, filter } = await resolveRemoteUrl(ctx, remoteName);

  ctx.progress.start(FETCH_NEGOTIATE_OP);
  try {
    return await fetchViaSession(
      ctx,
      opts,
      { name: remoteName, request, forcedUpdates, updateHeadOk: internal.updateHeadOk === true },
      url,
      filter,
    );
  } finally {
    ctx.progress.end(FETCH_NEGOTIATE_OP);
  }
};

/** git's `fetch.showForcedUpdates` and the advice warning that it is off. */
interface ForcedUpdateCheck {
  readonly enabled: boolean;
  readonly advised: boolean;
}

/** The remote fetched from: its name, what maps its refs locally, and how updates are judged. */
interface FetchRemote {
  readonly name: string;
  readonly request: RefMapRequest;
  readonly forcedUpdates: ForcedUpdateCheck;
  readonly updateHeadOk: boolean;
}

const SHOW_FORCED_UPDATES = 'showForcedUpdates';
const FORCED_UPDATES_DISABLED = [
  'fetch normally indicates which branches had a forced update,',
  "but that check has been disabled; to re-enable, use '--show-forced-updates'",
  "flag or run 'git config fetch.showForcedUpdates true'",
].join('\n');

/** git's `git_fetch_config`: a value its boolean grammar refuses is fatal; valueless is on. */
const readForcedUpdateCheck = async (ctx: Context): Promise<ForcedUpdateCheck> => {
  await assertValidBooleanConfig(ctx, 'fetch', undefined, [SHOW_FORCED_UPDATES]);
  const [setting, advice] = await findLastEntries(ctx, [
    ['fetch', SHOW_FORCED_UPDATES],
    ['advice', 'fetchShowForcedUpdates'],
  ]);
  return { enabled: enabledByDefault(setting), advised: enabledByDefault(advice) };
};

const REFSPEC_REFUSAL = 'not a valid refspec';
const TAG_WORD = 'tag';
const TAG_NAME_MISSING = 'you need to specify a tag name';

/** git's fetch argv: the word `tag` and the name after it spell `refs/tags/<name>:refs/tags/<name>`. */
const expandTagWords = (specs: ReadonlyArray<string>): ReadonlyArray<string> => {
  const expanded: string[] = [];
  let tagNamePending = false;
  for (const spec of specs) {
    if (tagNamePending) expanded.push(`${TAGS_PREFIX}${spec}:${TAGS_PREFIX}${spec}`);
    else if (spec !== TAG_WORD) expanded.push(spec);
    tagNamePending = !tagNamePending && spec === TAG_WORD;
  }
  if (tagNamePending) throw invalidOption('refspecs', TAG_NAME_MISSING);
  return expanded;
};

/** git's `refspec_append` over the command line: an unusable spec is fatal. */
const assertFetchRefspecs = (specs: ReadonlyArray<string>): ReadonlyArray<string> => {
  const invalid = specs.find((spec) => !isValidFetchRefspec(spec));
  if (invalid !== undefined) throw refspecInvalid(invalid, REFSPEC_REFUSAL);
  return specs;
};

/** The remote a fetch reads and the branch checked out when it does. */
interface FetchTarget {
  readonly remoteName: string;
  readonly currentBranch: string | undefined;
}

const refMapRequest = (
  ctx: Context,
  config: ParsedConfig,
  opts: FetchOptions,
  { remoteName, currentBranch }: FetchTarget,
): RefMapRequest => {
  const branch = currentBranch === undefined ? undefined : config.branch?.get(currentBranch);
  const merge = branch?.remote !== undefined ? (branch.merges ?? []) : [];
  return {
    hashConfig: ctx.hashConfig,
    cliSpecs: assertFetchRefspecs(expandTagWords(opts.refspecs ?? [])),
    refmap: assertFetchRefspecs(opts.refmap ?? []),
    configSpecs: config.remote?.get(remoteName)?.fetch ?? [],
    merge,
    mergesFromRemote: branch?.remote === remoteName,
  };
};

const fetchViaSession = async (
  ctx: Context,
  opts: FetchOptions,
  remote: FetchRemote,
  url: string,
  filter: string | undefined,
): Promise<FetchResult> => {
  // git truncates FETCH_HEAD before it lists the remote's refs.
  await writeFetchHead(ctx, '');
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
  // A partial repo's fetch must re-apply its filter; the server must still
  // advertise the `filter` capability.
  if (filter !== undefined && !advertisesFilter(advertisement.capabilities)) {
    throw remoteFilterUnsupported();
  }

  const followTags = autoFollowsTags(remote.request);
  const capabilities = tagFollowingCapabilities(
    selectFetchCapabilities(advertisement.capabilities, ctx.hashConfig.algorithm),
    followTags && (discovery.version === 2 || advertisement.capabilities.includes(INCLUDE_TAG)),
  );
  const local = await localState(ctx, advertisement.refs);
  const warn = (message: string): void => ctx.logger?.warn?.(message);
  const mapped = getRefMap(remote.request, advertisement.refs, local, warn);
  const refMap = storableRefMap(ctx, mapped);
  if (!remote.updateHeadOk) await assertNoCheckedOutTarget(ctx, refMap);
  const wants = uniqueRefOids(refMap.map((entry) => entry.source));

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
    return applyRefsAndBuildResult(
      ctx,
      opts,
      remote,
      url,
      { refMap, advertisement, followTags },
      [],
      [],
    );
  }

  const haves = await deriveHaves(ctx);
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
    { refMap, advertisement, followTags },
    packResult.shallow,
    packResult.unshallow,
  );
};

/** git's `check_not_current_branch`: no refspec may write a branch a worktree holds. */
const assertNoCheckedOutTarget = async (
  ctx: Context,
  refMap: ReadonlyArray<MappedRef>,
): Promise<void> => {
  const held = await heldBranches(ctx);
  for (const { target } of refMap) {
    if (target?.startsWith(HEADS_PREFIX) !== true) continue;
    const path = held.get(target as RefName);
    if (path !== undefined) throw fetchIntoCheckedOutBranch(target as RefName, path);
  }
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
  fetched: FetchedMap,
  shallow: ReadonlyArray<ObjectId>,
  unshallow: ReadonlyArray<ObjectId>,
): Promise<FetchResult> => {
  const { request } = remote;
  const { refMap } = fetched;
  const pruneSpecs = request.cliSpecs.length > 0 ? request.cliSpecs : request.configSpecs;
  const prunedRefs = opts.prune === true ? await prune(ctx, pruneSpecs, refMap) : [];
  const updated = await applyRemoteRefs(ctx, remote, refMap);
  const backfill = fetched.followTags ? await backfillTags(ctx, fetched.advertisement) : [];
  // git's backfill is a second `store_updated_refs` round, made only when a tag needs it.
  const backfilled = backfill.length > 0 ? await applyRemoteRefs(ctx, remote, backfill) : [];
  const fetchHeadText = await fetchHeadContent(ctx, [refMap, backfill], fetchHeadUrl(url));
  await writeFetchHead(ctx, fetchHeadText);
  if (followsRemoteHead(request)) await setRemoteHead(ctx, remote.name, fetched.advertisement);
  const updatedRefs = [...updated, ...backfilled];

  return {
    remote: remote.name,
    url,
    updatedRefs,
    prunedRefs,
    shallow,
    unshallow,
  };
};

/** git sets the remote HEAD only on a fetch by the remote's own configured refspecs. */
const followsRemoteHead = ({ cliSpecs, configSpecs }: RefMapRequest): boolean =>
  cliSpecs.length === 0 && configSpecs.length > 0;

const setRemoteHead = async (
  ctx: Context,
  remote: string,
  advertisement: Advertisement,
): Promise<void> =>
  followRemoteHead(ctx, remote, advertisement, await readRemoteHeadPolicy(ctx, remote));

/** The ref map a fetch applies, and what its tag backfill reads. */
interface FetchedMap {
  readonly refMap: ReadonlyArray<MappedRef>;
  readonly advertisement: Advertisement;
  readonly followTags: boolean;
}

const INCLUDE_TAG = 'include-tag';

/** git asks for `include-tag` only when it follows tags. */
const tagFollowingCapabilities = (
  capabilities: ReadonlyArray<string>,
  includeTag: boolean,
): ReadonlyArray<string> => {
  const without = capabilities.filter((capability) => capability !== INCLUDE_TAG);
  return includeTag ? [INCLUDE_TAG, ...without] : without;
};

/** The local refs and symrefs, and which advertised tag objects and peeled commits are present. */
const localState = async (
  ctx: Context,
  refs: ReadonlyArray<AdvertisedRef>,
): Promise<LocalState> => {
  const listed = await getRefStore(ctx).listRefs(REFS_PREFIX as RefName);
  const names = new Set<string>(listed.map((entry) => entry.name));
  const symrefs = new Set<string>();
  for (const entry of listed) if (entry.value.kind === 'symbolic') symrefs.add(entry.name);
  return { refs: names, objects: await presentTagObjects(ctx, refs, names), symrefs };
};

/** The advertised tags' objects and peeled commits present locally, for tags not yet held. */
const presentTagObjects = async (
  ctx: Context,
  refs: ReadonlyArray<AdvertisedRef>,
  names: ReadonlySet<string>,
): Promise<ReadonlySet<ObjectId>> => {
  const objects = new Set<ObjectId>();
  for (const ref of refs) {
    if (!ref.name.startsWith(TAGS_PREFIX) || names.has(ref.name)) continue;
    for (const id of [ref.id, ref.peeled]) {
      if (id !== undefined && (await hasObject(ctx, id))) objects.add(id);
    }
  }
  return objects;
};

/**
 * git's `backfill_tags`: once the pack is in, the tags still missing whose
 * object arrived with it follow too. A tag whose own object is still absent
 * would need a second fetch git makes and tsgit does not.
 */
const backfillTags = async (
  ctx: Context,
  advertisement: Advertisement,
): Promise<ReadonlyArray<MappedRef>> => {
  // With no tag advertised, no tag can follow, and the local refs go unread.
  if (!advertisement.refs.some((ref) => ref.name.startsWith(TAGS_PREFIX))) return [];
  const local = await localState(ctx, advertisement.refs);
  const arrived = findNonLocalTags(advertisement.refs, [], local).filter((entry) =>
    local.objects.has(entry.source.id),
  );
  return storableRefMap(ctx, arrived);
};

/** Each round's FETCH_HEAD lines, in the order git appends them. */
const fetchHeadContent = async (
  ctx: Context,
  rounds: ReadonlyArray<ReadonlyArray<MappedRef>>,
  url: string,
): Promise<string> => {
  let content = '';
  for (const round of rounds) content += formatFetchHead(await fetchHeadEntries(ctx, round), url);
  return content;
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
 *  1. Read every ref tip under `refs/` (loose or packed), as git's
 *  negotiation seeds from `for_each_ref`. These tips ARE the first-class
 *  haves — the server uses them to filter the pack without their ancestors.
 *  2. Walk the commit graph from those tips (ignoring missing objects) and
 *  append the reachable commits in BFS order until `MAX_HAVES` is
 *  reached.
 *
 * A tip whose object is missing locally still gets sent as a have — the
 * server may ignore it, but if it happens to be the cut-point we want, this
 * keeps the negotiation honest.
 */
const deriveHaves = async (ctx: Context): Promise<ReadonlyArray<ObjectId>> => {
  const seeds = await collectRefTips(ctx);
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

const collectRefTips = async (ctx: Context): Promise<ReadonlyArray<ObjectId>> => {
  // `listRefs` already merges loose and packed storage, so repos that have
  // packed their refs (e.g. after `git gc`) contribute haves the same as an
  // unpacked one — without it, every fetch of a packed repo would send zero
  // haves and the server would resend a full pack.
  const entries = await getRefStore(ctx).listRefs(REFS_PREFIX as RefName);
  const ids: ObjectId[] = [];
  for (const entry of entries) {
    if (entry.value.kind === 'direct') ids.push(entry.value.id);
  }
  return ids;
};

/** The commit `id` names through its tags, or `undefined` when it names none or is absent. */
const commitOf = async (ctx: Context, id: ObjectId): Promise<ObjectId | undefined> => {
  try {
    return (await peelRefToCommit(ctx, id))?.commit.id;
  } catch (error) {
    if (errorDataCode(error) === 'OBJECT_NOT_FOUND') return undefined;
    throw error;
  }
};

/** git names a ref it stores by the remote ref's own namespace. */
const storingAction = (remoteRef: string): FetchReflogAction => {
  if (remoteRef.startsWith(TAGS_PREFIX)) return 'storing tag';
  if (remoteRef.startsWith(HEADS_PREFIX)) return 'storing head';
  return 'storing ref';
};

/** What git's `update_local_ref` does with one ref whose object changes. */
type Judgement =
  | { readonly kind: 'update'; readonly action: FetchReflogAction }
  | { readonly kind: 'reject'; readonly rejection: FetchRejection };

const updating = (action: FetchReflogAction): Judgement => ({ kind: 'update', action });
const rejecting = (rejection: FetchRejection): Judgement => ({ kind: 'reject', rejection });

/**
 * git's `update_local_ref` for an existing ref: a tag or a non-fast-forward
 * moves only under `+`; with `fetch.showForcedUpdates` off, every commit
 * update is taken for a fast-forward.
 */
const judgeUpdate = async (
  ctx: Context,
  { source, force }: MappedRef,
  name: RefName,
  oldId: ObjectId,
  checksAncestry: boolean,
): Promise<Judgement> => {
  if (name.startsWith(TAGS_PREFIX)) {
    return force ? updating('updating tag') : rejecting('would-clobber-existing-tag');
  }
  const current = await commitOf(ctx, oldId);
  const updated = await commitOf(ctx, source.id);
  if (current === undefined || updated === undefined) return updating(storingAction(source.name));
  if (!checksAncestry || (await isAncestor(ctx, current, updated))) return updating('fast-forward');
  return force ? updating('forced-update') : rejecting('non-fast-forward');
};

const storeUpdate = async (
  ctx: Context,
  remoteName: string,
  update: RefMove & { readonly oldId: ObjectId | undefined },
  action: FetchReflogAction,
): Promise<FetchUpdate> => {
  await updateRef(ctx, update.name, update.newId, {
    reflogMessage: fetchReflogMessage(remoteName, action),
  });
  return { ...update, status: 'ok' };
};

const applyRemoteRef = async (
  ctx: Context,
  remote: FetchRemote,
  entry: MappedRef,
  name: RefName,
): Promise<FetchUpdate> => {
  const newId = entry.source.id;
  const source = entry.source.name as RefName;
  const oldId = await readExistingRef(ctx, name);
  if (oldId === newId) return { name, source, oldId, newId, status: 'ok' };
  if (oldId === undefined) {
    return storeUpdate(ctx, remote.name, { name, source, oldId, newId }, storingAction(source));
  }
  const judgement = await judgeUpdate(ctx, entry, name, oldId, remote.forcedUpdates.enabled);
  if (judgement.kind === 'reject') {
    return { name, source, oldId, newId, status: 'rejected', rejection: judgement.rejection };
  }
  return storeUpdate(ctx, remote.name, { name, source, oldId, newId }, judgement.action);
};

/** One git `store_updated_refs` round, ending on its warning that the forced-update check is off. */
const applyRemoteRefs = async (
  ctx: Context,
  remote: FetchRemote,
  refMap: ReadonlyArray<MappedRef>,
): Promise<ReadonlyArray<FetchUpdate>> => {
  const updates: FetchUpdate[] = [];
  for (const entry of refMap) {
    if (entry.target === undefined) continue;
    updates.push(await applyRemoteRef(ctx, remote, entry, entry.target as RefName));
  }
  const { enabled, advised } = remote.forcedUpdates;
  if (!enabled && advised) ctx.logger?.warn?.(FORCED_UPDATES_DISABLED);
  return updates;
};

/**
 * git's `get_fetch_map` check: a local ref outside `refs/` or of a bad name is
 * ignored with an error — and never composed into a path, so a server's
 * `refs/heads/../../config` cannot reach a file outside the ref store.
 */
const storableRefMap = (ctx: Context, refMap: ReadonlyArray<MappedRef>): ReadonlyArray<MappedRef> =>
  refMap.filter(({ target }) => target === undefined || isStorableRef(ctx, target));

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
