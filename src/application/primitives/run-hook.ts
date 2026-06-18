import { hookFailed } from '../../domain/commands/error.js';
import type { HookName } from '../../domain/hooks/index.js';
import type { Context, RepositoryLayout } from '../../ports/context.js';
import type { HookRequest, HookResult } from '../../ports/hook-runner.js';
import { readConfig } from './config-read.js';
import { joinPath } from './internal/join-working-tree-path.js';
import { assertNoValuelessConfig } from './internal/valueless-config-guard.js';

const HOOKS_SUBDIR = 'hooks';

/**
 * Sentinel subdirectory an empty (`''`) `core.hooksPath` resolves to. git never
 * creates it, so every `${dir}/<hook>` lookup misses and no hook ever fires —
 * git's "empty hooksPath ⇒ feature-off" without re-enabling the default-dir
 * hook (absent) or a worktree-root one (CWD).
 */
export const NO_HOOKS_SUBDIR = '.tsgit-no-hooks';

/** True for a POSIX-absolute (`/…`) or Windows-absolute (`C:\…`) path. */
const isAbsolutePath = (path: string): boolean =>
  path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);

/**
 * Resolve the directory hook scripts live in: `core.hooksPath` when set, else
 * `${gitDir}/hooks`. An absolute `hooksPath` is used verbatim; a `~/`-prefixed
 * one expands against `layout.homeDir` (falling back to the default when no
 * home is known); a relative one resolves against the working-tree root. An
 * empty `hooksPath` is feature-off — distinct from absent (which fires the
 * default dir) — so it resolves to a reserved no-hooks sentinel directory.
 */
export const resolveHooksDir = (
  hooksPath: string | undefined,
  layout: RepositoryLayout,
): string => {
  const fallback = `${layout.gitDir}/${HOOKS_SUBDIR}`;
  if (hooksPath === undefined) return fallback;
  if (hooksPath === '') return `${layout.gitDir}/${NO_HOOKS_SUBDIR}`;
  if (hooksPath.startsWith('~/')) {
    return layout.homeDir === undefined ? fallback : `${layout.homeDir}/${hooksPath.slice(2)}`;
  }
  if (isAbsolutePath(hooksPath)) return hooksPath;
  return joinPath(layout.workDir, hooksPath);
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
 * layer exit-code policy on top of. Refuses a present-but-valueless
 * `core.hooksPath` at the point the hooks dir is resolved (mirroring git's
 * `find_hook` death), before any hook file is looked up.
 */
const invokeHook = async (
  ctx: Context,
  name: HookName,
  input: HookInput,
): Promise<HookResult | undefined> => {
  const runner = ctx.hooks;
  if (runner === undefined) return undefined;
  await assertNoValuelessConfig(ctx, 'core', undefined, ['hookspath']);
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
