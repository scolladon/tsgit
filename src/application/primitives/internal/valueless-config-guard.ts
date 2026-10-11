import { configMissingValue } from '../../../domain/commands/error.js';
import type { Context } from '../../../ports/context.js';
import { findFirstValuelessEntry } from '../config-read.js';

/**
 * Refuse with `CONFIG_MISSING_VALUE` when any of `keys` (case-insensitive) under
 * `[<section> "<subsection>"]` is present-but-valueless (git's internal NULL),
 * reporting the FIRST such entry by config-file line. Returns normally when none
 * is valueless.
 *
 * Two safe call patterns, both relying on the no-op-unless-valueless contract:
 *  - On a command's refusal/fallback path (the lazy keys) so a valued config
 *    still resolves and the absent case still falls through to the caller's own
 *    refusal.
 *  - As an eager pre-flight before a command does its work (the `[core]`
 *    path-likes), reproducing git's broad `git_default_config` death while still
 *    no-op'ing for a valued or absent section.
 */
export const assertNoValuelessConfig = async (
  ctx: Context,
  section: string,
  subsection: string | undefined,
  keys: ReadonlyArray<string>,
): Promise<void> => {
  const found = await findFirstValuelessEntry(ctx, section, subsection, keys);
  if (found !== undefined) throw configMissingValue(found.key, found.source, found.line);
};
