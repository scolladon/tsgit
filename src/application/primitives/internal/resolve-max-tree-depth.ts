import { configBadNumericValue } from '../../../domain/commands/error.js';
import { DEFAULT_MAX_TREE_DEPTH } from '../../../domain/diff/flat-tree.js';
import type { Context } from '../../../ports/context.js';
import { findLastInvalidMaxTreeDepth, readConfig } from '../config-read.js';

/**
 * Resolve `core.maxTreeDepth`, defaulting to 2048 when unset. Unlike
 * `readConfig` (total and lenient), this DOES refuse: it throws
 * `CONFIG_BAD_NUMERIC_VALUE` when the effective (last-wins) value is
 * malformed. This is a defensive guard for a direct primitive path that does
 * not pass through a command's operational gate — the eager, command-level
 * refusal is a separate check that cannot see primitive-level callers. The
 * two guards are deliberately redundant, each covering a surface the other
 * cannot.
 */
export const resolveMaxTreeDepth = async (ctx: Context): Promise<number> => {
  const invalid = await findLastInvalidMaxTreeDepth(ctx);
  if (invalid !== undefined) {
    throw configBadNumericValue(invalid.key, invalid.source, invalid.value, invalid.reason);
  }
  const parsed = await readConfig(ctx);
  return parsed.core?.maxTreeDepth ?? DEFAULT_MAX_TREE_DEPTH;
};
