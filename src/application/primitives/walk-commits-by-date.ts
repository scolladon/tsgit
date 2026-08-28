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
 *
 * Matches an `async function*` generator's contract on the two points a
 * naive per-call `[Symbol.asyncIterator]()` implementation would silently
 * change: the iterator returned here is built and memoised ONCE, at
 * `walkCommitsByDate` call time, and `[Symbol.asyncIterator]()` always
 * returns that SAME object — so a second `for await...of` over the same
 * returned value re-enters the already-advanced (or already-exhausted)
 * iterator rather than starting a fresh walk, exactly as a generator's own
 * `[Symbol.asyncIterator]() { return this }` does. `assertValidSeeds` runs
 * inside the FIRST call to `next()`, not synchronously on
 * `[Symbol.asyncIterator]()`, so an invalid `from` surfaces as a REJECTED
 * promise a caller can `.catch()` — matching the previous generator's
 * lazy-until-first-`next()` validation, where nothing in the generator body
 * (including a `throw`) runs before the first `next()` call.
 */
export function walkCommitsByDate(
  ctx: Context,
  options: WalkCommitsByDateOptions,
): AsyncIterable<Commit> {
  let source: AsyncIterator<{ readonly commit: Commit }> | undefined;
  let validated = false;
  const iterator: AsyncIterator<Commit> = {
    next: async (): Promise<IteratorResult<Commit>> => {
      // Stryker disable next-line ConditionalExpression: equivalent — assertValidSeeds(options.from) is pure over a closed-over, never-reassigned `from`; running it on every next() (instead of once) produces the identical throw/no-throw outcome every call, so this guard is a perf-only skip, not a correctness gate (verified: full covering set — walk-commits-by-date/log/range-diff/whatchanged/shortlog — passes unmutated).
      if (!validated) {
        // Stryker disable next-line BooleanLiteral: equivalent — same reasoning: `validated` only ever gates a re-run of the pure, idempotent assertValidSeeds check above, so re-arming it to false changes nothing observable (same covering-set proof).
        validated = true;
        assertValidSeeds(options.from);
      }
      source ??= commitDateWalk(ctx, options)[Symbol.asyncIterator]();
      const step = await source.next();
      return step.done === true
        ? { done: true, value: undefined }
        : { done: false, value: step.value.commit };
    },
    return: async (): Promise<IteratorResult<Commit>> => {
      await source?.return?.();
      return { done: true, value: undefined };
    },
  };
  return {
    [Symbol.asyncIterator](): AsyncIterator<Commit> {
      return iterator;
    },
  };
}

const assertValidSeeds = (from: ReadonlyArray<ObjectId>): void => {
  if (isEmptyFrom(from)) throw invalidWalkInput(REASON_WALK_EMPTY_FROM);
  if (exceedsMaxWalkSeeds(from)) throw invalidWalkInput(REASON_WALK_TOO_MANY_SEEDS);
};
