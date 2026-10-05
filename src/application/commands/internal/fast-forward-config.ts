import { configInvalidEnumValue } from '../../../domain/commands/error.js';
import { parseGitBoolean } from '../../../domain/config/config-ini.js';
import type { Context } from '../../../ports/context.js';
import { findLastEntry } from '../../primitives/config-read.js';

/** git's `--ff` / `--ff-only` / `--no-ff`. */
type FastForwardPolicy = 'only' | 'never' | 'allow';

const ONLY = 'only';

/** A valueless key, which git's boolean grammar reads as true. */
const VALUELESS: FastForwardPolicy = 'allow';

/** git's `git_parse_maybe_bool` then the case-sensitive `only`; `undefined` where git finds neither. */
const parseFastForward = (value: string): FastForwardPolicy | undefined => {
  const parsed = parseGitBoolean(value);
  if (parsed.ok) return parsed.value ? 'allow' : 'never';
  return value === ONLY ? 'only' : undefined;
};

/**
 * git merge's `merge.ff`: the policy it names, or `undefined` when unset — an
 * unknown value is ignored, which git keeps for values from future versions.
 */
export const configuredMergeFastForward = async (
  ctx: Context,
): Promise<FastForwardPolicy | undefined> => {
  const entry = await findLastEntry(ctx, 'merge', 'ff');
  if (entry === undefined) return undefined;
  return entry.value === null ? VALUELESS : parseFastForward(entry.value);
};

/**
 * git pull's `config_get_ff` under `--no-rebase`: `pull.ff`'s policy, or
 * `undefined` when unset. An unknown value refuses the pull; `only` turns into
 * a plain fast-forward-or-merge, as git does whenever the rebase choice is
 * given — tsgit's pull always integrates by merge.
 */
export const configuredPullFastForward = async (
  ctx: Context,
): Promise<FastForwardPolicy | undefined> => {
  const entry = await findLastEntry(ctx, 'pull', 'ff');
  if (entry === undefined) return undefined;
  if (entry.value === null) return VALUELESS;
  const policy = parseFastForward(entry.value);
  if (policy === undefined) {
    throw configInvalidEnumValue(entry.key, entry.source, entry.value, entry.line);
  }
  return policy === ONLY ? 'allow' : policy;
};
