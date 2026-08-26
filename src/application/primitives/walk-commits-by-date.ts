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
 *
 * Hand-rolls the `AsyncIterable` protocol instead of an `async function*`
 * wrapper: the projection is a single field read (`step.commit`), so a
 * second generator coroutine over `commitDateWalk`'s own would add a second
 * suspend/resume per commit for no work. `next`/`return` are forwarded
 * directly onto `commitDateWalk`'s iterator so an early `break` (`log`'s
 * `limit` cutoff) still closes it, exactly as `for await...of` would.
 * `assertValidSeeds` still fires at the same point relative to iteration —
 * on `[Symbol.asyncIterator]()`, i.e. when a consumer starts iterating, not
 * at call time — matching the previous generator's lazy-until-first-`next()`
 * validation.
 */
export function walkCommitsByDate(
  ctx: Context,
  options: WalkCommitsByDateOptions,
): AsyncIterable<Commit> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Commit> {
      assertValidSeeds(options.from);
      const source = commitDateWalk(ctx, options)[Symbol.asyncIterator]();
      return {
        next: async (): Promise<IteratorResult<Commit>> => {
          const step = await source.next();
          return step.done === true
            ? { done: true, value: undefined }
            : { done: false, value: step.value.commit };
        },
        return: async (): Promise<IteratorResult<Commit>> => {
          await source.return?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

const assertValidSeeds = (from: ReadonlyArray<ObjectId>): void => {
  if (isEmptyFrom(from)) throw invalidWalkInput(REASON_WALK_EMPTY_FROM);
  if (exceedsMaxWalkSeeds(from)) throw invalidWalkInput(REASON_WALK_TOO_MANY_SEEDS);
};
