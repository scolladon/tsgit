import {
  configBadBooleanValue,
  configBadNumericValue,
  configMissingValue,
  configUnknownValue,
} from '../../../domain/commands/error.js';
import {
  GIT_C_INT_MAX,
  GIT_C_INT_MIN,
  parseGitBoolean,
  parseGitInt,
} from '../../../domain/config/config-ini.js';
import type { DiffAlgorithm } from '../../../domain/diff/line-diff.js';
import type { DirectoryRenameMode } from '../../../domain/merge/directory-renames.js';
import { diffAlgorithmValue } from '../../../domain/merge/strategy-options.js';
import type { Context } from '../../../ports/context.js';
import { findLastEntry, type LocatedConfigEntry } from '../config-read.js';

/** git's ort fallback when no positive rename limit is configured. */
const DEFAULT_MERGE_RENAME_LIMIT = 7000;

const COPY_WORDS = new Set(['copies', 'copy']);

export interface MergeRenameConfig {
  readonly detect: boolean;
  readonly limit: number;
  readonly directoryRenames: DirectoryRenameMode;
}

type Located = LocatedConfigEntry & { readonly value: string };

const requireValue = (entry: LocatedConfigEntry): Located => {
  if (entry.value === null) throw configMissingValue(entry.key, entry.source, entry.line);
  return entry as Located;
};

/** git's `git_config_int`: dies on a value outside the C `int` grammar. */
const parseLimit = (entry: LocatedConfigEntry | undefined): number | undefined => {
  if (entry === undefined) return undefined;
  const { key, source, value } = requireValue(entry);
  const parsed = parseGitInt(value);
  if (!parsed.ok) throw configBadNumericValue(key, source, value, parsed.reason);
  if (parsed.value < GIT_C_INT_MIN || parsed.value > GIT_C_INT_MAX) {
    throw configBadNumericValue(key, source, value, 'out of range');
  }
  return parsed.value;
};

/** git's `git_config_rename`: `copies` / `copy` detect (merge never copies), else a boolean. */
const parseRenames = (entry: LocatedConfigEntry | undefined): boolean | undefined => {
  if (entry === undefined) return undefined;
  const { key, source, value } = requireValue(entry);
  if (COPY_WORDS.has(value.toLowerCase())) return true;
  const parsed = parseGitBoolean(value);
  if (!parsed.ok) throw configBadBooleanValue(key, source, value);
  return parsed.value;
};

/**
 * `merge.directoryRenames`: a boolean applies or skips them; `conflict` — and,
 * as git tolerates values from future versions, anything else — keeps the default.
 */
const parseDirectoryRenames = (entry: LocatedConfigEntry | undefined): DirectoryRenameMode => {
  if (entry === undefined) return 'conflict';
  const parsed = parseGitBoolean(requireValue(entry).value);
  if (!parsed.ok) return 'conflict';
  return parsed.value ? 'apply' : 'none';
};

/**
 * git's `merge_recursive_config` for renames: `merge.renameLimit` over
 * `diff.renameLimit` (a non-positive limit is ort's 7000), `merge.renames`
 * over `diff.renames` (on by default) — parsed in git's order, so the first
 * malformed key is the one refused.
 */
export const readMergeRenameConfig = async (ctx: Context): Promise<MergeRenameConfig> => {
  const diffLimit = parseLimit(await findLastEntry(ctx, 'diff', 'renameLimit'));
  const mergeLimit = parseLimit(await findLastEntry(ctx, 'merge', 'renameLimit'));
  const diffRenames = parseRenames(await findLastEntry(ctx, 'diff', 'renames'));
  const mergeRenames = parseRenames(await findLastEntry(ctx, 'merge', 'renames'));
  const directoryRenames = parseDirectoryRenames(
    await findLastEntry(ctx, 'merge', 'directoryRenames'),
  );
  const limit = mergeLimit ?? diffLimit ?? 0;
  return {
    detect: mergeRenames ?? diffRenames ?? true,
    limit: limit > 0 ? limit : DEFAULT_MERGE_RENAME_LIMIT,
    directoryRenames,
  };
};

/**
 * merge-ort's `merge_recursive_config` for a porcelain (`ui`) merge:
 * `diff.algorithm` replaces ort's histogram, and a name git does not know dies.
 */
export const readUiDiffAlgorithm = async (ctx: Context): Promise<DiffAlgorithm | undefined> => {
  const entry = await findLastEntry(ctx, 'diff', 'algorithm');
  if (entry === undefined) return undefined;
  const { key, source, value, line } = requireValue(entry);
  const algorithm = diffAlgorithmValue(value);
  if (algorithm === undefined) throw configUnknownValue(key, value, source, line);
  return algorithm;
};
