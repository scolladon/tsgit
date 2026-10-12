/**
 * Pure formatters for the pointer files git writes when a linked worktree lives
 * at `<commonDir>/worktrees/<id>/`. Each returns the file's content **without** a
 * trailing newline; the writer appends the `\n`. No I/O.
 */
import type { ObjectId, RefName } from '../objects/object-id.js';

/**
 * `<admin>/commondir` content. The admin dir is always two levels under the
 * common dir (`worktrees/<id>`), so the back-reference is a fixed `../..`.
 */
export const WORKTREE_COMMONDIR = '../..';

/**
 * `<admin>/HEAD` placeholder under a non-files ref backend — git's
 * ref-directory stubs: `is_git_directory` demands a `HEAD` that looks
 * like a ref, while the real HEAD lives in the backend's own storage.
 */
export const PLACEHOLDER_HEAD_STUB = 'ref: refs/heads/.invalid';

/** `<admin>/refs/heads` stub git writes so files-backend readers stop at a regular file. */
export const REFTABLE_REFS_HEADS_STUB = 'this repository uses the reftable format';

/** `<admin>/gitdir` content — the absolute path to the worktree's own `.git` file. */
export const worktreeGitdirPointer = (absWorktreePath: string): string => `${absWorktreePath}/.git`;

/** The worktree's `.git` gitfile content — `gitdir: <absolute admin dir>`. */
export const worktreeGitfile = (absAdminDir: string): string => `gitdir: ${absAdminDir}`;

/** The worktree HEAD to write: a branch symref or a detached oid. */
export type WorktreeHead =
  | { readonly kind: 'branch'; readonly ref: RefName }
  | { readonly kind: 'detached'; readonly oid: ObjectId };

/** `<admin>/HEAD` content — `ref: <branch>` for a branch, the bare oid when detached. */
export const worktreeHeadContent = (head: WorktreeHead): string =>
  head.kind === 'branch' ? `ref: ${head.ref}` : head.oid;
