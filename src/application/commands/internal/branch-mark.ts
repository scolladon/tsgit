/**
 * git's `interpret_branch_mark`: `<branch>@{upstream}` (`@{u}`) names the ref
 * `branch_get_upstream` reads for the branch, `<branch>@{push}` the one
 * `branch_get_push` does; an empty branch, `HEAD` or `@` is the current one.
 */
import { branchMarkUnresolved } from '../../../domain/commands/error.js';
import type { RefName } from '../../../domain/objects/index.js';
import { type BranchMark, findBranchMark } from '../../../domain/refs/branch-mark.js';
import { HEADS_PREFIX } from '../../../domain/refs/ref-prefixes.js';
import { shortBranchName } from '../../../domain/refs/short-branch-name.js';
import type { Context } from '../../../ports/context.js';
import { type ParsedConfig, readConfig } from '../../primitives/config-read.js';
import { currentBranchRef } from '../../primitives/internal/repo-state.js';
import { refResolvesForReading } from '../../primitives/resolve-ref.js';
import { resolvePushRemote } from './default-remote.js';
import { expandPriorCheckout } from './prior-checkout.js';
import { upstreamTrackingRef } from './pull-tracking-ref.js';
import { findTrackingRef } from './remote-tracking-ref.js';
import { shortenUnambiguousRef } from './shorten-ref.js';

const MARK_OPENER = '@{';
const UNEXPANDED_PRIOR_CHECKOUT = '@{-';
const CURRENT_BRANCH_SPELLINGS: ReadonlySet<string> = new Set(['', 'HEAD', '@']);

/** git's `branch_get`: the named branch, or HEAD's — none when HEAD is detached. */
const markedBranch = async (ctx: Context, mark: BranchMark): Promise<string> => {
  if (!CURRENT_BRANCH_SPELLINGS.has(mark.branch)) return mark.branch;
  const current = await currentBranchRef(ctx);
  if (current === undefined) throw branchMarkUnresolved({ reason: 'detached-head' });
  return shortBranchName(current);
};

/** git's `branch_get_upstream`: the ref `branch.<b>.merge` lands in through the remote's fetch refspecs. */
const upstreamRef = async (ctx: Context, config: ParsedConfig, branch: string): Promise<string> => {
  const entry = config.branch?.get(branch);
  if (entry?.remote === undefined || entry.merge === undefined) {
    const exists = await refResolvesForReading(ctx, `${HEADS_PREFIX}${branch}` as RefName);
    throw branchMarkUnresolved(
      exists ? { reason: 'no-upstream', branch } : { reason: 'no-such-branch', branch },
    );
  }
  const fetchSpecs = config.remote?.get(entry.remote)?.fetch;
  const tracked = upstreamTrackingRef(entry.remote, entry.merge, fetchSpecs);
  if (tracked === undefined) {
    throw branchMarkUnresolved({ reason: 'upstream-not-tracked', upstream: entry.merge });
  }
  return tracked;
};

/** git's `tracking_for_push_dest`: where the remote's fetch refspecs store `destination`. */
const trackingForPushDest = (config: ParsedConfig, remote: string, destination: string): string => {
  const tracked = findTrackingRef(config.remote?.get(remote)?.fetch ?? [], destination);
  if (tracked === undefined) {
    throw branchMarkUnresolved({ reason: 'push-destination-untracked', destination, remote });
  }
  return tracked;
};

/** git's `simple` (and unset) `push.default`: the upstream, when it is where `current` would push. */
const simplePushRef = async (
  ctx: Context,
  config: ParsedConfig,
  remote: string,
  branch: string,
): Promise<string> => {
  const upstream = await upstreamRef(ctx, config, branch);
  const current = trackingForPushDest(config, remote, `${HEADS_PREFIX}${branch}`);
  if (current !== upstream) throw branchMarkUnresolved({ reason: 'simple-push-ambiguous' });
  return current;
};

/** git's `branch_get_push_1` once the remote has no push refspecs: by `push.default`. */
const pushDefaultRef = (
  ctx: Context,
  config: ParsedConfig,
  remote: string,
  branch: string,
): Promise<string> => {
  const mode = config.push?.default;
  if (mode === 'nothing') throw branchMarkUnresolved({ reason: 'push-default-nothing' });
  if (mode === 'upstream') return upstreamRef(ctx, config, branch);
  if (mode === 'current' || mode === 'matching') {
    return Promise.resolve(trackingForPushDest(config, remote, `${HEADS_PREFIX}${branch}`));
  }
  return simplePushRef(ctx, config, remote, branch);
};

/** git's `branch_get_push_1`: the push remote's refspecs map the branch, else `push.default` decides. */
const pushRef = async (ctx: Context, config: ParsedConfig, branch: string): Promise<string> => {
  const remote = resolvePushRemote(config, undefined, branch);
  const pushSpecs = config.remote?.get(remote)?.push ?? [];
  if (pushSpecs.length === 0) return pushDefaultRef(ctx, config, remote, branch);
  const destination = findTrackingRef(pushSpecs, `${HEADS_PREFIX}${branch}`);
  if (destination === undefined) {
    throw branchMarkUnresolved({ reason: 'push-refspecs-exclude-branch', remote, branch });
  }
  return trackingForPushDest(config, remote, destination);
};

const markedRef = async (ctx: Context, mark: BranchMark): Promise<string> => {
  const branch = await markedBranch(ctx, mark);
  const config = await readConfig(ctx);
  return mark.kind === 'upstream' ? upstreamRef(ctx, config, branch) : pushRef(ctx, config, branch);
};

/**
 * The ref `name`'s branch mark names, shortened as `set_shortened_ref` spells it,
 * when the mark ends it — git substitutes
 * only a name it consumes whole, yet dies on a mark it cannot resolve first.
 * `undefined` when `name` carries no mark.
 */
export const branchMarkRef = async (ctx: Context, name: string): Promise<string | undefined> => {
  if (!name.includes(MARK_OPENER)) return undefined;
  const expanded = await expandPriorCheckout(ctx, name);
  if (expanded.startsWith(UNEXPANDED_PRIOR_CHECKOUT)) return undefined;
  const mark = findBranchMark(expanded);
  if (mark === undefined) return undefined;
  const ref = await markedRef(ctx, mark);
  return mark.whole ? shortenUnambiguousRef(ctx, ref) : undefined;
};
