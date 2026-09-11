/**
 * git `name-rev`'s cutoff (`commit_is_before_cutoff`, `builtin/name-rev.c`):
 * when the target carries a commit-graph generation, the generation test
 * **replaces** the date test — a commit older than every named target (minus
 * a one-day slop) can never be a target and can never improve a name, so the
 * walk prunes it. `nameRevCutoff` is git's `adjust_cutoff_timestamp_for_slop`
 * plus carrying the target's own generation through unchanged.
 */
const CUTOFF_DATE_SLOP = 86_400; // one day, in seconds
const FLOOR = Number.MIN_SAFE_INTEGER;
const GENERATION_INFINITY = Number.POSITIVE_INFINITY;

export interface NameRevCutoff {
  readonly date: number;
  readonly generation: number;
}

const adjustForSlop = (targetDate: number): number => {
  if (targetDate === 0) return 0;
  // Stryker disable next-line EqualityOperator: equivalent — `>` vs `>=` only differs at targetDate === FLOOR + CUTOFF_DATE_SLOP, where the subtract branch also yields FLOOR, so both branches agree at the boundary.
  return targetDate > FLOOR + CUTOFF_DATE_SLOP ? targetDate - CUTOFF_DATE_SLOP : FLOOR;
};

export const nameRevCutoff = (target: {
  readonly committerDate: number;
  readonly generation: number;
}): NameRevCutoff => ({ date: adjustForSlop(target.committerDate), generation: target.generation });

export const commitIsBeforeCutoff = (
  commit: { readonly committerDate: number; readonly generation: number },
  cutoff: NameRevCutoff,
): boolean =>
  cutoff.generation < GENERATION_INFINITY
    ? commit.generation < cutoff.generation
    : commit.committerDate < cutoff.date;
