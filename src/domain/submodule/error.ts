import { TsgitError } from '../error.js';

/** Submodule-tier error codes. */
export type SubmoduleError =
  | { readonly code: 'RELATIVE_URL_UNRESOLVABLE'; readonly url: string }
  | { readonly code: 'SUBMODULE_HAS_MODIFICATIONS'; readonly path: string }
  | {
      readonly code: 'SUBMODULE_OBJECT_FORMAT_MISMATCH';
      readonly local: string;
      readonly remote: string;
    }
  | { readonly code: 'SUBMODULE_PATH_EXISTS'; readonly path: string };

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

/**
 * `add` refuses a submodule whose hash algorithm differs from the
 * superproject's — a cross-width gitlink oid cannot be written into the
 * superproject's own tree. git's `error: cannot add a submodule of a
 * different hash algorithm`. The clone into the absorbed gitdir has
 * already happened by the time this fires, so the resulting partial
 * `.git/modules/<name>` state is left behind, matching git.
 */
export const submoduleObjectFormatMismatch = (local: string, remote: string): TsgitError =>
  new TsgitError({ code: 'SUBMODULE_OBJECT_FORMAT_MISMATCH', local, remote });

/**
 * `add` refuses when the target path is already tracked in the superproject
 * index (a committed file or an existing submodule) — git's
 * `fatal: '<path>' already exists in the index`. Checked before any clone.
 */
export const submodulePathExists = (path: string): TsgitError =>
  new TsgitError({ code: 'SUBMODULE_PATH_EXISTS', path });
