/**
 * The repo-settings class (git's `prepare_repo_settings`, `repo-settings.c`):
 * its booleans (`feature.*`, `core.commitGraph`, … `core.useReplaceRefs`),
 * `core.maxTreeDepth`, `core.deltaBaseCacheLimit`, then
 * `core.packedGitWindowSize` and `core.packedGitLimit`. Git reads these keys
 * in that one function and nowhere else — a command dies on
 * a malformed value iff it reaches the object store, the index, a
 * commit-graph/midx/bitmap load, or one of four builtins that call the
 * function in their own prologue.
 *
 * `assertRepoSettingsValid` is called from those structural boundaries plus
 * explicit calls transcribing git's own per-builtin sites — never from the
 * eager operational gate, which is a different tier validating a different
 * set of `[core]` classes.
 */
import { configBadBooleanValue, configBadNumericValue } from '../../../domain/commands/error.js';
import { parseGitBoolean } from '../../../domain/config/config-ini.js';
import type { Context } from '../../../ports/context.js';
import {
  findLastEntries,
  findLastInvalidBigFileThreshold,
  findLastInvalidDeltaBaseCacheLimit,
  findLastInvalidMaxTreeDepth,
  findLastInvalidPackedGitBound,
  type LocatedConfigEntry,
  memoizeRepoSettingsVerdict,
} from '../config-read.js';

/** The booleans `prepare_repo_settings` reads first, in its order (repo-settings.c:49-86). */
const REPO_SETTINGS_BOOLEANS: ReadonlyArray<readonly [section: string, key: string]> = [
  ['feature', 'manyFiles'],
  ['feature', 'experimental'],
  ['core', 'commitGraph'],
  ['commitGraph', 'readChangedPaths'],
  ['gc', 'writeCommitGraph'],
  ['fetch', 'writeCommitGraph'],
  ['pack', 'useSparse'],
  ['pack', 'usePathWalk'],
  ['core', 'multiPackIndex'],
  ['index', 'sparse'],
  ['index', 'skipHash'],
  ['pack', 'readReverseIndex'],
  ['pack', 'useBitmapBoundaryTraversal'],
  ['core', 'useReplaceRefs'],
];

/** git's `repo_cfg_bool`: the first key whose last value its boolean grammar refuses. */
const findInvalidRepoSettingsBoolean = async (
  ctx: Context,
): Promise<LocatedConfigEntry | undefined> =>
  (await findLastEntries(ctx, REPO_SETTINGS_BOOLEANS)).find(
    (last) => last?.value != null && !parseGitBoolean(last.value).ok,
  );

/** git's `prepare_repo_settings` (repo-settings.c): the class's keys, in its own reading order. */
const computeRepoSettingsVerdict = async (ctx: Context): Promise<void> => {
  const [boolean, maxTreeDepth, deltaBaseCacheLimit, packedGitBound] = await Promise.all([
    findInvalidRepoSettingsBoolean(ctx), // repo-settings.c:49-86
    findLastInvalidMaxTreeDepth(ctx), // repo-settings.c:103
    ctx.cacheBudgets?.deltaBaseCacheMaxBytes === undefined // an option-overridden file value is never validated
      ? findLastInvalidDeltaBaseCacheLimit(ctx) // repo-settings.c:142
      : undefined,
    findLastInvalidPackedGitBound(ctx), // repo-settings.c:145, :155
  ]);
  if (boolean?.value != null)
    throw configBadBooleanValue(boolean.key, boolean.source, boolean.value);
  const invalid = maxTreeDepth ?? deltaBaseCacheLimit ?? packedGitBound; // in-function order
  if (invalid !== undefined) {
    throw configBadNumericValue(invalid.key, invalid.source, invalid.value, invalid.reason);
  }
};

/**
 * The class's refusal. Memoised per session (single-flight; a rejection is
 * never cached) so a command's second, third … boundary touch costs a
 * WeakMap hit — dropped by `invalidateConfigCache`.
 */
export const assertRepoSettingsValid = (ctx: Context): Promise<void> =>
  memoizeRepoSettingsVerdict(ctx, computeRepoSettingsVerdict);

/**
 * git's `repo_settings_get_big_file_threshold`: read lazily, the first time a
 * command reads or writes an object's content past the threshold's reach —
 * not with the rest of the class, so a command that never does (`log`,
 * `cat-file`, `fsck --connectivity-only`) never refuses on it.
 */
export const assertBigFileThresholdValid = async (ctx: Context): Promise<void> => {
  const invalid = await findLastInvalidBigFileThreshold(ctx);
  if (invalid !== undefined) {
    throw configBadNumericValue(invalid.key, invalid.source, invalid.value, invalid.reason);
  }
};

export { repoSettingsVerdictSettled } from '../config-read.js';
