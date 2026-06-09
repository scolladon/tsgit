import type { Context } from '../../../ports/context.js';
import {
  type WorktreeAddOptions,
  type WorktreeAddResult,
  type WorktreeListResult,
  type WorktreeMoveOptions,
  type WorktreeMoveResult,
  type WorktreeRemoveOptions,
  type WorktreeRemoveResult,
  worktreeAdd,
  worktreeList,
  worktreeMove,
  worktreeRemove,
} from '../worktree.js';

/**
 * The nested-namespace surface for `repo.worktree.*`. Each method runs the
 * caller-supplied `guard()` first (so a disposed repository throws before any
 * work) and then forwards to the corresponding context-aware command in
 * `commands/worktree.ts`.
 */
export interface WorktreeNamespace {
  readonly list: () => Promise<WorktreeListResult>;
  readonly add: (opts: WorktreeAddOptions) => Promise<WorktreeAddResult>;
  readonly move: (
    from: string,
    to: string,
    opts?: WorktreeMoveOptions,
  ) => Promise<WorktreeMoveResult>;
  readonly remove: (path: string, opts?: WorktreeRemoveOptions) => Promise<WorktreeRemoveResult>;
}

/**
 * Bind the `repo.worktree.*` nested-namespace dispatcher. `guard()` is the
 * lifecycle gate from `openRepository`; it is invoked before every method
 * forwards to its underlying command. The returned object is frozen.
 */
export const bindWorktreeNamespace = (ctx: Context, guard: () => void): WorktreeNamespace => {
  const ns: WorktreeNamespace = {
    list: () => {
      guard();
      return worktreeList(ctx);
    },
    add: (opts) => {
      guard();
      return worktreeAdd(ctx, opts);
    },
    move: (from, to, opts) => {
      guard();
      return worktreeMove(ctx, from, to, opts);
    },
    remove: (path, opts) => {
      guard();
      return worktreeRemove(ctx, path, opts);
    },
  };
  return Object.freeze(ns);
};
