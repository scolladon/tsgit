import { TsgitError } from '../error.js';

/** Submodule-tier error codes. */
export type SubmoduleError =
  | { readonly code: 'RELATIVE_URL_UNRESOLVABLE'; readonly url: string }
  | { readonly code: 'SUBMODULE_HAS_MODIFICATIONS'; readonly path: string };

/**
 * A relative submodule URL cannot be resolved because the base URL has no more
 * components to strip — git's `chop_last_dir` `die("cannot strip one component
 * off url '<base>'")`. Reachable only when the base is itself a relative path
 * that gets over-popped; tsgit's callers always resolve against an absolute
 * remote URL or worktree path, so this surfaces only via direct use.
 */
export const relativeUrlUnresolvable = (url: string): TsgitError =>
  new TsgitError({ code: 'RELATIVE_URL_UNRESOLVABLE', url });

/**
 * `deinit` refuses to discard a submodule working tree that has local
 * modifications (modified tracked content or untracked files) without `force` —
 * git's "Submodule work tree '<path>' contains local modifications; use '-f' to
 * discard them".
 */
export const submoduleHasModifications = (path: string): TsgitError =>
  new TsgitError({ code: 'SUBMODULE_HAS_MODIFICATIONS', path });
