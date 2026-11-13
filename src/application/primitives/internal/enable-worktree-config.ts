/**
 * Turn the per-worktree config layer on the way git's `init_worktree_config`
 * does: extension first, then `core.worktree` moves to the main worktree's
 * `config.worktree`, then it leaves the shared local file. The move target is
 * the common dir even from a linked worktree because `core.worktree` describes
 * the main worktree.
 */
import type { Context } from '../../../ports/context.js';
import { getAllConfigValues, isWorktreeScopeActive } from '../config-scoped-read.js';
import { commonGitDir } from '../path-layout.js';
import {
  unsetAllConfigEntries,
  updateConfigFileEntries,
  updateScopedConfigEntries,
} from '../update-config.js';

const EXTENSION_ENTRY = { section: 'extensions', key: 'worktreeConfig', value: 'true' } as const;

const relocateCoreWorktree = async (ctx: Context): Promise<void> => {
  const { values } = await getAllConfigValues({ ctx, key: 'core.worktree', scope: 'local' });
  const value = values.at(-1)?.value;
  if (typeof value !== 'string') return;
  await updateConfigFileEntries(ctx, `${commonGitDir(ctx)}/config.worktree`, [
    { section: 'core', key: 'worktree', value },
  ]);
  await unsetAllConfigEntries({ ctx, key: 'core.worktree', scope: 'local' });
};

export const enableWorktreeConfig = async (ctx: Context): Promise<void> => {
  if (await isWorktreeScopeActive(ctx)) return;
  await updateScopedConfigEntries(ctx, 'local', [EXTENSION_ENTRY]);
  await relocateCoreWorktree(ctx);
};
