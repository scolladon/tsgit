/**
 * `pull` command — fetch + integrate.
 *
 * Composes `fetch` (download objects + update remote-tracking refs) with
 * `merge` (integrate the fetched tip into HEAD). Integration is merge-only;
 * the `rebase` mode is added when rebase (Phase 22.3) lands.
 *
 * A pull that conflicts leaves the exact MERGE_HEAD / MERGE_MSG / ORIG_HEAD +
 * conflicted-index state a direct `merge` leaves, so `abortMerge` /
 * `continueMerge` resolve a pull-initiated conflict with no pull-specific code.
 */
import { noUpstreamConfigured } from '../../domain/commands/error.js';
import { type AuthorIdentity, RefName } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from '../primitives/config-read.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { type FetchResult, fetch } from './fetch.js';
import {
  assertNoPendingOperation,
  assertNotBare,
  assertRepository,
  readHeadRaw,
} from './internal/repo-state.js';
import { type MergeResult, merge } from './merge.js';

const HEADS_PREFIX = 'refs/heads/';

export interface PullOptions {
  /** Remote to pull from. Default: `branch.<current>.remote` ?? `'origin'`. */
  readonly remote?: string;
  /**
   * Short branch name to merge. Default: short form of `branch.<current>.merge`.
   * When neither is resolvable, pull throws `NO_UPSTREAM_CONFIGURED`.
   */
  readonly branch?: string;
  /** Reject the pull when a true merge would be required. */
  readonly fastForwardOnly?: boolean;
  /** Always create a merge commit, even when a fast-forward is possible. */
  readonly noFastForward?: boolean;
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

const shortBranchName = (ref: RefName): string =>
  ref.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : ref;

const shortMergeRef = (mergeRef: string | undefined): string | undefined => {
  if (mergeRef === undefined) return undefined;
  return mergeRef.startsWith(HEADS_PREFIX) ? mergeRef.slice(HEADS_PREFIX.length) : mergeRef;
};

interface Upstream {
  readonly remote: string;
  readonly branch: string;
}

const resolveUpstream = async (
  ctx: Context,
  currentBranch: string | undefined,
  opts: PullOptions,
  fallbackRef: RefName,
): Promise<Upstream> => {
  const config = await readConfig(ctx);
  const tracking = currentBranch !== undefined ? config.branch?.get(currentBranch) : undefined;
  const remote = opts.remote ?? tracking?.remote ?? 'origin';
  const branch = opts.branch ?? shortMergeRef(tracking?.merge);
  if (branch === undefined) {
    throw noUpstreamConfigured(fallbackRef);
  }
  return { remote, branch };
};

export const pull = async (ctx: Context, opts: PullOptions = {}): Promise<PullResult> => {
  await assertRepository(ctx);
  await assertNotBare(ctx, 'pull');
  await assertNoPendingOperation(ctx);

  const head = await readHeadRaw(ctx);
  const currentBranch = head.kind === 'symbolic' ? shortBranchName(head.target) : undefined;
  const fallbackRef = head.kind === 'symbolic' ? head.target : RefName.from('HEAD');
  const { remote, branch } = await resolveUpstream(ctx, currentBranch, opts, fallbackRef);

  const fetchResult = await fetch(ctx, {
    remote,
    ...(opts.prune !== undefined ? { prune: opts.prune } : {}),
    ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
  });

  const tip = await resolveRef(ctx, `refs/remotes/${remote}/${branch}` as RefName);

  const mergeResult = await merge(ctx, {
    target: tip,
    message: opts.message ?? `Merge branch '${branch}' of ${fetchResult.url}`,
    reflogLabel: 'pull',
    ...(opts.fastForwardOnly !== undefined ? { fastForwardOnly: opts.fastForwardOnly } : {}),
    ...(opts.noFastForward !== undefined ? { noFastForward: opts.noFastForward } : {}),
    ...(opts.author !== undefined ? { author: opts.author } : {}),
    ...(opts.committer !== undefined ? { committer: opts.committer } : {}),
  });

  return { fetch: fetchResult, merge: mergeResult };
};
