import { snapshotRequired } from '../../../domain/error.js';

/**
 * Unwrap a `Promise<T | null>` from a compound-state snapshot factory
 * (`mergeHead`, `cherryPickHead`, `revertHead`, `fetchHead`, `stashEntry`).
 *
 * Calls that require the state to exist (e.g. `abortMerge` when no merge
 * is in progress) use this helper to fail loudly with a `SNAPSHOT_REQUIRED`
 * code carrying the caller's reason. Calls that tolerate absence keep the
 * null-check in their own flow.
 *
 * Example:
 *
 * ```ts
 * const theirs = await requireSnapshot(
 *   repo.snapshot.mergeHead(),
 *   'no merge in progress',
 * );
 * ```
 */
export const requireSnapshot = async <T>(
  promise: Promise<T | null>,
  reason: string,
): Promise<T> => {
  const value = await promise;
  if (value === null) {
    throw snapshotRequired(reason);
  }
  return value;
};
