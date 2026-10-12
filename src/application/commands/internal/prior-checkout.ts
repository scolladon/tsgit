/**
 * git's `interpret_nth_prior_checkout`: `@{-<n>}` names the branch the n-th
 * most recent `checkout: moving from <branch> to …` in HEAD's reflog left.
 */
import type { RefName } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readReflogLenient } from '../../primitives/reflog-store.js';

const NTH_PRIOR = /^@\{-(\d+)\}/;
const WHOLE_NTH_PRIOR = /^@\{-(\d+)\}$/;
const SWITCH_PREFIX = 'checkout: moving from ';
const SWITCH_SEPARATOR = ' to ';

/** The branch a reflog message records leaving, or `undefined` for any other message. */
const branchLeft = (message: string): string | undefined => {
  if (!message.startsWith(SWITCH_PREFIX)) return undefined;
  const target = message.slice(SWITCH_PREFIX.length);
  const end = target.indexOf(SWITCH_SEPARATOR);
  return end === -1 ? undefined : target.slice(0, end);
};

const nthBranchLeft = async (ctx: Context, nth: number): Promise<string | undefined> => {
  const switches = (await readReflogLenient(ctx, 'HEAD' as RefName))
    .map((entry) => branchLeft(entry.message))
    .filter((branch): branch is string => branch !== undefined);
  return switches[switches.length - nth];
};

/** `name` with a leading `@{-<n>}` spelt out as its branch; unchanged when there is none. */
export const expandPriorCheckout = async (ctx: Context, name: string): Promise<string> => {
  const match = NTH_PRIOR.exec(name);
  const nth = Number(match?.[1] ?? 0);
  if (match === null || nth === 0) return name;
  const branch = await nthBranchLeft(ctx, nth);
  return branch === undefined ? name : `${branch}${name.slice(match[0].length)}`;
};

/**
 * The whole `name` as `@{-<n>}`: the branch — or, for a detached HEAD, the
 * object id — the n-th prior checkout left. `undefined` when `name` is not
 * one, or HEAD's reflog records fewer switches.
 */
export const nthPriorCheckout = async (ctx: Context, name: string): Promise<string | undefined> => {
  const nth = Number(WHOLE_NTH_PRIOR.exec(name)?.[1] ?? 0);
  return nth === 0 ? undefined : nthBranchLeft(ctx, nth);
};

/** git's `copy_branchname` for a local branch: `@{-<n>}` spelt as the branch it
 *  left; any other name — or a prior checkout the reflog cannot name — as is. */
export const interpretBranchName = async (ctx: Context, name: string): Promise<string> =>
  (await nthPriorCheckout(ctx, name)) ?? name;

const PREVIOUS_CHECKOUT = '@{-1}';
const PREVIOUS_CHECKOUT_SHORTHAND = '-';

/** git's lone `-` argument (`checkout`, `merge`, `rebase`, `cherry-pick`, …): `@{-1}`. */
export const previousCheckoutArg = (arg: string): string =>
  arg === PREVIOUS_CHECKOUT_SHORTHAND ? PREVIOUS_CHECKOUT : arg;
