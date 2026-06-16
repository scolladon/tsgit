import { configMissingValue } from '../../../domain/commands/error.js';
import type { Context } from '../../../ports/context.js';
import {
  findFirstValuelessEntry,
  findFirstValuelessInSection,
} from '../../primitives/config-read.js';

/**
 * Refuse with `CONFIG_MISSING_VALUE` when any of `keys` (case-insensitive) under
 * `[<section> "<subsection>"]` is present-but-valueless (git's internal NULL),
 * reporting the FIRST such entry by config-file line. Returns normally when none
 * is valueless. Call ONLY on a command's refusal path so a valued config still
 * resolves and the absent case still falls through to the caller's own refusal.
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

/**
 * Subsection-wildcard sibling of `assertNoValuelessConfig`: refuse with
 * `CONFIG_MISSING_VALUE` when any of `keys` (case-insensitive) under ANY
 * subsection of `[<section> …]` is present-but-valueless, reporting the FIRST
 * such entry by config-file line. Returns normally when none is valueless.
 */
export const assertNoValuelessInSection = async (
  ctx: Context,
  section: string,
  keys: ReadonlyArray<string>,
): Promise<void> => {
  const found = await findFirstValuelessInSection(ctx, section, keys);
  if (found !== undefined) throw configMissingValue(found.key, found.source, found.line);
};
