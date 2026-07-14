/**
 * git `name-rev`'s date cutoff: a commit older than every named target (minus
 * a one-day slop) can never be a target and can never improve a name, so the
 * walk prunes it. `commitIsBeforeCutoff` is git's `commit_is_before_cutoff`
 * date branch (`commit->date < cutoff`) — the generation-number branch does
 * not apply here. `nameRevCutoff` is git's `adjust_cutoff_timestamp_for_slop`.
 */
const CUTOFF_DATE_SLOP = 86_400; // one day, in seconds
const FLOOR = Number.MIN_SAFE_INTEGER;

export const commitIsBeforeCutoff = (commitDate: number, cutoff: number): boolean =>
  commitDate < cutoff;

export const nameRevCutoff = (targetDate: number): number => {
  if (targetDate === 0) return 0;
  // Stryker disable next-line EqualityOperator: equivalent — `>` vs `>=` only differs at targetDate === FLOOR + CUTOFF_DATE_SLOP, where the subtract branch also yields FLOOR, so both branches agree at the boundary.
  return targetDate > FLOOR + CUTOFF_DATE_SLOP ? targetDate - CUTOFF_DATE_SLOP : FLOOR;
};
