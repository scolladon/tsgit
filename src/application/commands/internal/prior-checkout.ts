/**
 * git's `interpret_nth_prior_checkout`: `@{-<n>}` names the branch the n-th
 * most recent `checkout: moving from <branch> to …` in HEAD's reflog left.
 */
import type { RefName } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readReflogLenient } from '../../primitives/reflog-store.js';

const NTH_PRIOR = /^@\{-(\d+)\}/;
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
