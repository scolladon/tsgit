/**
 * Git's canonical in-progress-operation marker filenames, written directly under the
 * git directory (`.git/MERGE_HEAD`, …). Centralized so the one true spelling of each
 * lives in a single place — every consumer imports the constant instead of re-typing
 * the string, removing the drift risk flagged by the primitive-obsession sweep.
 */

/** Records the tip(s) being merged; present while a merge is in progress. */
export const MERGE_HEAD = 'MERGE_HEAD';

/** Holds the prepared merge commit message. */
export const MERGE_MSG = 'MERGE_MSG';

/** The commit HEAD pointed at before the last history-moving operation. */
export const ORIG_HEAD = 'ORIG_HEAD';

/** Records the commit being cherry-picked; present while a cherry-pick is stopped. */
export const CHERRY_PICK_HEAD = 'CHERRY_PICK_HEAD';

/** Records the commit being reverted; present while a revert is stopped. */
export const REVERT_HEAD = 'REVERT_HEAD';

/** Records the commit being replayed; present while a rebase is stopped. */
export const REBASE_HEAD = 'REBASE_HEAD';

/** Records the refs fetched by the most recent fetch. */
export const FETCH_HEAD = 'FETCH_HEAD';
