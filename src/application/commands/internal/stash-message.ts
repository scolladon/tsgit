/**
 * Pure builders for git's stash subject lines (used verbatim as both the
 * `refs/stash` reflog message and the WIP/index/untracked commit messages).
 * No I/O — the caller supplies the branch label, the abbreviated HEAD oid, and
 * HEAD's subject line. Faithful to `git stash`'s formats:
 *
 *   WIP on <branch>: <abbrev> <subject>        (default save)
 *   On <branch>: <message>                     (custom -m message)
 *   index on <branch>: <abbrev> <subject>      (the index commit)
 *   untracked files on <branch>: <abbrev> <subject>  (the untracked commit)
 */

const HEADS_PREFIX = 'refs/heads/';
const NO_BRANCH = '(no branch)';

/**
 * The branch label for stash messages: the short branch name when HEAD points
 * at a `refs/heads/*` ref, else `(no branch)` (detached HEAD, or a symbolic
 * HEAD that does not target a branch). `branchRef` is HEAD's symbolic target,
 * or `undefined` when HEAD is detached.
 */
export const stashBranchLabel = (branchRef: string | undefined): string =>
  branchRef?.startsWith(HEADS_PREFIX) ? branchRef.slice(HEADS_PREFIX.length) : NO_BRANCH;

export const wipMessage = (branch: string, abbrev: string, subject: string): string =>
  `WIP on ${branch}: ${abbrev} ${subject}`;

export const onMessage = (branch: string, message: string): string => `On ${branch}: ${message}`;

export const indexMessage = (branch: string, abbrev: string, subject: string): string =>
  `index on ${branch}: ${abbrev} ${subject}`;

export const untrackedMessage = (branch: string, abbrev: string, subject: string): string =>
  `untracked files on ${branch}: ${abbrev} ${subject}`;
