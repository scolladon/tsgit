/**
 * Resolve the two sparse keys across the config layers git consults: the
 * per-worktree `config.worktree` (when `extensions.worktreeConfig` is on)
 * overrides the shared local file, key by key.
 */
import { type IniSection, parseGitBoolean } from '../../domain/config/config-ini.js';
import type { Context } from '../../ports/context.js';
import { findLastEntry, readConfig } from './config-read.js';
import { readActiveWorktreeSections } from './config-scoped-read.js';
import { layoutFailsAcceptance } from './internal/layout-verdict.js';

export interface SparseConfig {
  readonly enabled: boolean;
  readonly cone: boolean;
}

interface WorktreeSparseKeys {
  readonly enabled?: boolean | undefined;
  readonly cone?: boolean | undefined;
}

/** One sparse key as written in `config.worktree`, key lower-cased. */
export interface SparseKeyEntry {
  readonly key: string;
  readonly value: string | null;
}

const CORE_SECTION = 'core';
const ENABLED_KEY = 'sparsecheckout';
const CONE_KEY = 'sparsecheckoutcone';
const SPARSE_KEYS: ReadonlySet<string> = new Set([ENABLED_KEY, CONE_KEY]);

/** Every sparse-key entry under a subsectionless `[core]`, in file order. */
export const sparseKeyEntries = (
  sections: ReadonlyArray<IniSection>,
): ReadonlyArray<SparseKeyEntry> =>
  sections
    .filter((section) => section.section.toLowerCase() === CORE_SECTION)
    .filter((section) => section.subsection === undefined)
    .flatMap((section) => section.entries)
    .map((entry) => ({ key: entry.key.toLowerCase(), value: entry.value }))
    .filter((entry) => SPARSE_KEYS.has(entry.key));

const lastValidBoolean = (
  entries: ReadonlyArray<SparseKeyEntry>,
  wanted: string,
): boolean | undefined =>
  entries
    .filter((entry) => entry.key === wanted)
    .map((entry) => parseGitBoolean(entry.value))
    .flatMap((parsed) => (parsed.ok ? [parsed.value] : []))
    .at(-1);

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
  const entries = sparseKeyEntries(await readActiveWorktreeSections(ctx));
  return {
    enabled: lastValidBoolean(entries, ENABLED_KEY),
    cone: lastValidBoolean(entries, CONE_KEY),
  };
};

export const readSparseConfig = async (ctx: Context): Promise<SparseConfig> => {
  const local = await readConfig(ctx);
  const worktree = await readWorktreeKeys(ctx);
  return {
    enabled: worktree.enabled ?? local.core?.sparseCheckout ?? false,
    cone: worktree.cone ?? local.core?.sparseCheckoutCone ?? false,
  };
};
