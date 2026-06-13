import { configMissingValue } from '../../../domain/commands/error.js';
import type { Context } from '../../../ports/context.js';
import { findFirstValuelessEntry } from '../../primitives/config-read.js';

/**
 * Refuse with `CONFIG_MISSING_VALUE` when `[user] name`/`email` is
 * present-but-valueless, reporting the FIRST such entry by config-file line.
 * Call ONLY on the cold path — where identity is otherwise unresolved — so a
 * valued config still resolves normally and the absent case still falls through
 * to `AUTHOR_UNCONFIGURED`.
 */
export const assertUserNotValueless = async (ctx: Context): Promise<void> => {
  const found = await findFirstValuelessEntry(ctx, 'user', undefined, ['name', 'email']);
  if (found !== undefined) throw configMissingValue(found.key, found.source, found.line);
};
