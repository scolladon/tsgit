import type { ConfigScope } from '../../../domain/commands/config-key.js';
import {
  configScopeNotAvailable,
  configSystemPathUnresolved,
} from '../../../domain/commands/error.js';
import { TsgitError } from '../../../domain/error.js';
import type { Context } from '../../../ports/context.js';
import type { IniSection } from '../../primitives/config-read.js';
import { parseIniSections } from '../../primitives/config-read.js';

/**
 * Canonical read precedence: later scopes override earlier ones for a given
 * key. Used by `mergeConfigsByScope`.
 */
export const SCOPE_ORDER: ReadonlyArray<ConfigScope> = ['system', 'global', 'local', 'worktree'];

const safeReadUtf8 = async (ctx: Context, path: string): Promise<string | undefined> => {
  try {
    return await ctx.fs.readUtf8(path);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return undefined;
    throw err;
  }
};

const exists = async (ctx: Context, path: string): Promise<boolean> => {
  try {
    return await ctx.fs.exists(path);
  } catch {
    return false;
  }
};

const callAdapterPath = (scope: ConfigScope, fn: () => string): string => {
  try {
    return fn();
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'UNSUPPORTED_OPERATION') {
      throw configScopeNotAvailable(scope, 'browser-adapter');
    }
    throw err;
  }
};

/**
 * True iff the local config has `[extensions] worktreeConfig = true`, the gate
 * for the per-worktree config file at `${gitDir}/config.worktree`.
 */
export const isWorktreeScopeActive = async (ctx: Context): Promise<boolean> => {
  const text = await safeReadUtf8(ctx, `${ctx.layout.gitDir}/config`);
  if (text === undefined) return false;
  const sections = parseIniSections(text);
  for (const section of sections) {
    if (section.section.toLowerCase() !== 'extensions') continue;
    if (section.subsection !== undefined) continue;
    for (const entry of section.entries) {
      if (entry.key.toLowerCase() !== 'worktreeconfig') continue;
      return entry.value === 'true';
    }
  }
  return false;
};

/**
 * Resolve the on-disk path for a config scope. Returns the path even if the
 * file does not yet exist (writes target it). Throws when the scope is
 * unavailable on this adapter or platform.
 */
export const resolveScopePath = async (ctx: Context, scope: ConfigScope): Promise<string> => {
  if (scope === 'local') return `${ctx.layout.gitDir}/config`;
  if (scope === 'worktree') {
    if (!(await isWorktreeScopeActive(ctx))) {
      throw configScopeNotAvailable('worktree', 'worktree-extension-unset');
    }
    return `${ctx.layout.gitDir}/config.worktree`;
  }
  if (scope === 'global') {
    const xdg = callAdapterPath('global', () => ctx.fs.xdgConfigHome());
    const home = callAdapterPath('global', () => ctx.fs.homedir());
    const xdgPath = `${xdg}/git/config`;
    if (await exists(ctx, xdgPath)) return xdgPath;
    const homePath = `${home}/.gitconfig`;
    if (await exists(ctx, homePath)) return homePath;
    return homePath;
  }
  const systemPath = callAdapterPath('system', () => ctx.fs.systemConfigPath());
  if (systemPath.length === 0) throw configSystemPathUnresolved();
  return systemPath;
};

/**
 * Flatten a per-scope sections array into scope-precedence order. Within each
 * scope, physical (file) order is preserved.
 */
export const mergeConfigsByScope = (
  scoped: ReadonlyArray<{
    readonly scope: ConfigScope;
    readonly sections: ReadonlyArray<IniSection>;
  }>,
): ReadonlyArray<{ readonly scope: ConfigScope; readonly section: IniSection }> => {
  const byScope = new Map<ConfigScope, ReadonlyArray<IniSection>>();
  for (const { scope, sections } of scoped) byScope.set(scope, sections);
  const out: Array<{ scope: ConfigScope; section: IniSection }> = [];
  for (const scope of SCOPE_ORDER) {
    const sections = byScope.get(scope);
    if (sections === undefined) continue;
    for (const section of sections) out.push({ scope, section });
  }
  return out;
};
