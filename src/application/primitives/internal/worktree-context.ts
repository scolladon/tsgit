import type { Context } from '../../../ports/context.js';
import { commonGitDir } from '../path-layout.js';

/**
 * Build a child `Context` for the linked worktree whose admin dir is
 * `<commonDir>/worktrees/<id>` and whose working tree is `absWorktreePath`. The
 * child's `gitDir` is its admin dir (per-worktree HEAD/index/logs), while
 * `commonDir` stays the shared dir (objects, shared refs, config) — the split
 * `commonGitDir(ctx)` resolves throughout the read layer.
 *
 * `promisor` and `hooks` are dropped: both close over the parent `Context` and
 * would fire against the parent's gitdir if invoked while operating on the child
 * (mirrors `deriveSubmoduleContext`).
 */
export const deriveWorktreeContext = (
  ctx: Context,
  id: string,
  absWorktreePath: string,
): Context => {
  const common = commonGitDir(ctx);
  const gitDir = `${common}/worktrees/${id}`;
  const { promisor: _promisor, hooks: _hooks, ...rest } = ctx;
  return Object.freeze({
    ...rest,
    layout: Object.freeze({
      workDir: absWorktreePath,
      gitDir,
      commonDir: common,
      bare: false,
      ...(ctx.layout.homeDir !== undefined ? { homeDir: ctx.layout.homeDir } : {}),
    }),
    cwd: absWorktreePath,
  });
};
