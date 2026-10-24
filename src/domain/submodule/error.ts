import { TsgitError } from '../error.js';
import type { FilePath } from '../objects/object-id.js';

/** Submodule-tier error codes. */
export type SubmoduleError =
  | { readonly code: 'RELATIVE_URL_UNRESOLVABLE'; readonly url: string }
  | { readonly code: 'SUBMODULE_HAS_MODIFICATIONS'; readonly path: string }
  | {
      readonly code: 'SUBMODULE_OBJECT_FORMAT_MISMATCH';
      readonly local: string;
      readonly remote: string;
    }
  | { readonly code: 'SUBMODULE_PATH_EXISTS'; readonly path: string }
  | {
      readonly code: 'SUBMODULE_PATH_IS_SYMLINK';
      readonly path: FilePath;
      /** The first leading directory of `path` that is a symbolic link, when the leaf itself is not the culprit. */
      readonly component?: FilePath;
    }
  | { readonly code: 'GITMODULES_NOT_STAGED' }
  | { readonly code: 'GITMODULES_UNMERGED' }
  | { readonly code: 'SUBMODULE_NAME_NOT_FOUND'; readonly path: FilePath }
  | { readonly code: 'SUBMODULE_GIT_DIR_NESTED'; readonly name: string; readonly inside: string };

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

/**
 * `status` met a tracked gitlink whose path is a symbolic link while running
 * git's dirty check — git's `fatal: expected submodule path '<path>' not to be
 * a symbolic link` (exit 128).
 */
export const submodulePathIsSymlink = (path: FilePath, component?: FilePath): TsgitError =>
  new TsgitError({
    code: 'SUBMODULE_PATH_IS_SYMLINK',
    path,
    ...(component === undefined ? {} : { component }),
  });

/**
 * `rm` of a submodule refuses when the working `.gitmodules` differs from the
 * index by content — git's `is_staging_gitmodules_ok`: `fatal: please stage
 * your changes to .gitmodules or stash them to proceed` (exit 128), under
 * `--cached` and `-f` too.
 */
export const gitmodulesNotStaged = (): TsgitError =>
  new TsgitError({ code: 'GITMODULES_NOT_STAGED' });

/**
 * `rm` of a submodule refuses to edit a `.gitmodules` the index holds unmerged — git's
 * `remove_path_from_gitmodules`: `fatal: Cannot change unmerged .gitmodules, resolve merge
 * conflicts first` (exit 128), raised after the submodule's directory is gone and before
 * the index is written, as git does.
 */
export const gitmodulesUnmerged = (): TsgitError => new TsgitError({ code: 'GITMODULES_UNMERGED' });

/**
 * Migrating an embedded repository refuses a module name whose leading part already names
 * a repository under `modules/` — git's `validate_submodule_git_dir`: `error: submodule git
 * dir '.git/modules/<name>' is inside git dir '.git/modules/<inside>'` then `fatal: refusing
 * to create/use '.git/modules/<name>' in another submodule's git dir` (exit 128).
 */
export const submoduleGitDirNested = (name: string, inside: string): TsgitError =>
  new TsgitError({ code: 'SUBMODULE_GIT_DIR_NESTED', name, inside });

/**
 * `rm` must migrate an embedded .git directory into .git/modules/<name>, and git
 * takes the name from the .gitmodules section whose `path` matches — it dies
 * `could not lookup name for submodule '<path>'` (exit 128) when there is none.
 */
export const submoduleNameNotFound = (path: FilePath): TsgitError =>
  new TsgitError({ code: 'SUBMODULE_NAME_NOT_FOUND', path });
