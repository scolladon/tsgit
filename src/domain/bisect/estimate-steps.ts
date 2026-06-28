/**
 * Verbatim port of git's `estimate_bisect_steps(all)` from bisect.c.
 *
 * Returns the rough number of bisection test rounds remaining for a candidate
 * set of `all` commits. Matches git's `bisect_steps` field in
 * `git rev-list --bisect-vars` output.
 */
export const estimateSteps = (all: number): number => {
  if (all < 3) return 0;
  const n = Math.floor(Math.log2(all));
  const e = 1 << n;
  const x = all - e;
  // equivalent-mutant (e <= 3*x): e = 1<<n is a power of 2; e===3x requires all=4e/3;
  // no power of 2 is divisible by 3, so that boundary is unreachable.
  return e < 3 * x ? n : n - 1;
};
