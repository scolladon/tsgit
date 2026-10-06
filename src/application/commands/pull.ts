/**
 * `pull` command — fetch + integrate.
 *
 * Composes `fetch` (download objects, update remote-tracking refs, write
 * `FETCH_HEAD`) with a `merge` of what `FETCH_HEAD` marks for merging, as git's
 * `pull` reads it back — or, when asked to rebase, a `rebase` of the current
 * branch onto the fetched head.
 *
 * A pull that conflicts leaves the exact MERGE_HEAD / MERGE_MSG / ORIG_HEAD +
 * conflicted-index state a direct `merge` leaves, so `merge.abort` /
 * `merge.continue` resolve a pull-initiated conflict with no pull-specific code.
 */
import {
  fastForwardMultipleBranches,
  fetchRejected,
  nonFastForward,
  noUpstreamConfigured,
  pullDivergentBranches,
  pullNoMergeCandidates,
  pullRebaseMultipleBranches,
} from '../../domain/commands/error.js';
import type { TsgitError } from '../../domain/error.js';
import { type AuthorIdentity, type ObjectId, RefName } from '../../domain/objects/index.js';
import { shortBranchName } from '../../domain/refs/short-branch-name.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from '../primitives/config-read.js';
import { assertNoValuelessConfig } from '../primitives/internal/valueless-config-guard.js';
import { materializeTree } from '../primitives/materialize-tree.js';
import { inMergeBases, mergeBasesOf, reduceHeads } from '../primitives/merge-base.js';
import { readIndex } from '../primitives/read-index.js';
import { loadSparseMatcher } from '../primitives/read-sparse-checkout.js';
import { resolveRef, resolveRefOrMissing } from '../primitives/resolve-ref.js';
import { type FetchResult, type FetchUpdate, fetchWith } from './fetch.js';
import { configuredAutostash } from './internal/autostash-config.js';
import { assertCleanWorkTree } from './internal/clean-work-tree.js';
import { defaultRemoteName } from './internal/default-remote.js';
import { configuredPullFastForward } from './internal/fast-forward-config.js';
import { type FetchHeadLine, readFetchHead } from './internal/fetch-head.js';
import { forkPoint } from './internal/fork-point.js';
import { treeOf } from './internal/history-rewrite.js';
import { acquireIndexLock } from './internal/index-update.js';
import { configuredPullRebase } from './internal/pull-rebase-config.js';
import { refspecTrackingRef, upstreamTrackingRef } from './internal/pull-tracking-ref.js';
import { buildRemoteTable } from './internal/remote-config.js';
import {
  assertNoPendingOperation,
  assertOperationalRepository,
  branchRefFromHead,
  readHeadRaw,
  requireWorkTree,
} from './internal/repo-state.js';
import { type MergeInternalOptions, type MergeResult, mergeRun } from './merge.js';
import { type RebaseResult, rebaseRun } from './rebase.js';

export interface PullOptions {
  /**
   * Remote to pull from. Default: `branch.<current>.remote` ?? the sole
   * configured remote ?? `'origin'`.
   */
  readonly remote?: string;
  /**
   * Refspec to fetch and merge — git's `git pull <remote> <ref>`. Default:
   * what the fetch marks for merging, i.e. `branch.<current>.merge` when
   * `branch.<current>.remote` names the remote. When nothing is marked, pull
   * throws `NO_UPSTREAM_CONFIGURED` or `PULL_NO_MERGE_CANDIDATES` after the
   * fetch, as git does.
   */
  readonly ref?: string;
  /**
   * Fast-forward policy for the integrate step, forwarded to `merge` (git
   * `--ff` / `--ff-only` / `--no-ff`). Unset, it is `pull.ff`'s — where `only`
   * reads as `'allow'`, as under git's `--no-rebase` — else the merge's own
   * `merge.ff`, else `'allow'`; an invalid `pull.ff` refuses before the fetch:
   * - `'allow'` — fast-forward when possible, else a true merge.
   * - `'only'` — reject when a true merge would be required.
   * - `'never'` — always create a merge commit, even when a fast-forward is possible.
   */
  readonly fastForward?: 'only' | 'never' | 'allow';
  /**
   * git's `--rebase` (`true`), `--rebase=merges` (`'merges'`) and
   * `--no-rebase` (`false`): rebase the current branch onto the fetched head
   * instead of merging it. A fast-forwardable head still fast-forwards, through
   * the merge, as git does; `fastForward: 'only'` wins over a rebase.
   */
  readonly rebase?: boolean | 'merges';
  /**
   * git's `--autostash` / `--no-autostash`: stash a dirty tree before the
   * integrate step and re-apply it afterwards. Unset, it is `pull.autostash`'s;
   * a rebasing pull then falls back to `rebase.autostash`, a merging one leaves
   * it to the merge's own `merge.autostash`. A rebasing pull without it refuses
   * a dirty tree.
   */
  readonly autostash?: boolean;
  /**
   * git's `--allow-unrelated-histories`, forwarded to `merge`: integrate a
   * head that shares no commit with `HEAD` instead of refusing with
   * `UNRELATED_HISTORIES`.
   */
  readonly allowUnrelatedHistories?: boolean;
  /** Prune deleted remote-tracking refs during the fetch step. */
  readonly prune?: boolean;
  /** Shallow fetch depth, forwarded to fetch. */
  readonly depth?: number;
  /** Override the generated merge commit message / MERGE_MSG. */
  readonly message?: string;
  /**
   * git's `--log[=<n>]` / `--no-log`, forwarded to `merge`: the shortlog its
   * message carries. Unset, it is the merge's own `merge.log`.
   */
  readonly log?: boolean | number;
  /** git's `--squash`, forwarded to `merge`: stage the merge and write `SQUASH_MSG`, HEAD unmoved. */
  readonly squash?: boolean;
  /** git's `--commit` / `--no-commit`, forwarded to `merge`: `false` stops before the merge commit. */
  readonly commit?: boolean;
  /** git's `-s <strategy>`, once or several times, forwarded to `merge`. */
  readonly strategy?: string | ReadonlyArray<string>;
  /** Identity for the merge commit (true-merge path only). */
  readonly author?: AuthorIdentity;
  readonly committer?: AuthorIdentity;
}

/** How the fetched head was integrated: merged (fast-forward included), or rebased onto. */
export type PullResult =
  | { readonly fetch: FetchResult; readonly integration: 'merge'; readonly merge: MergeResult }
  | { readonly fetch: FetchResult; readonly integration: 'rebase'; readonly rebase: RebaseResult };

interface Upstream {
  readonly remote: string;
  /** `branch.<current>.remote`, when configured. */
  readonly configuredRemote: string | undefined;
  /** `branch.<current>.merge`, which git ignores without a `branch.<current>.remote`. */
  readonly merge: string | undefined;
  /** git's `get_upstream_branch`: the ref the remote's fetch refspecs store `merge` in. */
  readonly trackingRef: RefName | undefined;
}

const readUpstream = async (
  ctx: Context,
  currentBranch: string | undefined,
  opts: PullOptions,
): Promise<Upstream> => {
  await buildRemoteTable(ctx);
  const config = await readConfig(ctx);
  if (currentBranch !== undefined) {
    await assertNoValuelessConfig(ctx, 'branch', currentBranch, ['remote', 'merge']);
  }
  const tracking = currentBranch !== undefined ? config.branch?.get(currentBranch) : undefined;
  const remote = defaultRemoteName(config, opts.remote, currentBranch);
  const merge = tracking?.remote !== undefined ? tracking.merge : undefined;
  const ownRemote = tracking?.remote === remote && merge !== undefined;
  return {
    remote,
    configuredRemote: tracking?.remote,
    merge,
    trackingRef: ownRemote
      ? upstreamTrackingRef(remote, merge, config.remote?.get(remote)?.fetch)
      : undefined,
  };
};

/** git's `die_no_merge_candidates`, in its order of diagnosis. */
const noMergeCandidates = (
  opts: PullOptions,
  upstream: Upstream,
  branchRef: RefName | undefined,
): TsgitError => {
  if (opts.ref !== undefined) return pullNoMergeCandidates('refspec-unmatched', upstream.remote);
  const elsewhere = opts.remote !== undefined && opts.remote !== upstream.configuredRemote;
  if (branchRef !== undefined && elsewhere) {
    return pullNoMergeCandidates('not-default-remote', upstream.remote);
  }
  if (upstream.merge === undefined) return noUpstreamConfigured(branchRef ?? RefName.from('HEAD'));
  return pullNoMergeCandidates('merge-ref-not-fetched', upstream.remote, upstream.merge);
};

/** git's `handle_fetch_head`: every for-merge FETCH_HEAD line, in order. */
const mergeHeads = async (
  ctx: Context,
  opts: PullOptions,
  upstream: Upstream,
  branchRef: RefName | undefined,
): Promise<ReadonlyArray<FetchHeadLine>> => {
  const heads = (await readFetchHead(ctx)).filter((line) => line.forMerge);
  if (heads.length === 0) throw noMergeCandidates(opts, upstream, branchRef);
  return heads;
};

type RejectedUpdate = Extract<FetchUpdate, { readonly status: 'rejected' }>;

const isRejected = (update: FetchUpdate): update is RejectedUpdate => update.status === 'rejected';

/** git's pull stops when its fetch exits 1 on a rejected ref update. */
const assertNothingRejected = ({ remote, updatedRefs }: FetchResult): void => {
  const rejected = updatedRefs
    .filter(isRejected)
    .map(({ name, oldId, newId, rejection }) => ({ name, oldId, newId, rejection }));
  if (rejected.length > 0) throw fetchRejected(remote, rejected);
};

/** git's pull `divergent`: `HEAD` neither fast-forwards to the head nor already contains it. */
const divergent = async (ctx: Context, ours: ObjectId, theirs: ObjectId): Promise<boolean> =>
  !(await inMergeBases(ctx, ours, theirs)) && !(await inMergeBases(ctx, theirs, ours));

/** git's pull refuses `--ff-only` over several heads, or a divergent one, before it merges anything. */
const assertFastForwardable = async (
  ctx: Context,
  opts: PullOptions,
  branchRef: RefName | undefined,
  heads: ReadonlyArray<FetchHeadLine>,
): Promise<void> => {
  if (opts.fastForward !== 'only') return;
  if (heads.length > 1) throw fastForwardMultipleBranches();
  const ours = await resolveRef(ctx, RefName.from('HEAD'));
  const theirs = heads[0]!.id;
  if (await divergent(ctx, ours, theirs)) {
    throw nonFastForward(branchRef ?? RefName.from('HEAD'), ours, theirs);
  }
};

/**
 * git's `config_get_ff`: an unset policy takes `pull.ff`, else leaves `merge.ff`
 * to the merge — a configured `only` reading as a plain fast-forward-or-merge
 * once the caller chose whether to rebase.
 */
const settleFastForward = async (ctx: Context, opts: PullOptions): Promise<PullOptions> => {
  if (opts.fastForward !== undefined) return opts;
  const configured = await configuredPullFastForward(ctx);
  if (configured === undefined) return opts;
  const chosen = configured === 'only' && opts.rebase !== undefined ? 'allow' : configured;
  return { ...opts, fastForward: chosen };
};

/**
 * git's `config_get_rebase`: an unset choice takes `branch.<current>.rebase`,
 * else `pull.rebase`; `unreconciled` when neither says, for the divergence refusal.
 */
const settleRebase = async (
  ctx: Context,
  opts: PullOptions,
  currentBranch: string | undefined,
): Promise<{ readonly opts: PullOptions; readonly unreconciled: boolean }> => {
  if (opts.rebase !== undefined) return { opts, unreconciled: false };
  const configured = await configuredPullRebase(ctx, currentBranch);
  if (configured === undefined) return { opts, unreconciled: true };
  return { opts: { ...opts, rebase: configured }, unreconciled: false };
};

/** A rebasing pull of a born HEAD, with the fork point found before the fetch. */
interface RebasePlan {
  readonly fork: ObjectId | undefined;
  /** `--rebase=merges`: the rebase recreates local merges. */
  readonly rebaseMerges: boolean;
  /** The dirty tree is stashed around the rebase instead of refused. */
  readonly autostash: boolean;
}

/** git pull's `opt_rebase` truthiness: `true` and `'merges'` rebase. */
const rebasing = (opts: PullOptions): boolean => opts.rebase !== undefined && opts.rebase !== false;

/**
 * git pull's `opt_autostash`: the caller's, else `pull.autostash`; a rebasing
 * pull falls back to `rebase.autostash`. git reads both keys on every pull, so
 * an invalid value refuses either way.
 */
const settleAutostash = async (ctx: Context, opts: PullOptions): Promise<PullOptions> => {
  const configured = await configuredAutostash(ctx, 'pull');
  const rebased = await configuredAutostash(ctx, 'rebase');
  const pulled = opts.autostash ?? configured;
  const chosen = rebasing(opts) ? (pulled ?? rebased ?? false) : pulled;
  return chosen === undefined ? opts : { ...opts, autostash: chosen };
};

/**
 * git's pre-fetch rebase preparation: refuse a dirty tree (`require_clean_work_tree`)
 * unless autostash is on, then find the fork point of the current branch
 * from the upstream the fetch is about to update. An unborn HEAD is pulled into,
 * never rebased.
 */
const planRebase = async (
  ctx: Context,
  opts: PullOptions,
  upstream: Upstream,
  branchRef: RefName | undefined,
): Promise<RebasePlan | undefined> => {
  const head = rebasing(opts) ? await resolveRefOrMissing(ctx, 'HEAD') : undefined;
  if (head === undefined) return undefined;
  const autostash = opts.autostash === true;
  if (!autostash) await assertCleanWorkTree(ctx, await treeOf(ctx, head));
  const tracking =
    opts.ref !== undefined ? refspecTrackingRef(upstream.remote, opts.ref) : upstream.trackingRef;
  const shape = { rebaseMerges: opts.rebase === 'merges', autostash };
  if (branchRef === undefined || tracking === undefined) return { fork: undefined, ...shape };
  return { fork: await forkPoint(ctx, tracking, head), ...shape };
};

/**
 * git's `get_rebase_newbase_and_upstream`: rebase from the fork point unless it
 * is already the octopus merge base of HEAD, the fetched head and itself.
 */
const rebaseUpstream = async (
  ctx: Context,
  head: ObjectId,
  theirs: ObjectId,
  fork: ObjectId | undefined,
): Promise<ObjectId> => {
  if (fork === undefined) return theirs;
  const bases = await reduceHeads(
    ctx,
    await mergeBasesOf(ctx, [head, theirs, fork], { octopus: true }),
  );
  return bases[0] === fork ? theirs : fork;
};

/** git's `get_can_ff`: one head, and it descends from HEAD. */
const canFastForward = async (
  ctx: Context,
  heads: ReadonlyArray<FetchHeadLine>,
): Promise<boolean> =>
  heads.length === 1 &&
  inMergeBases(ctx, await resolveRef(ctx, RefName.from('HEAD')), heads[0]!.id);

export const pull = async (ctx: Context, given: PullOptions = {}): Promise<PullResult> => {
  await assertOperationalRepository(ctx);
  requireWorkTree(ctx, 'pull');
  const settled = await settleFastForward(ctx, given);
  await assertNoPendingOperation(ctx);

  const branchRef = branchRefFromHead(await readHeadRaw(ctx));
  const currentBranch = branchRef !== undefined ? shortBranchName(branchRef) : undefined;
  const upstream = await readUpstream(ctx, currentBranch, settled);
  const reconciled = await settleRebase(ctx, settled, currentBranch);
  const opts = await settleAutostash(ctx, reconciled.opts);
  const unreconciled = reconciled.unreconciled;
  const rebase = await planRebase(ctx, opts, upstream, branchRef);
  const origHead = await resolveRefOrMissing(ctx, 'HEAD');
  const fetchResult = await fetchUpstream(ctx, opts, upstream);
  assertNothingRejected(fetchResult);
  await followUpdatedHead(ctx, origHead);
  const fetched = await mergeHeads(ctx, opts, upstream, branchRef);
  return integrate(ctx, { opts, branchRef, fetchResult, fetched, rebase, unreconciled });
};

const fetchUpstream = (ctx: Context, opts: PullOptions, upstream: Upstream): Promise<FetchResult> =>
  fetchWith(
    ctx,
    {
      remote: upstream.remote,
      ...(opts.ref !== undefined ? { refspecs: [opts.ref] } : {}),
      // Stryker disable next-line ConditionalExpression: equivalent — the always-true mutant forwards `{ prune: opts.prune }` with `prune: undefined`, which `fetch` reads as `=== true` (false) — identical to omitting the key. The drop direction + the `!==` flip are killed by the prune-forwarding test.
      ...(opts.prune !== undefined ? { prune: opts.prune } : {}),
      // Stryker disable next-line ConditionalExpression: equivalent — the always-true mutant forwards `{ depth: opts.depth }` with `depth: undefined`, which `fetchPack` gates on `!== undefined` — identical to omitting the key. The drop direction + the `!==` flip are killed by the depth-forwarding test.
      ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
    },
    PULL_FETCH,
  );

// git pull runs its fetch with `--update-head-ok`.
const PULL_FETCH = { updateHeadOk: true } as const;

/**
 * git pull after a fetch that moved HEAD's own branch: the index and working
 * tree still hold the old commit, so fast-forward them to the new one. An
 * unborn HEAD has nothing checked out to follow.
 */
const followUpdatedHead = async (ctx: Context, origHead: ObjectId | undefined): Promise<void> => {
  if (origHead === undefined) return;
  const currHead = await resolveRef(ctx, RefName.from('HEAD'));
  if (currHead === origHead) return;
  ctx.logger?.warn?.(
    `fetch updated the current branch head.\nfast-forwarding your working tree from\ncommit ${origHead}.`,
  );
  await fastForwardWorkTree(ctx, currHead);
};

/** git's `checkout_fast_forward`: a two-way checkout keeping local changes and
 *  refusing those it would overwrite. */
const fastForwardWorkTree = async (ctx: Context, target: ObjectId): Promise<void> => {
  const lock = await acquireIndexLock(ctx);
  try {
    const matcher = await loadSparseMatcher(ctx);
    const result = await materializeTree(ctx, {
      targetTree: await treeOf(ctx, target),
      currentIndex: await readIndex(ctx),
      force: false,
      ...(matcher !== undefined ? { sparse: matcher } : {}),
    });
    await lock.commit(result.newIndexEntries);
  } finally {
    await lock.release();
  }
};

interface Integration {
  readonly opts: PullOptions;
  readonly branchRef: RefName | undefined;
  readonly fetchResult: FetchResult;
  readonly fetched: ReadonlyArray<FetchHeadLine>;
  readonly rebase: RebasePlan | undefined;
  /** No rebase choice was given or configured. */
  readonly unreconciled: boolean;
}

/** git's `already_up_to_date`: HEAD descends from every fetched head. */
const alreadyUpToDate = async (
  ctx: Context,
  head: ObjectId,
  heads: ReadonlyArray<FetchHeadLine>,
): Promise<boolean> => {
  for (const line of heads) if (!(await inMergeBases(ctx, line.id, head))) return false;
  return true;
};

/** git pull refuses a divergence nothing said how to reconcile; an unborn HEAD is pulled into. */
const assertReconcilable = async (
  ctx: Context,
  heads: ReadonlyArray<FetchHeadLine>,
): Promise<void> => {
  const head = await resolveRefOrMissing(ctx, 'HEAD');
  if (head === undefined || (await canFastForward(ctx, heads))) return;
  if (!(await alreadyUpToDate(ctx, head, heads))) throw pullDivergentBranches();
};

/**
 * git pull's integrate step: fast-forward-only wins over a rebase; a rebasing
 * pull fast-forwards through the merge when it can, else rebases.
 */
const integrate = async (ctx: Context, run: Integration): Promise<PullResult> => {
  const { opts, fetched, fetchResult, rebase } = run;
  if (rebase !== undefined && fetched.length > 1) throw pullRebaseMultipleBranches();
  await assertFastForwardable(ctx, opts, run.branchRef, fetched);
  if (run.unreconciled && opts.fastForward === undefined) await assertReconcilable(ctx, fetched);
  if (rebase === undefined || opts.fastForward === 'only') {
    return integrateByMerge(ctx, fetchResult, fetched, opts);
  }
  if (await canFastForward(ctx, fetched)) {
    return integrateByMerge(ctx, fetchResult, fetched, { ...opts, fastForward: 'only' });
  }
  const result = await rebaseOnto(ctx, fetched[0]!.id, rebase);
  return { fetch: fetchResult, integration: 'rebase', rebase: result };
};

/** git's `run_rebase`: `rebase --onto <fetched head> <upstream>` under pull's reflog action. */
const rebaseOnto = async (
  ctx: Context,
  theirs: ObjectId,
  { fork, rebaseMerges, autostash }: RebasePlan,
): Promise<RebaseResult> => {
  const head = await resolveRef(ctx, RefName.from('HEAD'));
  const upstream = await rebaseUpstream(ctx, head, theirs, fork);
  return rebaseRun(
    ctx,
    { upstream, onto: theirs, rebaseMerges, autostash },
    { reflogAction: PULL_REFLOG_ACTION },
  );
};

// git sets GIT_REFLOG_ACTION=pull for the integrate step; this is its analogue.
const PULL_REFLOG_ACTION = 'pull';

/** git's `run_merge` of every fetched head. */
const integrateByMerge = async (
  ctx: Context,
  fetchResult: FetchResult,
  fetched: ReadonlyArray<FetchHeadLine>,
  opts: PullOptions,
): Promise<PullResult> => {
  const mergeInternal: MergeInternalOptions = { reflogAction: PULL_REFLOG_ACTION, heads: fetched };
  const mergeResult = await mergeRun(
    ctx,
    {
      rev: fetched.map((line) => line.id),
      allowUnrelatedHistories: opts.allowUnrelatedHistories === true,
      // git passes `--autostash` / `--no-autostash` only when pull settled one.
      ...(opts.autostash !== undefined ? { autostash: opts.autostash } : {}),
      ...(opts.message !== undefined ? { message: opts.message } : {}),
      ...(opts.log !== undefined ? { log: opts.log } : {}),
      ...(opts.squash !== undefined ? { squash: opts.squash } : {}),
      ...(opts.commit !== undefined ? { commit: opts.commit } : {}),
      ...(opts.strategy !== undefined ? { strategy: opts.strategy } : {}),
      // Stryker disable next-line ConditionalExpression: equivalent — the always-true mutant forwards `{ fastForward: undefined }`, which `merge` reads as `!== 'never'` (so a fast-forward proceeds) and `=== 'only'` (false) — identical to omitting it. The drop direction + the `!==` flip are killed by the fastForward-forwarding tests.
      ...(opts.fastForward !== undefined ? { fastForward: opts.fastForward } : {}),
      // Stryker disable next-line ConditionalExpression: equivalent — the always-true mutant forwards `{ author: undefined }`, which `merge` resolves as `opts.author ?? config` — identical to omitting it. The drop direction + the `!==` flip are killed by the author-bearing merge tests.
      ...(opts.author !== undefined ? { author: opts.author } : {}),
      // Stryker disable next-line ConditionalExpression: equivalent — the always-true mutant forwards `{ committer: undefined }`, which `merge` resolves as `opts.committer ?? author` — identical to omitting it. The drop direction + the `!==` flip are killed by the committer-forwarding test.
      ...(opts.committer !== undefined ? { committer: opts.committer } : {}),
    },
    mergeInternal,
  );

  return { fetch: fetchResult, integration: 'merge', merge: mergeResult };
};
