/**
 * Resolve git's `core.fileMode`: the per-worktree `config.worktree`, when
 * `extensions.worktreeConfig` is on, overrides the shared local file.
 */
import type { ExecutableBitTrust } from '../../domain/objects/file-mode.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from './config-read.js';
import { readActiveWorktreeSections } from './config-scoped-read.js';
import {
  coreKeyEntries,
  isWorktreeConfigExtensionOn,
  lastValidBoolean,
} from './read-sparse-config.js';

const FILE_MODE_KEY = 'filemode';
const FILE_MODE_KEYS: ReadonlySet<string> = new Set([FILE_MODE_KEY]);
const TRUSTED_BY_DEFAULT = true;

const readWorktreeFileMode = async (ctx: Context): Promise<boolean | undefined> => {
  if (!(await isWorktreeConfigExtensionOn(ctx))) return undefined;
  const entries = coreKeyEntries(await readActiveWorktreeSections(ctx), FILE_MODE_KEYS);
  return lastValidBoolean(entries, FILE_MODE_KEY);
};

export const readExecutableBitTrust = async (ctx: Context): Promise<ExecutableBitTrust> => {
  const worktree = await readWorktreeFileMode(ctx);
  const local = (await readConfig(ctx)).core?.fileMode;
  return (worktree ?? local ?? TRUSTED_BY_DEFAULT) ? 'trusted' : 'ignored';
};
