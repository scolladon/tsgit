/**
 * Turn the per-worktree config layer on the way git's `init_worktree_config`
 * does: extension first, then `core.bare` (when true) and `core.worktree`
 * move to the main worktree's `config.worktree` and leave the shared local
 * file. The move target is the common dir even from a linked worktree because
 * both keys describe the main worktree. Each move writes before it unsets, and
 * the unset refuses a key set more than once, as git's does.
 */
import { parseGitBoolean } from '../../../domain/config/config-ini.js';
import type { Context } from '../../../ports/context.js';
import { getAllConfigValues, isWorktreeScopeActive } from '../config-scoped-read.js';
import { commonGitDir } from '../path-layout.js';
import {
  unsetConfigEntry,
  updateConfigFileEntries,
  updateScopedConfigEntries,
} from '../update-config.js';

const EXTENSION_ENTRY = { section: 'extensions', key: 'worktreeConfig', value: 'true' } as const;
const CORE_SECTION = 'core';

const lastLocalValue = async (ctx: Context, key: string): Promise<string | null | undefined> => {
  const { values } = await getAllConfigValues({
    ctx,
    key: `${CORE_SECTION}.${key}`,
    scope: 'local',
  });
  return values.at(-1)?.value;
};

const moveSetting = async (ctx: Context, key: string, value: string): Promise<void> => {
  await updateConfigFileEntries(ctx, `${commonGitDir(ctx)}/config.worktree`, [
    { section: CORE_SECTION, key, value },
  ]);
  await unsetConfigEntry({ ctx, key: `${CORE_SECTION}.${key}`, scope: 'local' });
};

const relocateCoreBare = async (ctx: Context): Promise<void> => {
  const value = await lastLocalValue(ctx, 'bare');
  if (value === undefined) return;
  const parsed = parseGitBoolean(value);
  if (!(parsed.ok && parsed.value)) return;
  await moveSetting(ctx, 'bare', 'true');
};

const relocateCoreWorktree = async (ctx: Context): Promise<void> => {
  const value = await lastLocalValue(ctx, 'worktree');
  if (typeof value !== 'string') return;
  await moveSetting(ctx, 'worktree', value);
};

export const enableWorktreeConfig = async (ctx: Context): Promise<void> => {
  if (await isWorktreeScopeActive(ctx)) return;
  await updateScopedConfigEntries(ctx, 'local', [EXTENSION_ENTRY]);
  await relocateCoreBare(ctx);
  await relocateCoreWorktree(ctx);
};
