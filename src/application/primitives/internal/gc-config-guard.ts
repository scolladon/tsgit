import { configMissingValue } from '../../../domain/commands/error.js';
import type { Context } from '../../../ports/context.js';
import { findLastEntry } from '../config-read.js';
import { configExpiryCutoff } from '../expiry-cutoff.js';

const GC_SECTION = 'gc';

/**
 * git's `repo_config_get_expiry` for a `[gc]` key: the last entry wins, a
 * valueless one dies as a missing value, and its grammar refuses through
 * `configExpiryCutoff`. An absent key resolves `fallback`, git's default.
 */
export const readGcExpiryCutoff = async (
  ctx: Context,
  key: string,
  fallback: string,
): Promise<number> => {
  const entry = await findLastEntry(ctx, GC_SECTION, key);
  if (entry === undefined) return configExpiryCutoff(fallback);
  if (entry.value === null) throw configMissingValue(entry.key, entry.source, entry.line);
  return configExpiryCutoff(entry.value);
};
