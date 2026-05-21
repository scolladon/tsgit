import { hookFailed } from '../../domain/commands/error.js';
import type { HookName } from '../../domain/hooks/index.js';
import type { Context, RepositoryLayout } from '../../ports/context.js';
import type { HookRequest } from '../../ports/hook-runner.js';
import { readConfig } from './config-read.js';

const HOOKS_SUBDIR = 'hooks';

/** True for a POSIX-absolute (`/…`) or Windows-absolute (`C:\…`) path. */
const isAbsolutePath = (path: string): boolean =>
  path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);

/**
 * Resolve the directory hook scripts live in: `core.hooksPath` when set, else
 * `${gitDir}/hooks`. An absolute `hooksPath` is used verbatim; a `~/`-prefixed
 * one expands against `layout.homeDir` (falling back to the default when no
 * home is known); a relative one resolves against the working-tree root.
 */
export const resolveHooksDir = (
  hooksPath: string | undefined,
  layout: RepositoryLayout,
): string => {
  const fallback = `${layout.gitDir}/${HOOKS_SUBDIR}`;
  if (hooksPath === undefined) return fallback;
  if (hooksPath.startsWith('~/')) {
    return layout.homeDir === undefined ? fallback : `${layout.homeDir}/${hooksPath.slice(2)}`;
  }
  if (isAbsolutePath(hooksPath)) return hooksPath;
  return `${layout.workDir}/${hooksPath}`;
};

/** Optional arguments and stdin a caller threads into a hook invocation. */
export interface HookInput {
  readonly args?: ReadonlyArray<string>;
  readonly stdin?: string;
}

/**
 * Run a named git hook through `ctx.hooks`. A no-op when no `HookRunner` is
 * wired (browser, or opted out), when the hook file is absent / not executable
 * (`skipped`), or when the hook exits 0. Throws `HOOK_FAILED` on a non-zero
 * exit.
 */
export const runHook = async (
  ctx: Context,
  name: HookName,
  input: HookInput = {},
): Promise<void> => {
  const runner = ctx.hooks;
  if (runner === undefined) return;
  const config = await readConfig(ctx);
  const request: HookRequest = {
    name,
    hooksDir: resolveHooksDir(config.core?.hooksPath, ctx.layout),
    workDir: ctx.layout.workDir,
    gitDir: ctx.layout.gitDir,
    args: input.args ?? [],
    stdin: input.stdin ?? '',
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  };
  const result = await runner.run(request);
  if (result.kind === 'skipped') return;
  if (result.exitCode !== 0) {
    throw hookFailed(name, result.exitCode, result.stderr);
  }
};
