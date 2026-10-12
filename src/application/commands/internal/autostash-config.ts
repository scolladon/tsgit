import { parseGitBoolean } from '../../../domain/config/config-ini.js';
import type { Context } from '../../../ports/context.js';
import { findLastEntry } from '../../primitives/config-read.js';
import { assertValidBooleanConfig } from '../../primitives/internal/boolean-config-guard.js';

/** The commands whose `<section>.autostash` git reads. */
export type AutostashSection = 'rebase' | 'merge' | 'pull';

/**
 * git's `<section>.autostash` boolean: `undefined` when unset, so a caller can
 * fall back to another section; a value outside git's boolean grammar refuses.
 */
export const configuredAutostash = async (
  ctx: Context,
  section: AutostashSection,
): Promise<boolean | undefined> => {
  await assertValidBooleanConfig(ctx, section, undefined, [AUTOSTASH_KEY]);
  const entry = await findLastEntry(ctx, section, AUTOSTASH_KEY);
  if (entry === undefined) return undefined;
  const parsed = parseGitBoolean(entry.value);
  return parsed.ok && parsed.value;
};

const AUTOSTASH_KEY = 'autostash';
