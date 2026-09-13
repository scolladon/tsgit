/**
 * The repo-settings class (git's `prepare_repo_settings`, `repo-settings.c`):
 * `core.maxTreeDepth` and, from commit 2, `core.deltaBaseCacheLimit`. Git
 * reads both keys in that one function and nowhere else — a command dies on
 * a malformed value iff it reaches the object store, the index, a
 * commit-graph/midx/bitmap load, or one of four builtins that call the
 * function in their own prologue.
 *
 * `assertRepoSettingsValid` is called from those structural boundaries plus
 * explicit calls transcribing git's own per-builtin sites — never from the
 * eager operational gate, which is a different tier validating a different
 * set of `[core]` classes.
 */
import { configBadNumericValue } from '../../../domain/commands/error.js';
import type { Context } from '../../../ports/context.js';
import { findLastInvalidMaxTreeDepth, memoizeRepoSettingsVerdict } from '../config-read.js';

/** git's `prepare_repo_settings` (repo-settings.c): the class's keys, in its own reading order. */
const computeRepoSettingsVerdict = async (ctx: Context): Promise<void> => {
  const maxTreeDepth = await findLastInvalidMaxTreeDepth(ctx); // repo-settings.c:103
  if (maxTreeDepth !== undefined) {
    throw configBadNumericValue(
      maxTreeDepth.key,
      maxTreeDepth.source,
      maxTreeDepth.value,
      maxTreeDepth.reason,
    );
  }
};

/**
 * The class's refusal. Memoised per session (single-flight; a rejection is
 * never cached) so a command's second, third … boundary touch costs a
 * WeakMap hit — dropped by `invalidateConfigCache`.
 */
export const assertRepoSettingsValid = (ctx: Context): Promise<void> =>
  memoizeRepoSettingsVerdict(ctx, computeRepoSettingsVerdict);

export { repoSettingsVerdictSettled } from '../config-read.js';
