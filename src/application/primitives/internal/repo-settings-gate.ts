/**
 * The repo-settings class (git's `prepare_repo_settings`, `repo-settings.c`):
 * its booleans (`feature.*`, `core.commitGraph`, … `core.useReplaceRefs`)
 * with `commitGraph.generationVersion` and `commitGraph.changedPathsVersion` among them,
 * `index.version`, `core.maxTreeDepth`, `fetch.negotiationAlgorithm`, `core.deltaBaseCacheLimit`, then
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
import {
  configBadBooleanValue,
  configBadNumericValue,
  configMissingValue,
  configUnknownNegotiationAlgorithm,
} from '../../../domain/commands/error.js';
import { parseGitBoolean } from '../../../domain/config/config-ini.js';
import type { TsgitError } from '../../../domain/error.js';
import type { Context } from '../../../ports/context.js';
import {
  findLastEntries,
  findLastEntry,
  findLastInvalidBigFileThreshold,
  findLastInvalidDeltaBaseCacheLimit,
  findLastInvalidMaxTreeDepth,
  findLastInvalidPackedGitBound,
  findLastInvalidRepoInt,
  type InvalidNumericEntry,
  type LocatedConfigEntry,
  memoizeRepoSettingsVerdict,
} from '../config-read.js';

type ConfigKey = readonly [section: string, key: string];

/** The booleans `prepare_repo_settings` reads before `commitGraph.generationVersion`. */
const LEADING_BOOLEANS: ReadonlyArray<ConfigKey> = [
  ['feature', 'manyFiles'],
  ['feature', 'experimental'],
  ['core', 'commitGraph'],
];

/** The boolean it reads between `generationVersion` and `changedPathsVersion`. */
const CHANGED_PATHS_BOOLEANS: ReadonlyArray<ConfigKey> = [['commitGraph', 'readChangedPaths']];

/** The booleans it reads after `changedPathsVersion`, in its order (repo-settings.c:73-86). */
const TRAILING_BOOLEANS: ReadonlyArray<ConfigKey> = [
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
const booleanRefusal = async (
  ctx: Context,
  keys: ReadonlyArray<ConfigKey>,
): Promise<TsgitError | undefined> => {
  const invalid = (await findLastEntries(ctx, keys)).find(
    (last): last is LocatedConfigEntry & { readonly value: string } =>
      last?.value != null && !parseGitBoolean(last.value).ok,
  );
  return invalid && configBadBooleanValue(invalid.key, invalid.source, invalid.value);
};

const numericRefusal = (invalid: InvalidNumericEntry | undefined): TsgitError | undefined =>
  invalid && configBadNumericValue(invalid.key, invalid.source, invalid.value, invalid.reason);

/** The values `fetch.negotiationAlgorithm` names, matched case-insensitively (`strcasecmp`). */
const NEGOTIATION_ALGORITHMS: ReadonlySet<string> = new Set([
  'skipping',
  'noop',
  'consecutive',
  'default',
]);

/** git's `repo_config_get_string_tmp` + its algorithm `die` (repo-settings.c:120-133). */
const negotiationAlgorithmRefusal = async (ctx: Context): Promise<TsgitError | undefined> => {
  const last = await findLastEntry(ctx, 'fetch', 'negotiationAlgorithm');
  if (last === undefined) return undefined;
  if (last.value === null) return configMissingValue(last.key, last.source, last.line);
  if (NEGOTIATION_ALGORITHMS.has(last.value.toLowerCase())) return undefined;
  return configUnknownNegotiationAlgorithm(last.value);
};

/** git's `prepare_repo_settings` (repo-settings.c): the class's keys, in its own reading order. */
const computeRepoSettingsVerdict = async (ctx: Context): Promise<void> => {
  const refusals = await Promise.all([
    booleanRefusal(ctx, LEADING_BOOLEANS), // repo-settings.c:49-67
    findLastInvalidRepoInt(ctx, 'commitGraph', 'generationVersion').then(numericRefusal), // :68
    booleanRefusal(ctx, CHANGED_PATHS_BOOLEANS), // repo-settings.c:69
    findLastInvalidRepoInt(ctx, 'commitGraph', 'changedPathsVersion').then(numericRefusal), // :70
    booleanRefusal(ctx, TRAILING_BOOLEANS), // repo-settings.c:73-86
    findLastInvalidRepoInt(ctx, 'index', 'version').then(numericRefusal), // repo-settings.c:101
    findLastInvalidMaxTreeDepth(ctx).then(numericRefusal), // repo-settings.c:103
    negotiationAlgorithmRefusal(ctx), // repo-settings.c:120
    ctx.cacheBudgets?.deltaBaseCacheMaxBytes === undefined // an option-overridden file value is never validated
      ? findLastInvalidDeltaBaseCacheLimit(ctx).then(numericRefusal) // repo-settings.c:142
      : undefined,
    findLastInvalidPackedGitBound(ctx).then(numericRefusal), // repo-settings.c:145, :155
  ]);
  const first = refusals.find((refusal) => refusal !== undefined);
  if (first !== undefined) throw first;
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
