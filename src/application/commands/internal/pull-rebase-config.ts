/**
 * git pull's `config_get_rebase`: `branch.<current>.rebase`, else `pull.rebase`,
 * parsed by `rebase_parse_value`; an unparsable value refuses the pull before
 * it fetches.
 */
import { configInvalidEnumValue } from '../../../domain/commands/error.js';
import { parseGitBoolean } from '../../../domain/config/config-ini.js';
import type { Context } from '../../../ports/context.js';
import {
  findLastEntry,
  findLastSubsectionEntry,
  type LocatedConfigEntry,
} from '../../primitives/config-read.js';

/** git's `--rebase` / `--rebase=merges` / `--no-rebase`. */
export type PullRebaseMode = boolean | 'merges';

const MERGES_WORDS: ReadonlySet<string> = new Set(['merges', 'm']);
// tsgit has no editor: an interactive rebase runs the todo git would offer, unedited.
const INTERACTIVE_WORDS: ReadonlySet<string> = new Set(['interactive', 'i']);

/** git's `rebase_parse_value`; `undefined` for `REBASE_INVALID` (`preserve` included). */
const parseRebase = (value: string): PullRebaseMode | undefined => {
  const parsed = parseGitBoolean(value);
  if (parsed.ok) return parsed.value;
  if (MERGES_WORDS.has(value)) return 'merges';
  return INTERACTIVE_WORDS.has(value) ? true : undefined;
};

/** A valueless key, which git's boolean grammar reads as true. */
const VALUELESS: PullRebaseMode = true;

const branchEntry = (
  ctx: Context,
  branch: string | undefined,
): Promise<LocatedConfigEntry | undefined> =>
  branch === undefined
    ? Promise.resolve(undefined)
    : findLastSubsectionEntry(ctx, 'branch', branch, 'rebase');

/** The configured rebase mode for `branch` (none when detached), or `undefined` when unset. */
export const configuredPullRebase = async (
  ctx: Context,
  branch: string | undefined,
): Promise<PullRebaseMode | undefined> => {
  const entry = (await branchEntry(ctx, branch)) ?? (await findLastEntry(ctx, 'pull', 'rebase'));
  if (entry === undefined) return undefined;
  if (entry.value === null) return VALUELESS;
  const mode = parseRebase(entry.value);
  if (mode === undefined) {
    throw configInvalidEnumValue(entry.key, entry.source, entry.value, entry.line);
  }
  return mode;
};
