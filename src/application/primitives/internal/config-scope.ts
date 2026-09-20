import type { ConfigScope } from '../../../domain/commands/config-key.js';
import {
  configScopeNotAvailable,
  configSystemPathUnresolved,
} from '../../../domain/commands/error.js';
import type { IniSection } from '../../../domain/config/config-ini.js';
import { TsgitError } from '../../../domain/error.js';
import type { Context } from '../../../ports/context.js';
import { commonGitDir } from '../path-layout.js';
import { layoutFailsAcceptance } from './layout-verdict.js';

/**
 * Canonical read precedence: later scopes override earlier ones for a given
 * key. Used by `mergeConfigsByScope`.
 */
export const SCOPE_ORDER: ReadonlyArray<ConfigScope> = ['system', 'global', 'local', 'worktree'];

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
 * Resolve the on-disk path for the per-worktree config scope. Takes the
 * `active` verdict (git's `[extensions] worktreeConfig` boolean) from its
 * caller rather than computing it: the predicate now lives in
 * `config-scoped-read.ts`, next to the cached local-scope read it shares —
 * importing it back here would close an import cycle
 * (`config-scoped-read.ts` already imports THIS module for `resolveScopePath`
 * / `mergeConfigsByScope`; depcruise's `no-circular` rule is enforced).
 *
 * A refused repository and an unset extension both make the scope
 * unavailable, but they are different facts and the payload must say which:
 * reporting a refused repository as "extension unset" would send a caller
 * looking for a config key that was never read.
 */
export const resolveWorktreeScopePath = (
  ctx: Context,
  { active }: { readonly active: boolean },
): string => {
  if (layoutFailsAcceptance(ctx.layout)) {
    throw configScopeNotAvailable('worktree', 'repository-not-accepted');
  }
  if (!active) {
    throw configScopeNotAvailable('worktree', 'worktree-extension-unset');
  }
  return `${ctx.layout.gitDir}/config.worktree`;
};

/**
 * Resolve the on-disk path for a config scope OTHER than `'worktree'` (see
 * {@link resolveWorktreeScopePath} for that one). Returns the path even if
 * the file does not yet exist (writes target it). Throws when the scope is
 * unavailable on this adapter or platform.
 */
export const resolveScopePath = async (
  ctx: Context,
  scope: Exclude<ConfigScope, 'worktree'>,
): Promise<string> => {
  if (scope === 'local') return `${commonGitDir(ctx)}/config`;
  if (scope === 'global') {
    const xdg = callAdapterPath('global', () => ctx.fs.xdgConfigHome());
    const home = callAdapterPath('global', () => ctx.fs.homedir());
    const xdgPath = `${xdg}/git/config`;
    if (await exists(ctx, xdgPath)) return xdgPath;
    const homePath = `${home}/.gitconfig`;
    // Stryker disable next-line ConditionalExpression: equivalent — the guarded branch and the fall-through both `return homePath`, so the guard's truth value cannot change the result (~/.gitconfig is the canonical write target whether or not it already exists).
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
