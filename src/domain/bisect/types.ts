import type { ObjectId } from '../objects/index.js';

/**
 * One candidate commit in the bisect search space.
 * Parents are already filtered to in-set candidates by the application layer;
 * the domain engine reads no git objects.
 */
export interface BisectCandidate {
  readonly id: ObjectId;
  /** In-set parent ids only (pre-filtered by the caller). */
  readonly parents: ReadonlyArray<ObjectId>;
  /** Committer timestamp — fixes iteration / list order. */
  readonly date: number;
}

/**
 * The pure halving result produced by `findBisection`.
 * `reaches` is the raw weight of the midpoint commit (number of candidates
 * reachable from it, including itself). The application layer derives the
 * public `BisectMidpoint` fields from `reaches` and `candidateCount`.
 */
export interface Bisection {
  readonly nextCommit: ObjectId;
  readonly candidateCount: number;
  /** weight(midpoint) — the load-bearing raw count. */
  readonly reaches: number;
}
