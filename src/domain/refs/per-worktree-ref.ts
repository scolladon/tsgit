/**
 * git's per-worktree-ref rule (`is_per_worktree_ref` + the per-worktree
 * pseudoref set). A linked worktree keeps these refs in its own gitdir
 * (`<commonDir>/worktrees/<id>/`); every other ref is shared and lives in the
 * common dir. Pure predicate — no I/O.
 */
import type { RefName } from '../objects/object-id.js';

/** Root pseudorefs git stores per-worktree (each checkout has its own). */
const PER_WORKTREE_PSEUDOREFS: ReadonlySet<string> = new Set([
  'HEAD',
  'ORIG_HEAD',
  'FETCH_HEAD',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_HEAD',
]);

/** Ref namespaces git scopes to a single worktree. */
const PER_WORKTREE_PREFIXES: ReadonlyArray<string> = [
  'refs/bisect/',
  'refs/worktree/',
  'refs/rewritten/',
];

/** True when `name` resolves against a worktree's own gitdir, not the common dir. */
export const isPerWorktreeRef = (name: RefName): boolean =>
  PER_WORKTREE_PSEUDOREFS.has(name) ||
  PER_WORKTREE_PREFIXES.some((prefix) => name.startsWith(prefix));
