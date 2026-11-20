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
  readonly expectFilesOutsideOfPatterns: boolean;
}

interface WorktreeSparseKeys {
  readonly enabled?: boolean | undefined;
  readonly cone?: boolean | undefined;
  readonly expectFilesOutsideOfPatterns?: boolean | undefined;
}

/** One entry as written in a config file, key lower-cased. */
export interface CoreKeyEntry {
  readonly key: string;
  readonly value: string | null;
}

const CORE_SECTION = 'core';
const ENABLED_KEY = 'sparsecheckout';
const CONE_KEY = 'sparsecheckoutcone';
const SPARSE_KEYS: ReadonlySet<string> = new Set([ENABLED_KEY, CONE_KEY]);
const SPARSE_SECTION = 'sparse';
const EXPECT_FILES_KEY = 'expectfilesoutsideofpatterns';
const EXPECT_FILES_KEYS: ReadonlySet<string> = new Set([EXPECT_FILES_KEY]);

/** Every wanted-key entry under a subsectionless `[<section>]`, in file order. */
export const sectionKeyEntries = (
  sections: ReadonlyArray<IniSection>,
  wantedSection: string,
  keys: ReadonlySet<string>,
): ReadonlyArray<CoreKeyEntry> =>
  sections
    .filter((section) => section.section.toLowerCase() === wantedSection)
    .filter((section) => section.subsection === undefined)
    .flatMap((section) => section.entries)
    .map((entry) => ({ key: entry.key.toLowerCase(), value: entry.value }))
    .filter((entry) => keys.has(entry.key));

/** Every wanted-key entry under a subsectionless `[core]`, in file order. */
export const coreKeyEntries = (
  sections: ReadonlyArray<IniSection>,
  keys: ReadonlySet<string>,
): ReadonlyArray<CoreKeyEntry> => sectionKeyEntries(sections, CORE_SECTION, keys);

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
  const sections = await readActiveWorktreeSections(ctx);
  const entries = coreKeyEntries(sections, SPARSE_KEYS);
  const expectEntries = sectionKeyEntries(sections, SPARSE_SECTION, EXPECT_FILES_KEYS);
  return {
    enabled: lastValidBoolean(entries, ENABLED_KEY),
    cone: lastValidBoolean(entries, CONE_KEY),
    expectFilesOutsideOfPatterns: lastValidBoolean(expectEntries, EXPECT_FILES_KEY),
  };
};

/** An invalid local value is inert here: the operational gate refuses it first. */
const readLocalExpectFiles = async (ctx: Context): Promise<boolean | undefined> => {
  const entry = await findLastEntry(ctx, SPARSE_SECTION, 'expectFilesOutsideOfPatterns');
  if (entry === undefined) return undefined;
  const parsed = parseGitBoolean(entry.value);
  return parsed.ok ? parsed.value : undefined;
};

export const readSparseConfig = async (ctx: Context): Promise<SparseConfig> => {
  const local = await readConfig(ctx);
  const worktree = await readWorktreeKeys(ctx);
  return {
    enabled: worktree.enabled ?? local.core?.sparseCheckout ?? false,
    cone: worktree.cone ?? local.core?.sparseCheckoutCone ?? false,
    expectFilesOutsideOfPatterns:
      worktree.expectFilesOutsideOfPatterns ?? (await readLocalExpectFiles(ctx)) ?? false,
  };
};
