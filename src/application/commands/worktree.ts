/**
 * `worktree` porcelain — the `repo.worktree.*` nested namespace. Manages linked
 * working trees over one object store: `list` / `add` / `move` / `remove`.
 *
 * Per ADR-249 the results are structured data — `list` returns the per-worktree
 * fields (path, head oid, branch, detached, bare, locked, prunable), never a
 * rendered table. The namespace binder lives in
 * `internal/worktree-namespace.ts`.
 */
import type { Context } from '../../ports/context.js';
import { listWorktrees, type WorktreeEntry } from '../primitives/list-worktrees.js';
import { assertRepository } from './internal/repo-state.js';

export type { WorktreeEntry };

export interface WorktreeListResult {
  readonly entries: ReadonlyArray<WorktreeEntry>;
}

/**
 * List the repository's worktrees (`git worktree list`) — the main worktree
 * first, then each linked worktree sorted by path.
 */
export const worktreeList = async (ctx: Context): Promise<WorktreeListResult> => {
  await assertRepository(ctx);
  return { entries: await listWorktrees(ctx) };
};
