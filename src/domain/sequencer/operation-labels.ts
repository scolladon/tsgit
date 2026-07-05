/**
 * Git's in-progress sequencer operations and the CLI-flavored labels the commands use
 * when refusing to run concurrently (e.g. "cherry-pick --continue"). Centralized so the
 * operation vocabulary — the union that drives on-disk pending-operation detection and
 * every refusal-message label — has a single home instead of being re-typed per command.
 */

/** Records a merge in progress. */
export const MERGE = 'merge';

/** Records a rebase in progress. */
export const REBASE = 'rebase';

/** Records a cherry-pick in progress. */
export const CHERRY_PICK = 'cherry-pick';

/** Records a revert in progress. */
export const REVERT = 'revert';

/** The pending-operation vocabulary, in marker-detection precedence order. */
export const PENDING_OPERATIONS = [MERGE, REBASE, CHERRY_PICK, REVERT] as const;

/** One of git's mutually-exclusive in-progress sequencer operations. */
export type PendingOperation = (typeof PENDING_OPERATIONS)[number];

/** Refusal label: no merge to abort. */
export const MERGE_ABORT = `${MERGE} --abort`;

/** Refusal label: no cherry-pick to continue. */
export const CHERRY_PICK_CONTINUE = `${CHERRY_PICK} --continue`;

/** Refusal label: no cherry-pick to skip. */
export const CHERRY_PICK_SKIP = `${CHERRY_PICK} --skip`;

/** Refusal label: no cherry-pick to abort. */
export const CHERRY_PICK_ABORT = `${CHERRY_PICK} --abort`;

/** Refusal label: no revert to continue. */
export const REVERT_CONTINUE = `${REVERT} --continue`;

/** Refusal label: no revert to skip. */
export const REVERT_SKIP = `${REVERT} --skip`;

/** Refusal label: no revert to abort. */
export const REVERT_ABORT = `${REVERT} --abort`;
