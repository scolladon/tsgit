/**
 * `pull` command — fetch + integrate.
 *
 * Composes `fetch` (download objects, update remote-tracking refs, write
 * `FETCH_HEAD`) with `merge` of what `FETCH_HEAD` marks for merging, as git's
 * `pull` reads it back. Integration is merge-only: there is no `rebase` mode.
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
  pullNoMergeCandidates,
} from '../../domain/commands/error.js';
import type { TsgitError } from '../../domain/error.js';
import { type AuthorIdentity, type ObjectId, RefName } from '../../domain/objects/index.js';
import { shortBranchName } from '../../domain/refs/short-branch-name.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from '../primitives/config-read.js';
import { assertNoValuelessConfig } from '../primitives/internal/valueless-config-guard.js';
import { inMergeBases } from '../primitives/merge-base.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { type FetchResult, type FetchUpdate, fetch } from './fetch.js';
import { defaultRemoteName } from './internal/default-remote.js';
import { configuredPullFastForward } from './internal/fast-forward-config.js';
import { type FetchHeadLine, readFetchHead } from './internal/fetch-head.js';
import { buildRemoteTable } from './internal/remote-config.js';
import {
  assertNoPendingOperation,
  assertOperationalRepository,
  branchRefFromHead,
  readHeadRaw,
  requireWorkTree,
} from './internal/repo-state.js';
import { type MergeInternalOptions, type MergeResult, mergeRun } from './merge.js';

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
  /** Identity for the merge commit (true-merge path only). */
  readonly author?: AuthorIdentity;
  readonly committer?: AuthorIdentity;
}

export interface PullResult {
  readonly fetch: FetchResult;
  readonly merge: MergeResult;
}

interface Upstream {
  readonly remote: string;
  /** `branch.<current>.remote`, when configured. */
  readonly configuredRemote: string | undefined;
  /** `branch.<current>.merge`, which git ignores without a `branch.<current>.remote`. */
  readonly merge: string | undefined;
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
  return {
    remote: defaultRemoteName(config, opts.remote, currentBranch),
    configuredRemote: tracking?.remote,
    merge: tracking?.remote !== undefined ? tracking.merge : undefined,
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

/** git's `config_get_ff`: an unset policy takes `pull.ff`, else leaves `merge.ff` to the merge. */
const settleFastForward = async (ctx: Context, opts: PullOptions): Promise<PullOptions> => {
  if (opts.fastForward !== undefined) return opts;
  const configured = await configuredPullFastForward(ctx);
  return configured === undefined ? opts : { ...opts, fastForward: configured };
};

export const pull = async (ctx: Context, given: PullOptions = {}): Promise<PullResult> => {
  await assertOperationalRepository(ctx);
  requireWorkTree(ctx, 'pull');
  const opts = await settleFastForward(ctx, given);
  await assertNoPendingOperation(ctx);

  const head = await readHeadRaw(ctx);
  const branchRef = branchRefFromHead(head);
  const currentBranch = branchRef !== undefined ? shortBranchName(branchRef) : undefined;
  const upstream = await readUpstream(ctx, currentBranch, opts);

  const fetchResult = await fetch(ctx, {
    remote: upstream.remote,
    ...(opts.ref !== undefined ? { refspecs: [opts.ref] } : {}),
    // Stryker disable next-line ConditionalExpression: equivalent — the always-true mutant forwards `{ prune: opts.prune }` with `prune: undefined`, which `fetch` reads as `=== true` (false) — identical to omitting the key. The drop direction + the `!==` flip are killed by the prune-forwarding test.
    ...(opts.prune !== undefined ? { prune: opts.prune } : {}),
    // Stryker disable next-line ConditionalExpression: equivalent — the always-true mutant forwards `{ depth: opts.depth }` with `depth: undefined`, which `fetchPack` gates on `!== undefined` — identical to omitting the key. The drop direction + the `!==` flip are killed by the depth-forwarding test.
    ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
  });

  assertNothingRejected(fetchResult);
  const fetched = await mergeHeads(ctx, opts, upstream, branchRef);
  await assertFastForwardable(ctx, opts, branchRef, fetched);

  // git sets GIT_REFLOG_ACTION=pull for the integrate step; this is its analogue.
  const mergeInternal: MergeInternalOptions = { reflogAction: 'pull', heads: fetched };
  const mergeResult = await mergeRun(
    ctx,
    {
      rev: fetched.map((line) => line.id),
      allowUnrelatedHistories: opts.allowUnrelatedHistories === true,
      ...(opts.message !== undefined ? { message: opts.message } : {}),
      // Stryker disable next-line ConditionalExpression: equivalent — the always-true mutant forwards `{ fastForward: undefined }`, which `merge` reads as `!== 'never'` (so a fast-forward proceeds) and `=== 'only'` (false) — identical to omitting it. The drop direction + the `!==` flip are killed by the fastForward-forwarding tests.
      ...(opts.fastForward !== undefined ? { fastForward: opts.fastForward } : {}),
      // Stryker disable next-line ConditionalExpression: equivalent — the always-true mutant forwards `{ author: undefined }`, which `merge` resolves as `opts.author ?? config` — identical to omitting it. The drop direction + the `!==` flip are killed by the author-bearing merge tests.
      ...(opts.author !== undefined ? { author: opts.author } : {}),
      // Stryker disable next-line ConditionalExpression: equivalent — the always-true mutant forwards `{ committer: undefined }`, which `merge` resolves as `opts.committer ?? author` — identical to omitting it. The drop direction + the `!==` flip are killed by the committer-forwarding test.
      ...(opts.committer !== undefined ? { committer: opts.committer } : {}),
    },
    mergeInternal,
  );

  return { fetch: fetchResult, merge: mergeResult };
};
