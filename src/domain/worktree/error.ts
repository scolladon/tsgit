import { TsgitError } from '../error.js';

/** Worktree-tier error codes. */
export type WorktreeError =
  | { readonly code: 'WORKTREE_PATH_EXISTS'; readonly path: string }
  | { readonly code: 'BRANCH_CHECKED_OUT'; readonly branch: string; readonly path: string }
  | { readonly code: 'WORKTREE_LOCKED'; readonly path: string; readonly reason: string }
  | { readonly code: 'WORKTREE_DIRTY'; readonly path: string }
  | { readonly code: 'NOT_A_WORKTREE'; readonly path: string };

/**
 * `add`/`move` refuse a destination directory that already exists and is not
 * empty — git's `fatal: '<path>' already exists`.
 */
export const worktreePathExists = (path: string): TsgitError =>
  new TsgitError({ code: 'WORKTREE_PATH_EXISTS', path });

/**
 * `add` refuses a branch that is already checked out by another worktree —
 * git's `fatal: '<branch>' is already used by worktree at '<path>'`.
 */
export const branchCheckedOut = (branch: string, path: string): TsgitError =>
  new TsgitError({ code: 'BRANCH_CHECKED_OUT', branch, path });

/**
 * `move`/`remove` refuse a locked worktree without force — git's
 * `fatal: cannot move/remove a locked working tree`. `reason` carries the
 * lock's recorded reason (empty when none was given).
 */
export const worktreeLocked = (path: string, reason: string): TsgitError =>
  new TsgitError({ code: 'WORKTREE_LOCKED', path, reason });

/**
 * `remove` refuses a worktree with modified or untracked files without force —
 * git's `fatal: '<path>' contains modified or untracked files, use --force to
 * delete it`.
 */
export const worktreeDirty = (path: string): TsgitError =>
  new TsgitError({ code: 'WORKTREE_DIRTY', path });

/**
 * `move`/`remove` refuse a path that is not a linked worktree — git's
 * `fatal: '<path>' is not a working tree`.
 */
export const notAWorktree = (path: string): TsgitError =>
  new TsgitError({ code: 'NOT_A_WORKTREE', path });
