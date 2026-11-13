/**
 * Resolve the two sparse keys across the config layers git consults: the
 * per-worktree `config.worktree` (when `extensions.worktreeConfig` is on)
 * overrides the shared local file, key by key.
 */
import { type IniSection, parseGitBoolean } from '../../domain/config/config-ini.js';
import type { Context } from '../../ports/context.js';
import { findLastEntry, readConfig } from './config-read.js';
import { readConfigSections } from './config-scoped-read.js';
import { layoutFailsAcceptance } from './internal/layout-verdict.js';

export interface SparseConfig {
  readonly enabled: boolean;
  readonly cone: boolean;
}

interface WorktreeSparseKeys {
  readonly enabled?: boolean | undefined;
  readonly cone?: boolean | undefined;
}

const CORE_SECTION = 'core';
const ENABLED_KEY = 'sparsecheckout';
const CONE_KEY = 'sparsecheckoutcone';

const lastValidBoolean = (
  sections: ReadonlyArray<IniSection>,
  wanted: string,
): boolean | undefined => {
  let result: boolean | undefined;
  for (const section of sections) {
    if (section.section.toLowerCase() !== CORE_SECTION) continue;
    if (section.subsection !== undefined) continue;
    for (const entry of section.entries) {
      if (entry.key.toLowerCase() !== wanted) continue;
      const parsed = parseGitBoolean(entry.value);
      if (parsed.ok) result = parsed.value;
    }
  }
  return result;
};

const lastValidBooleans = (sections: ReadonlyArray<IniSection>): WorktreeSparseKeys => ({
  enabled: lastValidBoolean(sections, ENABLED_KEY),
  cone: lastValidBoolean(sections, CONE_KEY),
});

/**
 * Whether `extensions.worktreeConfig` is on, read from the epoch-trusted
 * local entry so an operational command pays no stat beyond its own. A
 * refused value is inert here: the discovery-tier gate raises it.
 */
export const isWorktreeConfigExtensionOn = async (ctx: Context): Promise<boolean> => {
  if (layoutFailsAcceptance(ctx.layout)) return false;
  const entry = await findLastEntry(ctx, 'extensions', 'worktreeConfig');
  if (entry === undefined) return false;
  const parsed = parseGitBoolean(entry.value);
  return parsed.ok && parsed.value;
};

const readWorktreeKeys = async (ctx: Context): Promise<WorktreeSparseKeys> => {
  if (!(await isWorktreeConfigExtensionOn(ctx))) return {};
  const scoped = await readConfigSections({ ctx, scope: 'worktree' });
  return lastValidBooleans(scoped.map((entry) => entry.section));
};

export const readSparseConfig = async (ctx: Context): Promise<SparseConfig> => {
  const local = await readConfig(ctx);
  const worktree = await readWorktreeKeys(ctx);
  return {
    enabled: worktree.enabled ?? local.core?.sparseCheckout ?? false,
    cone: worktree.cone ?? local.core?.sparseCheckoutCone ?? false,
  };
};
