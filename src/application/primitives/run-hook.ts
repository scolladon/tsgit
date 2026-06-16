import { hookFailed } from '../../domain/commands/error.js';
import type { HookName } from '../../domain/hooks/index.js';
import type { Context, RepositoryLayout } from '../../ports/context.js';
import type { HookRequest, HookResult } from '../../ports/hook-runner.js';
import { readConfig } from './config-read.js';

const HOOKS_SUBDIR = 'hooks';

/**
 * Sentinel hooks dir for an empty `core.hooksPath`. git treats empty as
 * hooks-feature-off — no hook fires — which is distinct from both absent
 * (the `${gitDir}/hooks` default fires) and the worktree root (a CWD
 * `./pre-commit` must not fire). git never creates this dir under `${gitDir}`,
 * so `${gitDir}/${EMPTY_HOOKS_SENTINEL}/<hook>` cannot stat to a runnable
 * script: the runner skips and no hook fires.
 */
const EMPTY_HOOKS_SENTINEL = '.tsgit-no-hooks';

/** True for a POSIX-absolute (`/…`) or Windows-absolute (`C:\…`) path. */
const isAbsolutePath = (path: string): boolean =>
  path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);

/**
 * Resolve the directory hook scripts live in: `core.hooksPath` when set, else
 * `${gitDir}/hooks`. An empty `hooksPath` is hooks-feature-off (no hook fires),
 * resolving to a sentinel dir that holds no scripts — distinct from absent. An
 * absolute `hooksPath` is used verbatim; a `~/`-prefixed one expands against
 * `layout.homeDir` (falling back to the default when no home is known); a
 * relative one resolves against the working-tree root.
 */
export const resolveHooksDir = (
  hooksPath: string | undefined,
  layout: RepositoryLayout,
): string => {
  const fallback = `${layout.gitDir}/${HOOKS_SUBDIR}`;
  if (hooksPath === undefined) return fallback;
  if (hooksPath === '') return `${layout.gitDir}/${EMPTY_HOOKS_SENTINEL}`;
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
 * Resolve `ctx.hooks`, fill the `HookRequest` from `ctx.layout` + config, and
 * invoke the runner. Returns `undefined` when no runner is wired (browser, or
 * opted out); otherwise the raw `HookResult`. The shared chokepoint both the
 * blocking (`runHook`) and informational (`runInformationalHook`) entry points
 * layer exit-code policy on top of.
 */
const invokeHook = async (
  ctx: Context,
  name: HookName,
  input: HookInput,
): Promise<HookResult | undefined> => {
  const runner = ctx.hooks;
  if (runner === undefined) return undefined;
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
  return runner.run(request);
};

/**
 * Run a blocking git hook through `ctx.hooks`. A no-op when no `HookRunner` is
 * wired (browser, or opted out), when the hook file is absent / not executable
 * (`skipped`), or when the hook exits 0. Throws `HOOK_FAILED` on a non-zero
 * exit — the caller's signal to abort the operation.
 */
export const runHook = async (
  ctx: Context,
  name: HookName,
  input: HookInput = {},
): Promise<void> => {
  const result = await invokeHook(ctx, name, input);
  if (result === undefined || result.kind === 'skipped') return;
  if (result.exitCode !== 0) {
    throw hookFailed(name, result.exitCode, result.stderr);
  }
};

/**
 * Run an informational (`post-*`) git hook — fire-and-forget. The operation has
 * already completed, so git ignores a post-hook's exit code (it cannot abort);
 * tsgit does the same: absent runner, `skipped`, or any exit code → no throw,
 * no return value. The runner never rejects, so this only ever resolves.
 */
export const runInformationalHook = async (
  ctx: Context,
  name: HookName,
  input: HookInput = {},
): Promise<void> => {
  await invokeHook(ctx, name, input);
};
