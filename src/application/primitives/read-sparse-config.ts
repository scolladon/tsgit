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

/** One `[core]` entry as written in a config file, key lower-cased. */
export interface CoreKeyEntry {
  readonly key: string;
  readonly value: string | null;
}

const CORE_SECTION = 'core';
const ENABLED_KEY = 'sparsecheckout';
const CONE_KEY = 'sparsecheckoutcone';
const SPARSE_KEYS: ReadonlySet<string> = new Set([ENABLED_KEY, CONE_KEY]);

/** Every wanted-key entry under a subsectionless `[core]`, in file order. */
export const coreKeyEntries = (
  sections: ReadonlyArray<IniSection>,
  keys: ReadonlySet<string>,
): ReadonlyArray<CoreKeyEntry> =>
  sections
    .filter((section) => section.section.toLowerCase() === CORE_SECTION)
    .filter((section) => section.subsection === undefined)
    .flatMap((section) => section.entries)
    .map((entry) => ({ key: entry.key.toLowerCase(), value: entry.value }))
    .filter((entry) => keys.has(entry.key));

export type SparseKeyEntry = CoreKeyEntry;

export const sparseKeyEntries = (
  sections: ReadonlyArray<IniSection>,
): ReadonlyArray<SparseKeyEntry> => coreKeyEntries(sections, SPARSE_KEYS);

/** The last entry for `wanted` that parses as a git boolean; invalid entries are skipped. */
export const lastValidBoolean = (
  entries: ReadonlyArray<CoreKeyEntry>,
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
  const entries = coreKeyEntries(await readActiveWorktreeSections(ctx), SPARSE_KEYS);
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
