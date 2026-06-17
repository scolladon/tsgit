import { configBadNumericValue } from '../../../domain/commands/error.js';
import type { Context } from '../../../ports/context.js';
import { findFirstValuelessEntry } from '../config-read.js';

/**
 * Refuse with `CONFIG_BAD_NUMERIC_VALUE` when any of `keys` (case-insensitive)
 * under `[<section> "<subsection>"]` is present-but-valueless (git's internal
 * NULL), reporting the FIRST such entry by config-file line. Returns normally
 * when none is valueless.
 *
 * The int shape carries `value: ''` (no raw value to parse) and
 * `reason: 'invalid unit'` — the same death git fires for a valueless int key.
 * Unlike the string shape, it has NO `line` field.
 */
export const assertNoBadNumericConfig = async (
  ctx: Context,
  section: string,
  subsection: string | undefined,
  keys: ReadonlyArray<string>,
): Promise<void> => {
  const found = await findFirstValuelessEntry(ctx, section, subsection, keys);
  if (found !== undefined) throw configBadNumericValue(found.key, found.source, '', 'invalid unit');
};
