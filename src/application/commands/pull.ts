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
  /**
   * Fast-forward policy for the integrate step, forwarded to `merge` (git
   * `--ff` / `--ff-only` / `--no-ff`):
   * - `'allow'` (default) — fast-forward when possible, else a true merge.
   * - `'only'` — reject when a true merge would be required.
   * - `'never'` — always create a merge commit, even when a fast-forward is possible.
   */
  readonly fastForward?: 'only' | 'never' | 'allow';
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
    // Stryker disable next-line ConditionalExpression: equivalent — the always-true mutant forwards `{ prune: opts.prune }` with `prune: undefined`, which `fetch` reads as `=== true` (false) — identical to omitting the key. The drop direction + the `!==` flip are killed by the prune-forwarding test.
    ...(opts.prune !== undefined ? { prune: opts.prune } : {}),
    // Stryker disable next-line ConditionalExpression: equivalent — the always-true mutant forwards `{ depth: opts.depth }` with `depth: undefined`, which `fetchPack` gates on `!== undefined` — identical to omitting the key. The drop direction + the `!==` flip are killed by the depth-forwarding test.
    ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
  });

  const tip = await resolveRef(ctx, `refs/remotes/${remote}/${branch}` as RefName);

  const mergeResult = await merge(ctx, {
    target: tip,
    message: opts.message ?? `Merge branch '${branch}' of ${fetchResult.url}`,
    reflogLabel: 'pull',
    // Stryker disable next-line ConditionalExpression: equivalent — the always-true mutant forwards `{ fastForward: undefined }`, which `merge` reads as `!== 'never'` (so a fast-forward proceeds) and `=== 'only'` (false) — identical to omitting it. The drop direction + the `!==` flip are killed by the fastForward-forwarding tests.
    ...(opts.fastForward !== undefined ? { fastForward: opts.fastForward } : {}),
    // Stryker disable next-line ConditionalExpression: equivalent — the always-true mutant forwards `{ author: undefined }`, which `merge` resolves as `opts.author ?? config` — identical to omitting it. The drop direction + the `!==` flip are killed by the author-bearing merge tests.
    ...(opts.author !== undefined ? { author: opts.author } : {}),
    // Stryker disable next-line ConditionalExpression: equivalent — the always-true mutant forwards `{ committer: undefined }`, which `merge` resolves as `opts.committer ?? author` — identical to omitting it. The drop direction + the `!==` flip are killed by the committer-forwarding test.
    ...(opts.committer !== undefined ? { committer: opts.committer } : {}),
  });

  return { fetch: fetchResult, merge: mergeResult };
};
