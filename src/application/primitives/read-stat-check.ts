/**
 * Resolve the two keys that narrow git's stat comparison, `core.trustCtime` and
 * `core.checkStat`: the per-worktree `config.worktree`, when `extensions.worktreeConfig`
 * is on, overrides the shared local file. A bad value never reaches this reader through a
 * command: the eager gate refuses it first, so the invalid entries skipped here only serve
 * a direct caller.
 */
import { parseCheckStat } from '../../domain/config/check-stat.js';
import type { StatCheck } from '../../domain/git-index/stat-check.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from './config-read.js';
import { readActiveWorktreeSections } from './config-scoped-read.js';
import {
  coreKeyEntries,
  isWorktreeConfigExtensionOn,
  lastValidBoolean,
} from './read-sparse-config.js';

const TRUST_CTIME_KEY = 'trustctime';
const CHECK_STAT_KEY = 'checkstat';
const STAT_KEYS: ReadonlySet<string> = new Set([TRUST_CTIME_KEY, CHECK_STAT_KEY]);
const DEFAULT_TRUST_CTIME = true;

interface StatKeys {
  readonly trustCtime?: boolean | undefined;
  readonly minimal?: boolean | undefined;
}

const readWorktreeKeys = async (ctx: Context): Promise<StatKeys> => {
  if (!(await isWorktreeConfigExtensionOn(ctx))) return {};
  const entries = coreKeyEntries(await readActiveWorktreeSections(ctx), STAT_KEYS);
  const checkStat = entries
    .filter((entry) => entry.key === CHECK_STAT_KEY)
    .map((entry) => parseCheckStat(entry.value))
    .filter((parsed) => parsed !== undefined)
    .at(-1);
  return {
    trustCtime: lastValidBoolean(entries, TRUST_CTIME_KEY),
    minimal: checkStat === undefined ? undefined : checkStat === 'minimal',
  };
};

export const readStatCheck = async (ctx: Context): Promise<StatCheck> => {
  const worktree = await readWorktreeKeys(ctx);
  const { core } = await readConfig(ctx);
  const minimal = worktree.minimal ?? core?.checkStat === 'minimal';
  const trustCtime = worktree.trustCtime ?? core?.trustCtime ?? DEFAULT_TRUST_CTIME;
  return { ctime: trustCtime && !minimal, ownerAndInode: !minimal };
};
