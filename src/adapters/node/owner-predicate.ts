/**
 * The two POSIX facts `ownedByCallerPredicate` needs, isolated behind an
 * interface so the predicate is testable with plain stubs instead of
 * `vi.mock('node:fs/promises')`.
 */
export interface OwnerProbe {
  /** The caller's effective uid; `undefined` on a platform with no POSIX owner model. */
  readonly callerUid: () => number | undefined;
  /** Owner uid of `path`; `undefined` when the path cannot be stat'd. */
  readonly ownerUid: (path: string) => Promise<number | undefined>;
}

/**
 * Builds the `LayoutProbe.isOwnedByCaller` capability from an `OwnerProbe`.
 * `undefined` from either side of the comparison (no owner model, or the
 * path cannot be stat'd) resolves `true` — there is nothing to distrust.
 * Ownership is decided by identity (`===`), never truthiness: uid `0` is an
 * ordinary value on both sides.
 */
export const ownedByCallerPredicate =
  (probe: OwnerProbe) =>
  async (path: string): Promise<boolean> => {
    const caller = probe.callerUid();
    if (caller === undefined) {
      return true;
    }
    const owner = await probe.ownerUid(path);
    return owner === undefined || owner === caller;
  };
