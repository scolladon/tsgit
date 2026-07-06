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
  pushDefaultNothing,
  pushDetachedNoRefspec,
} from '../../../domain/commands/error.js';
import type { Advertisement } from '../../../domain/protocol/index.js';
import type { Context } from '../../../ports/context.js';
import type { ParsedConfig } from '../../primitives/config-read.js';
import {
  branchRefFromHead,
  type HeadState,
  readHeadRaw,
} from '../../primitives/internal/repo-state.js';
import { type ParsedRefspec, parseRefspec } from './refspec.js';

export type PushRefspecPlan =
  | { readonly kind: 'explicit'; readonly refspecs: ReadonlyArray<ParsedRefspec> }
  | { readonly kind: 'fixed'; readonly refspecs: ReadonlyArray<ParsedRefspec> }
  | { readonly kind: 'matching' };

export interface PushRefspecOptions {
  readonly refspecs?: ReadonlyArray<string>;
}

/**
 * Decide the refspecs to push, before the remote is contacted.
 *
 * Explicit `opts.refspecs` always win, regardless of `push.default`.
 * `push.default=current` computes the current-branch same-named refspec
 * and refuses on a detached HEAD. `push.default=nothing` always refuses,
 * regardless of HEAD state. Every other mode — `simple`, `upstream`,
 * `matching`, and unset (default `simple`) — still routes through the
 * pre-existing HEAD-default resolution so their behaviour is unchanged.
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
  return { kind: 'fixed', refspecs: await resolveRefspecsInput(ctx, opts.refspecs) };
};

const planCurrent = (head: HeadState): PushRefspecPlan => {
  const branch = branchRefFromHead(head);
  if (branch === undefined) {
    throw pushDetachedNoRefspec();
  }
  return { kind: 'fixed', refspecs: [parseRefspec(`${branch}:${branch}`)] };
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
