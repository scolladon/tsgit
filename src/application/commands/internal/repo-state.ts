/**
 * @deprecated — Source of truth moved to `primitives/internal/repo-state.ts`.
 * This shim keeps the existing command imports working; new callers should
 * import from the primitives location.
 */
import type { Context } from '../../../ports/context.js';
import { assertRepository } from '../../primitives/internal/repo-state.js';
import { assertNoValuelessCoreConfig } from './valueless-config-guard.js';

export {
  assertNoPendingOperation,
  assertNotBare,
  assertRepository,
  isBare,
  readHeadRaw,
} from '../../primitives/internal/repo-state.js';

/**
 * Every command's leading guard pair: confirm the repository exists, then refuse
 * an eager-resolved valueless `core.*` path key — reproducing git's
 * `git_default_core_config` die. Repo check first so a non-repo fails as
 * `NOT_A_REPOSITORY` before the config is consulted.
 */
export const assertCommandPreamble = async (ctx: Context): Promise<void> => {
  await assertRepository(ctx);
  await assertNoValuelessCoreConfig(ctx);
};
