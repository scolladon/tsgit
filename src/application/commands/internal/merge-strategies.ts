import { unknownMergeStrategy } from '../../../domain/commands/error.js';
import { unsupportedOperation } from '../../../domain/index.js';
import type { MergeConflict } from '../../../domain/merge/index.js';
import type { Context } from '../../../ports/context.js';
import { findLastEntry } from '../../primitives/config-read.js';
import { assertNoValuelessConfig } from '../../primitives/internal/valueless-config-guard.js';

/** git's built-in strategies, as its refusal lists them; `ort` is built in without a command. */
const AVAILABLE_STRATEGIES = ['octopus', 'ours', 'recursive', 'resolve', 'subtree'] as const;
const KNOWN_STRATEGIES: ReadonlySet<string> = new Set([...AVAILABLE_STRATEGIES, 'ort']);
/** Strategies git marks `NO_FAST_FORWARD`. */
const NO_FAST_FORWARD_STRATEGIES: ReadonlySet<string> = new Set(['ours', 'subtree']);
/** Strategies git does not mark `NO_TRIVIAL`: only they allow its trivial in-index merge. */
const TRIVIAL_STRATEGIES: ReadonlySet<string> = new Set(['octopus', 'resolve']);
/** Strategies known to git that tsgit does not run yet: `subtree` needs git's `shift_tree`. */
const UNSUPPORTED_STRATEGIES: ReadonlySet<string> = new Set(['subtree']);

const DEFAULT_TWO_HEAD = ['ort'] as const;
const DEFAULT_OCTOPUS = ['octopus'] as const;
const STRATEGY_SEPARATOR = ' ';

/** git's `get_strategy`: an unknown strategy refuses before anything else. */
const assertKnownStrategy = (strategy: string): void => {
  if (!KNOWN_STRATEGIES.has(strategy)) throw unknownMergeStrategy(strategy, AVAILABLE_STRATEGIES);
  if (UNSUPPORTED_STRATEGIES.has(strategy)) {
    throw unsupportedOperation('merge', `${strategy} strategy`);
  }
};

/** The caller's `-s` strategies, in order, each refused as git's `get_strategy` refuses it. */
export const explicitStrategies = (
  strategy: string | ReadonlyArray<string> | undefined,
): ReadonlyArray<string> | undefined => {
  if (strategy === undefined) return undefined;
  const strategies = typeof strategy === 'string' ? [strategy] : strategy;
  strategies.forEach(assertKnownStrategy);
  return strategies;
};

/** git's `git_config_string` for `pull.twohead` / `pull.octopus`, read with the rest of merge's config. */
export const assertStrategyConfig = (ctx: Context): Promise<void> =>
  assertNoValuelessConfig(ctx, 'pull', undefined, ['twohead', 'octopus']);

/**
 * git's `add_strategies`: the caller's strategies, else `pull.twohead` (one
 * head) or `pull.octopus` (several) split on single spaces, else the default.
 */
export const settleStrategies = async (
  ctx: Context,
  explicit: ReadonlyArray<string> | undefined,
  headCount: number,
): Promise<ReadonlyArray<string>> => {
  if (explicit !== undefined) return explicit;
  const several = headCount > 1;
  const value = (await findLastEntry(ctx, 'pull', several ? 'octopus' : 'twohead'))?.value;
  if (typeof value !== 'string') return several ? DEFAULT_OCTOPUS : DEFAULT_TWO_HEAD;
  const configured = value.split(STRATEGY_SEPARATOR);
  configured.forEach(assertKnownStrategy);
  return configured;
};

/** Any strategy git marks `NO_FAST_FORWARD` forbids the fast-forward. */
export const forbidsFastForward = (strategies: ReadonlyArray<string>): boolean =>
  strategies.some((strategy) => NO_FAST_FORWARD_STRATEGIES.has(strategy));

/** git's `allow_trivial`: no strategy is marked `NO_TRIVIAL`. */
export const allowsTrivialMerge = (strategies: ReadonlyArray<string>): boolean =>
  strategies.every((strategy) => TRIVIAL_STRATEGIES.has(strategy));

/** git's `evaluate_result`: each unmerged path's diff-files record plus its index stages. */
export const conflictWeight = (conflicts: ReadonlyArray<MergeConflict>): number =>
  conflicts.reduce(
    (sum, { baseId, ourId, theirId }) =>
      sum + 1 + [baseId, ourId, theirId].filter((id) => id !== undefined).length,
    0,
  );

/** git's `best_cnt <= 0 || cnt <= best_cnt`: of equally few conflicts, the later strategy's wins. */
export const preferConflict = <T extends { readonly weight: number }>(
  best: T | undefined,
  tried: T,
): T => (best === undefined || tried.weight <= best.weight ? tried : best);
