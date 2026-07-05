/**
 * Builders for git's reflog message lines. Each returns the exact bytes git writes,
 * concentrating the canonical format of every reflog entry in one place so a
 * faithfulness fix is a single-function edit instead of a grep across commands. Pure —
 * no side effects, no I/O.
 */

/** `commit (initial): <subject>` — the root commit's reflog. */
export const commitInitialReflog = (subject: string): string => `commit (initial): ${subject}`;

/** `commit (merge): <subject>` — a merge commit's reflog. */
export const commitMergeReflog = (subject: string): string => `commit (merge): ${subject}`;

/** `commit (cherry-pick): <subject>` — the commit produced by a cherry-pick. */
export const commitCherryPickReflog = (subject: string): string =>
  `commit (cherry-pick): ${subject}`;

/** `commit: <subject>` — an ordinary commit's reflog. */
export const commitReflog = (subject: string): string => `commit: ${subject}`;

/** `branch: Created from <start-point>`. */
export const branchCreatedFrom = (startPoint: string): string =>
  `branch: Created from ${startPoint}`;

/** `branch: renamed <from> to <to>`. */
export const branchRenamed = (from: string, to: string): string =>
  `branch: renamed ${from} to ${to}`;

/** `reset: moving to <target>` — pass `HEAD` for the symbolic-HEAD reset. */
export const resetMovingTo = (target: string): string => `reset: moving to ${target}`;

/** `clone: from <url>`. */
export const cloneFrom = (url: string): string => `clone: from ${url}`;

/** `fetch <remote>: storing head`. */
export const fetchStoringHead = (remote: string): string => `fetch ${remote}: storing head`;

/** `update by push` — the reflog for a ref advanced by a push. */
export const PUSH_UPDATE = 'update by push';

/** `cherry-pick: <subject>` — a cherry-pick step's reflog on HEAD. */
export const cherryPickReflog = (subject: string): string => `cherry-pick: ${subject}`;

/** `revert: <subject>` — a revert step's reflog on HEAD. */
export const revertReflog = (subject: string): string => `revert: ${subject}`;

/** `rebase (start): checkout <onto>` — detaching HEAD onto the rebase base. */
export const rebaseStartCheckout = (onto: string): string => `rebase (start): checkout ${onto}`;

/**
 * `rebase (<action>): <subject>` — the generic form for an interactive-rebase step whose
 * action is only known at runtime. Known-action call sites use the named builders below.
 */
export const rebaseActionReflog = (action: string, subject: string): string =>
  `rebase (${action}): ${subject}`;

/** `rebase (pick): <subject>` — a replayed pick. */
export const rebasePickReflog = (subject: string): string => `rebase (pick): ${subject}`;

/** `rebase (edit): <subject>` — a stopped edit step. */
export const rebaseEditReflog = (subject: string): string => `rebase (edit): ${subject}`;

/** `rebase (reword): <subject>` — a reword step (recorded before and after the amend). */
export const rebaseRewordReflog = (subject: string): string => `rebase (reword): ${subject}`;

/** `rebase (continue): <subject>` — a step replayed after a conflict was resolved. */
export const rebaseContinueReflog = (subject: string): string => `rebase (continue): ${subject}`;

/** `rebase (finish): <branch> onto <onto>` — the finishing move of the branch ref. */
export const rebaseFinishOnto = (branch: string, onto: string): string =>
  `rebase (finish): ${branch} onto ${onto}`;

/** `rebase (finish): returning to <branch>` — reattaching HEAD after a finished rebase. */
export const rebaseFinishReturningTo = (branch: string): string =>
  `rebase (finish): returning to ${branch}`;

/** `rebase (abort): returning to <target>` — reattaching HEAD after an aborted rebase. */
export const rebaseAbortReturningTo = (target: string): string =>
  `rebase (abort): returning to ${target}`;

/** `rebase: fast-forward` — a rebase that reduced to a fast-forward. */
export const REBASE_FAST_FORWARD = 'rebase: fast-forward';
