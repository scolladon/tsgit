import { configBadBooleanValue, configMissingValue } from '../../../domain/commands/error.js';
import { parseGitBoolean } from '../../../domain/config/config-ini.js';
import type { Context } from '../../../ports/context.js';
import { assertValidGcNumberConfig, findLastEntry } from '../config-read.js';
import { configExpiryCutoff } from '../expiry-cutoff.js';

const GC_SECTION = 'gc';

/** git's `repo_config_get_expiry` on the last entry; `undefined` when the key is absent. */
const readLastGcExpiry = async (ctx: Context, key: string): Promise<number | undefined> => {
  const entry = await findLastEntry(ctx, GC_SECTION, key);
  if (entry === undefined) return undefined;
  if (entry.value === null) throw configMissingValue(entry.key, entry.source, entry.line);
  return configExpiryCutoff(entry.value);
};

/**
 * git's `repo_config_get_expiry` for a `[gc]` key: the last entry wins, a
 * valueless one dies as a missing value, and its grammar refuses through
 * `configExpiryCutoff`. An absent key resolves `fallback`, git's default.
 */
export const readGcExpiryCutoff = async (
  ctx: Context,
  key: string,
  fallback: string,
): Promise<number> => (await readLastGcExpiry(ctx, key)) ?? configExpiryCutoff(fallback);

/** git's `repo_config_get_bool` refusal on the last `[gc]` entry of `key`. */
const assertValidGcBooleanConfig = async (ctx: Context, key: string): Promise<void> => {
  const entry = await findLastEntry(ctx, GC_SECTION, key);
  if (entry === undefined || parseGitBoolean(entry.value).ok) return;
  // Stryker disable next-line StringLiteral: equivalent — parseGitBoolean(null) is ok, so a null value never reaches the throw and the fallback is never read
  throw configBadBooleanValue(entry.key, entry.source, entry.value ?? '');
};

/** The `gc_config` keys git reads before `gc.pruneExpire`, in git's order. */
export const assertValidLeadingGcConfig = async (ctx: Context): Promise<void> => {
  await assertValidGcBooleanConfig(ctx, 'cruftPacks');
};

/** The `gc_config` keys git reads after `gc.worktreePruneExpire`, in git's order. */
export const assertValidTrailingGcConfig = async (ctx: Context): Promise<void> => {
  await readLastGcExpiry(ctx, 'logExpiry');
};

/** The keys git reads only when it consults the auto gate: `gc.auto`, then `gc.autoPackLimit`. */
export const assertValidGcAutoConfig = async (ctx: Context): Promise<void> => {
  await assertValidGcNumberConfig(ctx, 'auto', 'int');
  await assertValidGcNumberConfig(ctx, 'autoPackLimit', 'int');
};

/** The key git reads only when it repacks. */
export const assertValidBigPackThreshold = async (ctx: Context): Promise<void> => {
  await assertValidGcNumberConfig(ctx, 'bigPackThreshold', 'ulong');
};
