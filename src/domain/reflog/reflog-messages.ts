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
