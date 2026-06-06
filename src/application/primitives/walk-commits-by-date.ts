import { invalidWalkInput } from '../../domain/error.js';
import type { Commit, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { commitDateWalk } from './internal/commit-date-walk.js';
import type { WalkCommitsByDateOptions } from './types.js';
import {
  exceedsMaxWalkSeeds,
  isEmptyFrom,
  REASON_WALK_EMPTY_FROM,
  REASON_WALK_TOO_MANY_SEEDS,
} from './validators.js';

/**
 * Walk every commit reachable from `from` across **all** parents, yielding them
 * in commit-date priority order — newest committer date first, oid-ascending on
 * ties. A thin wrapper over the shared {@link commitDateWalk} core: it owns the
 * public `INVALID_WALK_INPUT` seed contract (empty / too-many seeds) and
 * delegates the all-parents traversal. The core's first-parent variant is
 * internal — no public consumer needs date + first-parent yet (`log` routes
 * `--first-parent` through `walkCommits`'s lazy FIFO).
 */
export async function* walkCommitsByDate(
  ctx: Context,
  options: WalkCommitsByDateOptions,
): AsyncIterable<Commit> {
  assertValidSeeds(options.from);
  yield* commitDateWalk(ctx, options);
}

const assertValidSeeds = (from: ReadonlyArray<ObjectId>): void => {
  if (isEmptyFrom(from)) throw invalidWalkInput(REASON_WALK_EMPTY_FROM);
  if (exceedsMaxWalkSeeds(from)) throw invalidWalkInput(REASON_WALK_TOO_MANY_SEEDS);
};
