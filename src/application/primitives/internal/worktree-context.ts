import type { Context } from '../../../ports/context.js';
import type { FileSystem } from '../../../ports/file-system.js';
import { commonGitDir } from '../path-layout.js';

/**
 * The filesystem to use for worktree-directory I/O: the facade's worktree-fs
 * capability confined to `worktreePath` + the common dir (ADR-298), falling back
 * to the parent fs on sandboxed adapters (memory/browser) that confine worktrees
 * under their root. The single source for routing out-of-workDir worktree I/O.
 */
export const worktreeScopedFs = (
  ctx: Context,
  worktreePath: string | ReadonlyArray<string>,
): FileSystem => ctx.worktreeFs?.(worktreePath) ?? ctx.fs;

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
  const { promisor: _promisor, hooks: _hooks, command: _command, ...rest } = ctx;
  return Object.freeze({
    ...rest,
    // The child reaches both the worktree path (working-tree files) and the
    // common dir (objects/admin); `worktreeFs` confines it to exactly those
    // (ADR-298). Falls back to the parent fs on sandboxed adapters.
    fs: worktreeScopedFs(ctx, absWorktreePath),
    layout: Object.freeze({
      workDir: absWorktreePath,
      gitDir,
      commonDir: common,
      bare: false,
      ...(ctx.layout.homeDir !== undefined ? { homeDir: ctx.layout.homeDir } : {}),
      // The acceptance verdicts are properties of the REPOSITORY, not of the
      // entry point, so they must survive layout derivation: a child that
      // dropped them would read as accepted and re-open the config of a
      // repository the gate refused. Every caller sits behind the acceptance
      // tier today, so this is defence in depth rather than a live fix.
      ...(ctx.layout.untrusted !== undefined ? { untrusted: ctx.layout.untrusted } : {}),
      ...(ctx.layout.implicitBare !== undefined ? { implicitBare: ctx.layout.implicitBare } : {}),
      ...(ctx.layout.foreignPath !== undefined ? { foreignPath: ctx.layout.foreignPath } : {}),
      ...(ctx.layout.formatRefusal !== undefined
        ? { formatRefusal: ctx.layout.formatRefusal }
        : {}),
    }),
    cwd: absWorktreePath,
  });
};
