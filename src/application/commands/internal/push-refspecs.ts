/**
 * Push refspec plan/finalize seam.
 *
 * `planPushRefspecs` runs before the remote is contacted, so refusals
 * (e.g. a detached HEAD under `push.default=current`) fire before any
 * wire exchange. `finalizePushRefspecs` runs once the remote's ref
 * advertisement is known — only `matching` needs it, to expand against
 * the advertised ref set; every other plan kind is a pass-through.
 */
import {
  invalidOption,
  noUpstreamConfigured,
  pushDefaultNothing,
  pushDetachedNoRefspec,
  pushRemoteNotUpstream,
  pushUpstreamNameMismatch,
} from '../../../domain/commands/error.js';
import { RefName } from '../../../domain/objects/object-id.js';
import type { Advertisement } from '../../../domain/protocol/index.js';
import { shortBranchName } from '../../../domain/refs/short-branch-name.js';
import type { Context } from '../../../ports/context.js';
import type { ParsedConfig } from '../../primitives/config-read.js';
import {
  branchRefFromHead,
  type HeadState,
  readHeadRaw,
} from '../../primitives/internal/repo-state.js';
import { defaultRemoteName, resolvePushRemote } from './default-remote.js';
import { type ParsedRefspec, parseRefspec } from './refspec.js';

export type PushRefspecPlan =
  | { readonly kind: 'explicit'; readonly refspecs: ReadonlyArray<ParsedRefspec> }
  | { readonly kind: 'fixed'; readonly refspecs: ReadonlyArray<ParsedRefspec> }
  | { readonly kind: 'matching' };

export interface PushRefspecOptions {
  readonly refspecs?: ReadonlyArray<string>;
  readonly remote?: string;
}

/**
 * Decide the refspecs to push, before the remote is contacted.
 *
 * Explicit `opts.refspecs` always win, regardless of `push.default`.
 * `push.default=current` computes the current-branch same-named refspec
 * and refuses on a detached HEAD. `push.default=nothing` always refuses,
 * regardless of HEAD state. `push.default=upstream` refuses on a detached
 * HEAD, then refuses a triangular workflow (the resolved push remote is
 * not the branch's fetch remote) even when no upstream is configured —
 * that triangular check dominates — then refuses when no
 * `branch.<name>.merge` is configured, and otherwise pushes to the
 * configured upstream ref. `push.default=simple` — and unset, which
 * behaves as `simple` (git's own default) — refuses on a detached HEAD,
 * then treats a triangular workflow like `current` (pushes the same-named
 * ref, no upstream needed), then refuses when no `branch.<name>.merge` is
 * configured, then refuses when the configured upstream's short name
 * differs from the current branch, and otherwise pushes to it. `matching`
 * is the only mode still routed through the legacy HEAD-default
 * resolution — it needs the wire advertisement, which isn't available yet
 * at plan time.
 */
export const planPushRefspecs = async (
  ctx: Context,
  config: ParsedConfig,
  opts: PushRefspecOptions,
  head: HeadState,
): Promise<PushRefspecPlan> => {
  if (opts.refspecs !== undefined && opts.refspecs.length > 0) {
    return { kind: 'explicit', refspecs: opts.refspecs.map(parseRefspec) };
  }
  if (config.push?.default === 'current') {
    return planCurrent(head);
  }
  if (config.push?.default === 'nothing') {
    throw pushDefaultNothing();
  }
  if (config.push?.default === 'upstream') {
    return planUpstream(config, opts, head);
  }
  if (config.push?.default === 'matching') {
    return { kind: 'fixed', refspecs: await resolveRefspecsInput(ctx, opts.refspecs) };
  }
  return planSimple(config, opts, head);
};

const planCurrent = (head: HeadState): PushRefspecPlan => {
  const branch = branchRefFromHead(head);
  if (branch === undefined) {
    throw pushDetachedNoRefspec();
  }
  return { kind: 'fixed', refspecs: [parseRefspec(`${branch}:${branch}`)] };
};

/**
 * The push/fetch remote resolution for the current branch, computed once so
 * `upstream` and `simple` (which layers a name-mismatch check on top) can
 * share it.
 */
interface BranchRemoteInfo {
  readonly branchFull: RefName;
  readonly fetchRemote: string;
  readonly pushRemote: string;
  readonly triangular: boolean;
  readonly merge: string | undefined;
}

const resolveBranchRemoteInfo = (
  config: ParsedConfig,
  opts: PushRefspecOptions,
  branchFull: RefName,
): BranchRemoteInfo => {
  const cur = shortBranchName(branchFull);
  const fetchRemote = defaultRemoteName(config, undefined, cur);
  const pushRemote = resolvePushRemote(config, opts.remote, cur);
  return {
    branchFull,
    fetchRemote,
    pushRemote,
    triangular: pushRemote !== fetchRemote,
    merge: config.branch?.get(cur)?.merge,
  };
};

const planUpstream = (
  config: ParsedConfig,
  opts: PushRefspecOptions,
  head: HeadState,
): PushRefspecPlan => {
  const branch = branchRefFromHead(head);
  if (branch === undefined) {
    throw pushDetachedNoRefspec();
  }
  const { branchFull, pushRemote, triangular, merge } = resolveBranchRemoteInfo(
    config,
    opts,
    branch,
  );
  if (triangular) {
    throw pushRemoteNotUpstream(pushRemote, branchFull);
  }
  if (merge === undefined) {
    throw noUpstreamConfigured(branchFull);
  }
  return { kind: 'fixed', refspecs: [parseRefspec(`${branchFull}:${merge}`)] };
};

/**
 * `simple` — git's own default when `push.default` is unset. A triangular
 * workflow is treated like `current` (same-named ref, no upstream needed);
 * a central workflow requires a configured upstream whose short name
 * matches the current branch, refusing `PUSH_UPSTREAM_NAME_MISMATCH`
 * otherwise (the one guard `upstream` mode does not apply).
 */
const planSimple = (
  config: ParsedConfig,
  opts: PushRefspecOptions,
  head: HeadState,
): PushRefspecPlan => {
  const branch = branchRefFromHead(head);
  if (branch === undefined) {
    throw pushDetachedNoRefspec();
  }
  const { branchFull, triangular, merge } = resolveBranchRemoteInfo(config, opts, branch);
  if (triangular) {
    return { kind: 'fixed', refspecs: [parseRefspec(`${branchFull}:${branchFull}`)] };
  }
  if (merge === undefined) {
    throw noUpstreamConfigured(branchFull);
  }
  const upstream = RefName.from(merge);
  if (shortBranchName(upstream) !== shortBranchName(branchFull)) {
    throw pushUpstreamNameMismatch(branchFull, upstream);
  }
  return { kind: 'fixed', refspecs: [parseRefspec(`${branchFull}:${upstream}`)] };
};

const resolveRefspecsInput = async (
  ctx: Context,
  refspecs: ReadonlyArray<string> | undefined,
): Promise<ReadonlyArray<ParsedRefspec>> => {
  // An explicit empty `refspecs: []` must fall through to the HEAD-default
  // branch — `length > 0` (not `>= 0`) makes `[]` behave like "no refspec".
  if (refspecs !== undefined && refspecs.length > 0) {
    return refspecs.map(parseRefspec);
  }
  const head = await readHeadRaw(ctx);
  if (head.kind !== 'symbolic') {
    throw invalidOption('refspecs', 'no-default-refspec (HEAD is detached)');
  }
  const branch = head.target;
  return [parseRefspec(`${branch}:${branch}`)];
};

/**
 * Resolve a plan against the remote's ref advertisement. `matching` is not
 * produced by `planPushRefspecs` yet (its refspecs depend on `adv`, so it
 * is filled in once that mode moves out of the legacy fallback) — for now
 * it returns an empty placeholder rather than being unreachable, keeping
 * this function total over `PushRefspecPlan`.
 */
export const finalizePushRefspecs = (
  plan: PushRefspecPlan,
  _adv: Advertisement,
): ReadonlyArray<ParsedRefspec> => (plan.kind === 'matching' ? [] : plan.refspecs);
